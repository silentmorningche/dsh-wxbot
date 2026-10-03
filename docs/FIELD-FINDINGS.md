# 实战根因记录（全部实测，非推断）

> 这些是让插件从"完全加载不了"走到"端到端跑通"的**六个具体根因**。
> 每一条都有日志证据，而且**没有一条能从文档里直接读出来**——文档写了 API 的存在，
> 没写这些组合起来会怎样失败。按出现顺序排列。
>
> 环境：Electron 44 / Node 24.18.1、DSH `0.2.0-rc.2`、live profile = `desktop`。
> 证据来源：插件自己写的 `.state/status.json` 叙述链（因为本机 shell 不可用、无处读日志）。

---

## 1. 读未声明的服务属性会让插件**完全无法激活**

**症状**：bundle 装上、Plugins 页面显示 `异常`，但**任何地方都没有错误文字**，`apply()` 从未执行。

**根因**：Cordis 的 context 是 Proxy，`get` 陷阱对**未在 `inject` 中声明的服务属性直接抛错**：

```
Error: cannot get property "webServer" without inject
  at .../src/index.js:158:37
```

可选链 `?.` **拦不住**——抛的是陷阱本身。而我把这句探针写在 `status.set('apply:enter', {...})` 的
**对象字面量**里，所以它在 `status.set` 真正执行**之前**就抛了，于是连状态文件都没生成，
整件事变成完全静默。

**修法**：不要用 `ctx.<service>` 读服务。用 **`ctx.reflect.get(name, false)`**——同一份
Cordis 源码（`vendor/cordis/src/reflect.ts`）里它的文档注释是：

> Read a service from the store **without the inject requirement**.

**为什么不用 `inject`**：`inject` 里写了但**不存在**的服务名会让这个条目**永远等待**。
而服务名无法从外部确认（`webServer` 还是 `webserver`、`agents` 还是 `agent`）。
探测多个候选名、拿到哪个算哪个，严格更安全。

**附带教训**：**诊断代码本身会成为故障源。** 这一条和下面第 5 条都是我自己加的观测代码造成的。

---

## 2. 宿主包只在 profile 目录树**内部**可解析

**症状**：模块能被 Node 干净导入（`IMPORT OK`），但在 DSH 里静默失效。

**根因**：`$DSH_HOME/profiles/node_modules` 那张运行时解析表**只对 profile 子树内的导入者生效**。
用补丁把一个 profile **之外**的绝对路径挂上去，模块本身能加载，但它一
`import '@deepseek-ai/dsh-llm'` 就失败 → 整个模块导入失败 → 插件被跳过。

**关键细节**：安装用的是 `link:`（符号链接），而 **Node 默认把符号链接解析成真实路径**，
于是导入者的真实位置仍在 profile 之外。官方文档提到 "Linked directories … admits its importers
to peer-aware ancestor lookup"，但**没有解决符号链接指向真实路径这条**。

**修法（插件里）**：动态 import 失败后，改用**锚在 profile 里的 `createRequire`** 再解析一次。
`process.cwd()` 就是 profile 目录（实测 `C:\Users\<user>\.dsh\profiles\desktop`），
所以这个锚点是可靠的。失败时会写明**是哪条路成功的**：

```
resolved @deepseek-ai/dsh-llm via profile-anchored resolution
  -> ...\app.asar\dsh\node_modules\@deepseek-ai\dsh-llm\lib\index.js
```

---

## 3. `getAccount()` 只读内存 → 恢复分支**永远不可达**

**症状**：重启后不去恢复已有会话，而是**重新拉一张二维码等你扫**。微信端表现为
**「暂无法连接 Open Claw」**（bot 离线）。

**根因**：`ILinkClient` 的 `getAccount()` 读的是**内存**；新进程里构造函数刚跑完，内存当然是空的。
所以这段代码的 `else` 分支永远不会执行：

```js
if (!client.getAccount()) { 走登录 }
else { await client.setAccountById(account.ilink_bot_id) }   // ← 死代码
```

**修法**：**先恢复，再判断**：

```js
let account = client.getAccount()
if (!account) {
  const ids = await client.listLocalAccountIds()      // 从磁盘找已存账号
  if (ids.length > 0) account = await client.setAccountById(ids[0])
}
```

---

## 4. `create()` 拒绝已存在的会话，而 `resume()` 需要载入的事件日志

**症状**：重启后每条消息都失败：

```
SessionAlreadyExistsError: session "weixin:…" already exists
```

**根因**：`@deepseek-ai/dsh-agent` 的两个门语义不同——

| 方法 | 语义 |
|---|---|
| `ctx.agents.create()` | 建**全新**的 agent 和会话 |
| `ctx.agents.resume()` | **载入已持久化的会话并在其上重建 agent** |
| `get(id)` / `list()` | 只找**活着的** agent |

会话是持久化的，所以重启后 `get()`（只看活的）返回空；`create()`（只收全新的）抛
`SessionAlreadyExistsError`。**两个门都不通。**

**而 `resume({ sessionId })` 会抛 `TypeError: Cannot read properties of undefined (reading 'length')`。**

### 真正的根因 —— 只是一个字段名

`ResumeAgentOptions` 的字段叫 **`resumeSessionId`**，不是 `sessionId`：

```ts
// @deepseek-ai/dsh-agent
interface ResumeAgentOptions {
  resumeSessionId: SessionId      // ← 不是 `sessionId`
  parentAgent?: Agent
  agentOptions?: AgentOptions
  signal?: AbortSignal
  setup?: AgentSetup
}
```

传错名字时 `resumeSessionId` 是 `undefined`，内部读它的属性就炸出那句 TypeError——
而**那个错误信息既没提选项名，也没提拼写**。我因此误判过一次，以为是"它需要调用方先载入持久化的事件日志"。

**正确修法**：

```js
const resumeOptions = { resumeSessionId: actualId }
if (this.#agentOptions) resumeOptions.agentOptions = this.#agentOptions
const resumed = unwrap(await agents.resume(resumeOptions))
```

最终顺序：`get()`（活着的）→ `create()`（全新的）→ 失败则 **`resume({ resumeSessionId })`**
→ 派生 id 建新会话（现在只是最后兜底）。

**验证方式（很硬）**：修复后重启 DSH，回合编号**接着上次往下走**（`turn 3/4/5`，而不是重新从 1 开始）；
而且重启后追问之前说过的事，回答仍然正确。

---

## 5. 程序化创建的会话必须**显式传模型**，否则回合静默空转

**症状**（最难查的一个）：回合**跑起来了**，但既没有 `user/message` 也没有 `assistant/message`：

```
turn/start → step/start → step/end → turn/end
```

微信端看到的是「正在输入」闪一下然后没动静。**没有任何异常外抛。**

**根因**：`turn/end` 的 `reason` 里带着错误：

```json
{"kind":"error",
 "error":{"message":"prompt variable \"{{model}}\" has no value for this assembly (section…"}}
```

**系统提示词模板引用了 `{{model}}`，而会话没有模型 → 装配失败 → 回合在发起模型调用之前就死了。**

而 profile 里的 `agent-default-model` 条目（本机配的是 `provider: deepseek-official` /
`model: deepseek-flash` / `reasoningEffort: high`）**不覆盖程序化 `create()` 出来的会话**。

**修法**：创建时显式传 `agentOptions`（已做成配置项 `agentProvider` / `agentModel` /
`reasoningEffort`，默认值照抄 profile）。

**两个教训**：
- **DSH 会把失败的回合报成"成功的空回合"**——`reason.kind === 'error'` 但没有 `assistant/*`
  事件、没有异常。外部无法区分"agent 没话说"和"装配失败"。
- **`Error.message` 是非枚举属性**，用 `Object.entries` 遍历错误对象会得到 `{}`。
  我的诊断代码第一次把嵌套对象压成键名列表、第二次没特判 `Error`，
  **两次都把这条错误信息盖掉了**。

---

## 6. `whenIdle()` 在 `followup()` 之后**立刻**返回

**症状**：`settled by agent-idle; reply length=0`，仅 203 毫秒。

**根因**：`followup()` 返回时，**agent 还是 idle**——活儿还没开始跑。把它当区间兜底，
它当场就 resolve，区间在产生任何输出之前就被关掉。官方文档点名警告过：

> **Never treat `agent/status` or `whenIdle()` as the result of one follow-up.**

**修法**：**idle 只在"该会话已产生过至少一个事件"之后才被采纳**；区间主要由 `turn/end` 收尾。
另外加一道 30 秒的 `no-events-matched` 兜底，避免"事件一个都没匹配上"时让用户干等 5 分钟。

---

## 7. 会话的创建元数据**事后不可改**，改了只能换 id

**症状**：连续性修好之后，回复又没了——但错误变了：

```
turn/end reason.error.message:
  prompt variable "{{cwd}}" has no value for this assembly
```

上一轮是 `{{model}}`，这一轮是 `{{cwd}}`。**同一个症状，换了个变量。**

**根因**：那个被 `resume` 的会话是**在 `meta.cwd` 接上之前**创建的，它持久化的元数据里没有 cwd。
而 `ResumeAgentOptions` **没有 `meta`**——一个已存在会话的 cwd 与模型**无法事后补上**。
于是 `create` 拒绝它、`resume` 能载入但没有 cwd → 提示词装配失败 → 回合空转。

**修法**：**把会话 id 版本化一次**（`weixin:…` → `weixin:v2:…`）。
第一条消息用一个全新 id 创建（带上正确的 cwd + 模型），此后再 `resume` 就都能接上历史。
代价是**丢掉当时那段对话**，所以这是一次**显式、带注释的迁移**，而不是随手改个字符串。

**教训**：凡是"只在会话首次创建时生效"的元数据，都必须在第一次就传对——**改动它等于换一个会话身份**。
这种耦合应该写在代码注释里，否则下一个改配置的人会以完全相同的方式静默踩坑：
**没有异常、没有 assistant 事件，外部只看到"agent 没说话"。**

---

## 8. 图片必须作为 **`ImageBlock`** 进请求 —— 发路径等于没发

**症状**：媒体下载、解密、落盘、元数据全部正确，agent 也准确复述了文件名、字节数和 mime，
然后说：**"我拿不到这张图片的内容。"** 换 Word 文档也一样。

**它当时的诊断是准确的，而且比我更准**：

> 本次会话暴露给我的工具只有「环境依赖查询」这一个……**模型侧也没有收到图片内容块**

### 第一层：工具集（真的缺）

`agents.create()` 不套用 profile 的 `agent-preset-registry` 默认值（`default: standard`），
所以会话**几乎拿不到工具**。修法是显式传 `meta.agentPreset`——**和 `agent-default-model` 完全同形**：
"profile 里配好的默认值不覆盖程序化创建的会话"。详见第 7 条，这是它第二次被踩。

### 第二层：图片的投递方式（**这一层是我判断错了**）

DSH 的附件文档早就写明了：

> 只有支持图片的模型会把持久 `ImageBlock` 引用转换为路由专用请求版本；**纯文本模型接收稳定占位符**。

**也就是说 DSH 本来就会把图片真正送进模型。** 而我选择发**一行文件路径**，还把它评价为
"够用、`ImageBlock` 只是增强"。

**那个评价是错的，而且不是信息不足造成的——信息当时就在手上。**
"让 agent **知道**收到了文件"和"让 agent **看见**图片"是两件不同的事，我把前者当成了后者。

### 正确的做法

```js
// ctx.attachments —— 服务名、方法名、输入输出形状全部逐行核实自源码
const admitted = await attachments.admitPromptContent([
  { type: 'text',  text },
  { type: 'image', data: bytes.toString('base64'), mediaType: 'image/jpeg', name },
])
// → [ { type:'text', text }, { type:'image', attachment: <ImageAttachmentRef> } ]
```

三条从源码里读出来的硬约束：

1. **`data` 必须是规范 base64**。`decodeCanonicalBase64` 会"解码后重编码再逐字符比对"，
   不一致就抛 `INVALID_IMAGE_BASE64`。Node 的 `Buffer.toString('base64')` 恰好规范，但不能带换行。
2. **入册失败 = 整条消息失败**（"如果任何一张图片被拒绝，整条消息都会失败且不会发布任何内容"）
   ——**比退化成路径更糟**。所以必须包起来，失败就退回文本。
3. **文件不该走这条路**：`FileBlock` 永远不会到达适配器，协议对文件的约定本来就是
   "一行指出只读路径的句柄文本"。**所以文件和图片是分工，不是二选一**——
   我最初"全都发路径"错在把图片也归进了文件那一类。

### 教训（这才是重点）

**这个 bug 的形状是"信息在手、判断出错"，不是"未知太多"。**
我在动手前已经读过那条 `ImageBlock` 规则，却没让它改变设计。

**防线**：文档里出现"两种模型行为不同"这类规则时，它描述的是**投递路径的差异**，
不是一个可以两边都糊过去的细节。读到这种规则，就该回去检查
**"我到底把东西交给模型了吗"**，而不是"agent 知道这件事了吗"。

**验证方式（很硬）**：让模型描述图片内容。它说出**像素级的事实**（尺寸、配色、笔触、暗角）才算通；
只说得出文件名和字节数就是没通。**这两种回复长得都像"正常回答"**，区别全在内容里。

---

## 9. **我写的指令本身制造了那个行为**

**症状**：用户只让它发一个文件，它回了一整段：解释那条内部标记怎么工作、把路径复述一遍、
罗列"可能失败的原因"，还让用户"把文件挪到工作区里"。

**这不是它笨——是我的措辞给了它一个话题。**

我当时写的提示词是：

> ……**插件会把这一行从回复中移除**，并把该文件作为附件发给用户。

我以为在交代行为，实际上**把机制当成了一个可以谈论的对象交给了它**。而它转述得完全忠实。
这和前面八条都不同：**前八条是接口、时序或平台边界，这一条是我自己的文字造出来的。**

### 三个版本，一次只改一个变量

| 版本 | 内容 | 回复 |
|---|---|---|
| 一 | 讲机制（"插件会把这一行移除"） | 一整段内部机制 + 失败原因 + 让用户挪文件 |
| 二 | 第三人称陈述机制 + **三条明确禁止** | 干净一句话："好的，文件已随本条消息发出，请查收。" |
| 三 | **只有那两句陈述**（禁止全删） | ——用来分辨"禁止"到底有没有在起作用 |

**二版的结果不能证明那三条禁止在起作用**——很可能"把机制当陈述而不是话题"本身就够了。
所以三版是刻意留的实验。**如果三版依然干净，那三条禁止就是多余的；如果退化，才加回来。**

### 教训

1. **描述一个机制 = 邀请模型去叙述那个机制。** 要它做一件事，就说那件事，不要解释背后的实现。
2. **叫它别猜还不够，得让知道原因的那一方去说。** 否则就是"知道的人不说、不知道的人不能说"——
   插件明明知道上传失败在哪一层，却让一个没有任何工具、无法验证任何东西的模型去解释结果。
   **配套改动**：失败时由插件自己发一条 `（附件发送失败：…）`。
3. **提示词的每一句都在每一轮被计费。** 第一版约 250 字符，最终版 89 字符——
   而**更短的那版效果更好**，因为长的那版把注意力引到了不该它管的事情上。

---

## 10. **接线正确，但条件被上游保证为假**

**症状**：连着发两条消息，第二条总是等第一条跑完才处理——看起来像"排队"，而代码里明明写了
"正在跑就插话"。

**我改了三处，一处都没生效：**

| 改动 | 结果 |
|---|---|
| 端口里加 `agent.status === 'running'` → `steer()` | 分支**从未执行** |
| bridge 里消费哨兵，区分"刻意静默"与"失败静默" | 从未到达 |
| 绕开 `#enqueue` 那道串行闸门 | 从未放行 |

**每一处都写对了。它们全在一个条件已经为假的机制下游。**

真正的闸门在**拉取循环**：

```js
// ilink-client.js
for (const msg of outcome.msgs) {
  await options.onMessage(msg, this);   // ← 阻塞：整轮 agent 跑完才继续取下一批
}
```

于是第二条消息**一直躺在服务端**，等第一轮结束才被取下来。取下来时 `#chains` 里当然什么都没有，
`agent.status` 当然是 `'idle'`。

**用户的观察是决定性的**：「上一条**一停**，下一条**立刻**发」。
**"一停"两个字就是证据**——它说明第二条是在第一轮**结束之后**才进入处理的，而这只能由上游阻塞
造成。**我的仪器量不到"消息何时到达服务端"这一层**，日志里只有"处理何时开始"。

### 教训

1. **"看起来像 X" 不是 "X 发生了"。** 我拿"排队"这个**观感**当成"闸门没放行"的**证据**，
   然后一路往下改了三轮——**一条没有被观测到的症状不是缺陷报告**。
2. **修之前先问："这个条件有可能在我要观测的那一刻为真吗？"** 只要上游存在一条串行路径，
   答案就是不能。
3. **观测点要放在最外圈。** 我加的三条日志全在新分支**内部**，于是"没有日志"同时意味着
   "代码没加载"和"代码跑了但没插话"——**一个我无法判读的仪器**。最后起作用的是那条放在分支
   **之外**、每条消息都写的 `inbound arrival { inFlight }`；**它本该是第一个加的，而不是第四个。**
4. **选观测点前先问"它有没有可能给出错误答案"。** 这一轮我另外还错了三次：正则匹配不到带括号
   的 `(reply).steered`、`indexOf` 返回 `-1` 让"顺序正确"**无条件通过**、用 `apply:enter` 的条数
   判断是否重启（**trail 有上限，旧条目会被淘汰**）。**四次检查，四次都不可靠。**
5. **异步循环里不要 `await` 消息处理器。** 处理器会跑一整轮，`await` 它等于让"取下一批"排在
   "跑完这一轮"后面——**串行化发生在你没想到的那一层**。要 `runDetached` 接管拒绝
   （宿主里游离的未处理拒绝是致命的）。

---

## 11. `agent.steer()` **不产生回合** —— 而"取消换新"可以

**症状**：用户在 agent 正在跑的时候发第二条消息，**第二条的回答永远收不到**。

**先试的路（`steer`）**：判定 `agent.status === 'running'` 后调 `agent.steer(message)`。日志证据：

```
agent:info   steered into the running turn on weixin:v1:…    ← 调用成功、无异常
之后 30 秒内 160 次空闲探测：events 数【一动不动】            ← 没有任何新会话事件
最终 settled by agent-idle-after-activity; reply length=0    ← 带走的只有插话【之前】的文本
```

**插话内容进了收件箱，却没有产生任何可观察的工作**——没有新回合、没有 assistant 消息。
（GUI 里 `mode: 'steer'` 走的是 `session-controller`，裸 alias 的 `target`/`wakeup` 组合**可能不唤醒循环**；
这只是候选解释，**我没有定论**。）

**改用的路（cancel + 重新提问）**，只用已验证的原语：

1. `agent.cancel({ kind: 'user' })` —— 接口声明里有（`AgentCancelCause` 含 `{kind:'user'}`）
2. `await agent.whenIdle()` —— 等它真停下
3. **收尾并静默被中断的那一轮** —— 否则它要等满 5 分钟超时，并回一条**假的**"没有产生回复内容"
4. 正常 `followup` 第二条 —— 第一条已在会话历史里，**一轮回答两件事**

### 教训

1. **`steer` 的失败无法从"我的记账"里修好。** 它不是我把书签记错了，而是**平台没有按我以为的方式工作**。
   我为它改了三轮代码，**每一轮都在动我自己的逻辑——而那些逻辑本来就不是问题所在**。
2. **顺序与唯一性比逻辑更容易出错。** 这一轮四次事故（三次真的被我写出来）：

   | 事故 | 后果 |
   |---|---|
   | 收尾逻辑放在等待器注册**之后** | 收尾的是**自己刚注册的**等待器 → 第二条被短路成静默 |
   | 注册处"防覆盖"（当初为 steer 加的） | 挡住**正当**的替换 → 新回合的文字无人收集 |
   | `finally` 里**无条件**删等待器 | 删掉**替换者**的等待器（同一个错的**清理方向**） |
   | bridge 少了哨兵消费 | 被打断的那轮**误报**为"没有产生回复内容" |

   **这些都不是逻辑错，是"我在动哪个对象、按什么次序"的错**——而它们**只有把行号排出来才看得见**。
3. **用已经见过它工作的原语。** `cancel`/`whenIdle` 在接口声明里，且 `whenIdle` 的行为早先被观测过；
   而 `steer` 我从未观测过。**"接口上有"不等于"语义是你以为的那样"。**
4. **每次改完核对"顺序 + 唯一性 + 两端成对"**，而不是核对"那段文字在不在"。
   这一轮四次事故**全部**是这三类检查抓回来的——**没有一次是靠读代码看出来的**。

---

## 附：这套代码里值得复用的做法

- **`status.json` 叙述链**：在没有 shell、读不到应用日志的环境里，让插件把每一步
  （phase + detail）写成一个原子更新的 JSON 文件。**这是整个调试过程里唯一稳定的观测通道**，
  六条根因里有五条是靠它定位的。
- **绝不静默降级**：每一处"回退/兜底"都写一条日志说明**触发了什么、代价是什么**。
- **`runDetached()`**：任何不被 await 的 Promise 都包一层 catch——DSH 对游离的
  unhandled rejection 是**致命**的（销毁整个应用）。
- **不要重复实现协议状态**：我一开始另写了 `store.js` 管持久化、`redact.js` 管脱敏，
  后来发现 `ilink-client.js` 本来就拥有这两者。**重复的游标状态会静默丢消息，重复的脱敏逻辑分叉后会泄密**。
  两个文件都废弃了。
