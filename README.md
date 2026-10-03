# dsh-wxbot

## ⚠️ 免责声明与合规提示

**一句话**：本项目是非官方、未获授权的第三方实现；用它可能违反微信服务协议并导致封号；
风险由你自负；请勿用于违法、骚扰、高频滥用，或未经备案的公众生成式 AI 服务。

📄 **使用前请务必阅读完整版：[docs/DISCLAIMER.md](docs/DISCLAIMER.md)**
（十二节：非关联声明 · 知识产权与通知—删除 · 使用风险自负 · 禁止用途 · 数据与个人信息 ·
生成式 AI 与深度合成 · 无担保 · 责任限制与赔偿 · 与 MIT 许可证的关系 · 二次分发 ·
漏洞与安全 · 其他）

把**微信 ClawBot** 接进 **DeepSeek Harness (DSH)**：在微信里给机器人发消息，消息驱动一个 DSH 会话，回复再发回微信。

---

## 这个插件到底在做什么

微信 ClawBot 是腾讯官方给 [OpenClaw](https://github.com/openclaw/openclaw) 做的微信渠道插件（包名 `@tencent-weixin/openclaw-weixin`）。腾讯把它连同**一份协议文档**一起 MIT 开源了，而那份文档明确写着它**是给"实现或集成兼容后端"的开发者用的**：

> This document describes the HTTP JSON protocol used by the `openclaw-weixin` channel plugin. It is intended for developers implementing or integrating a compatible Weixin backend.
> — [docs/protocol.md](https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/docs/protocol.md)

所以本插件不复用 OpenClaw，而是**直接实现这份 iLink HTTP/JSON 协议**，作为一个 DSH 渠道插件：

```
微信 App ──扫码登录 / getupdates 长轮询 / sendmessage──> ilinkai.weixin.qq.com
                                                              ▲
                                                              │ iLink HTTP/JSON
                                                              ▼
                                        ┌───────────────────────────────────┐
                                        │  dsh-wxbot         │
                                        │  （Cordis 插件，跑在 DSH 进程内）   │
                                        └──────────────┬────────────────────┘
                                                       │ ctx.agents.get(...).followup(...)
                                                       │ ctx.on('session/event', ...)
                                                       ▼
                                              DSH 会话 + agent loop
```

**第一版只处理文本消息。** 图片 / 语音 / 文件 / 视频需要额外的 AES-128-ECB 加解密和 CDN 上传下载，协议文档里有完整描述，留作后续扩展。

---

## 当前状态

> ✅ **已实测跑通端到端，并且对话可跨重启延续。** 在微信里发一句「你好」，收到了 DSH agent 的
> 真实回复——而且是**同一个工作区里的一个真实 DSH 会话**，不是另一个平行 agent。
>
> 实测链路：扫码登录 → `getupdates` 长轮询收到消息 → 分类/去重/会话映射 → `agents.create()`
> 建会话 → `followup()` 投递 → 模型回合 → `assistant/message` → 提取文本 → `sendmessage` 发回微信。
> **重启 DSH 后再问之前说过的事，回答仍然正确**（`agents.resume({ resumeSessionId })` 接上了历史）。
>
> 实测环境：Electron 44 / Node 24.18.1、DSH **`0.2.0-rc.2`**、live profile 是 **`desktop`**
> （不是 `web`）、**热重载是活的**。
>
> ⚠️ **仍存在的限制**（证据见 [FIELD-FINDINGS.md](docs/FIELD-FINDINGS.md)）：
>
> - **HTTP 登录页不可用**（`/wechat/qr` 返回 404）。成因已查实：提供路由的是
>   `@deepseek-ai/dsh-host-webserver` 的 **`ctx.webServer`**（`register(route)` / `registerUpgrade` /
>   `registerFallback`），但**该名字未能从插件里解析到**；而那个包的文档明确写着 **Electron 窗口用
>   `file://` 加载 dist、fetch 走 IPC**，只有浏览器访问才经过 HTTP——**所以即便路由注册成功，桌面窗口里
>   也看不到它**。**替代方案（已实现）**：登录链接写进**工作区根目录**的 `wechat-login.txt`（GUI 本来
>   就展示工作区，不必去 `.state/` 里翻），配对码写同目录的 `wechat-verify-code.txt`；`openLoginUrl`
>   打开时还会自动把登录链接交给默认浏览器。`.state/verify-code.txt` 仍被接受，旧习惯不会失效。
> - **媒体**：**图片双向可用**——经 `ctx.attachments.admitPromptContent()` 变成 `ImageBlock`，模型直接
>   拿到像素（实测：模型能说出尺寸、配色、笔触细节）。**语音**用 `voice_item.text` 的转写文本；
>   **文件与视频**以"只读路径 + 元数据"的文本交付（协议对文件的约定本就如此），**需要文件工具才能读**,
>   而工具集问题尚未解决（见下）。落盘在**工作区**的 `.wechat-media/`，单文件上限 **100 MiB**。
>   **不支持群聊**（官方实现同样如此）。
> - **会话的创建元数据事后不可改。** `meta`（`cwd`、`agentPreset`）是持久数据，而 `resume()` 不接受
>   `meta`，所以这些值必须在会话**首次创建**时就给对；日后要改只能**把会话 id 版本化一次**
>   （当前是 `weixin:v5:…`），代价是丢掉当时那段对话。详见 FIELD-FINDINGS 第 7 条。
>   ⚠️ 但 **`setup` 不受这条限制**——`resume()` 也接受它，所以"给会话补上工具"这类改动能用在
>   **已有**会话上。v5 就是这样升级的，**没有作废对话**。
> - ✅ **工具集：曾经以为拿不到，其实拿得到。** `agents.create()` 不套用 profile 的
>   `agent-preset-registry` 默认值，而**预设注册表从插件里够不到**，所以会话一度只暴露一个工具。
>   真正的入口是 **`CreateAgentOptions.setup`**——契约原文写着经 `agentCtx` 注册的 **scoped tools**
>   存在于第一次提示词组装之前，而且它**就是给插件用的钩子**。插件现在经它挂载
>   `@deepseek-ai/dsh-tool-fs` + `@deepseek-ai/dsh-tool-pwsh`／`tool-bash`（**实测成功**：
>   `mounted … into this session scope`）。每个挂载**单独 try/catch**——契约规定 `setup` 抛错会
>   **回滚整个会话创建**，一个工具装不上不能把整条通道拖下水。
> - ⚠️ **授权请求在微信里看不见（未解决，按"安全优先"搁置）。** 工具挂上之后会话会真的做需要授权
>   的事，而 DSH 的审批是给**有界面**的会话设计的。事件是 **`approval/request`**
>   （属 `@deepseek-ai/dsh-user-approval`）；计划是经 `setup` 的 `agentCtx` 挂一个**总是拒绝**的监听器
>   并同时发消息告知。但**要先读清它的契约**（waterfall 还是返回值、拒绝的取值形状）——
>   审批是安全边界，"以为会拒绝、其实放过了"比没有监听器更糟。**目前只能在 DSH 里手动批准。**
> - **失败时会发一条消息。** 两条静默路径（agent 没产生文本、以及内部异常）现在都会回一条
>   `（没有产生回复内容）`／`（处理失败）`——在此之前用户分不清"停下了"和"还在跑"。
> - **会话在 GUI 里落在「未分组」，不在工作区下面。** 宿主侧的 `ctx.workspaceRegistry` 在这个 profile
>   里**没有挂载**（实测探测 12 个候选名，只有 `agents` / `logger` / `sessions` 能解析到），所以文档
>   里的 `workspace.attachSession()` 这条路走不通。而 GUI 的工作区列表既然不来自这个服务，就只能是
>   **客户端侧**的——**免构建的服务端插件无法影响它**。插件保留了挂载代码：该服务将来一旦挂载，就会
>   自动生效，无需改代码。
>
> **本机开发环境的限制（已解决，留档）**：开发机的 `D:\...\deepseek-harness` 及其下的工作区**曾属于
> Administrators 组**，当前账号没有"修改该目录权限"的权利，因此 DSH 无法为它授予沙箱写入权，
> **任何受限进程（`pwsh` 等）都无法启动**——agent 反复重试 **12 次全部失败**（同一个
> `SetNamedSecurityInfoW failed … grantWrite(<工作区>)`），开发过程中也长期跑不了 `node`，
> 验证只能依赖插件自己写的 `status.json` 叙述链。
> **已用一条提权命令解决**：`icacls "D:\...\deepseek-harness" /grant "<账号>:(OI)(CI)F" /T`。
> 之后实测：**工作区内可写、工作区外与 `C:\Windows` 均被拒绝、受限进程正常启动**。
> ⚠️ 值得记住的是**这个限制有两个受害者——插件的 agent 和我自己的 shell**，而根因在 DSH 之外。
> 诊断报告见 `.acl-recovery/`。
>
> **打断换新**：正在跑的时候发第二条，**前一轮会被取消，新一轮同时回应两件事**。做法是
> `agent.cancel({ kind: 'user' })` → `await agent.whenIdle()` → **收尾并静默被中断的那一轮** →
> 正常 `followup` 第二条（第一条已在会话历史里，所以一轮回答两件事）。每条入站消息都会留一条
> `inbound arrival { inFlight }`，**`inFlight: true` 是这条链路的总开关**。
> ⚠️ 代价：**前一轮已产出的内容作废**（这正是"打断"的含义）；被取消的那一轮**保持静默**，
> 不会回一条"没有产生回复内容"。
> ⚠️ 历史：这里曾尝试 `agent.steer()`，**实测它不产生任何回合**（事件数一动不动）⇒ 第二条的回答
> 无处可收、彻底丢失。改用 `cancel` + 重新提问，**只用已验证可用的原语**。详见 FIELD-FINDINGS 第 11 条。

| 部分 | 文件 | 状态 |
|---|---|---|
| iLink 协议客户端 | `src/ilink-client.js` | ✅ 实测：扫码、长轮询、发消息、typing 全部工作 |
| 消息编排（分类/去重/串行/分片） | `src/bridge.js` | ✅ 实测工作 |
| DSH 会话适配（回复区间） | `src/dsh-agent-port.js` | ✅ 实测工作。区间由 `turn/end` 收尾；`whenIdle()` 必须等该会话有活动才采纳 |
| 插件主干与配置 | `src/index.js` | ✅ 实测加载并运行；**不含任何 eager 宿主 import** |
| 二维码处理 | `src/qr.js` | ✅ 实测：腾讯返回的是链接而非图片，链接已保留并写入 `status.json` |
| bundle 补丁 | `cordis.patch.yml` | ✅ 实测生效（profile 是 `desktop`，热重载是活的） |
| 一次性清理 | `cleanup.ps1` | 删除开发期产生的废弃会话与脚手架。**默认只预览，加 `-Apply` 才真删** |

> **已删除的脚手架**（保留这段记述代替文件本身）：`verify/load-probe.js`——那次搞崩 live profile
> 的探针；`src/store.js` 与 `src/redact.js`——与 `ilink-client.js` 的持久化/脱敏重复
> （重复的游标状态会**静默丢消息**，重复的脱敏逻辑分叉后会**泄密且无报错**）；`check.mjs` /
> `check.cmd` / `check-profile.mjs` / `check-profile.cmd`——shell 不可用期间的模块加载自检脚本；
> `docs/SYNTAX-AUDIT-part*.md` 与 `docs/_scan_part1.py`——临时审查记录。
> 执行 `cleanup.ps1 -Apply` 完成删除。

> **配置不再有 schema。** `src/index.js` 不导出 `Config`——那需要一个 eager 宿主 import，
> 而它已被证明能让插件静默失效。改为导出 `configDefaults`，并在 `apply()` 里用
> `normalizeConfig()` 校验：未知键给警告，非法值回落到默认值，**两者都不会阻止插件加载**。
> 代价是 Web 设置页不会为这些字段生成表单。

---

## 前置条件

- 一部 **iOS 微信 8.0.70 及以上**的手机（ClawBot 入口在「我 → 设置 → 插件」）。
- 一个可用的 DSH profile。**本机实测 Electron 桌面版用的是 `desktop` profile**
  （`$DSH_HOME/profiles/desktop`，本机即 `C:\Users\<user>\.dsh\profiles\desktop`），
  而不是 `web`——装错 profile 会表现为"装上了但什么也没发生"。
- 本插件**不需要**安装 OpenClaw，也**不需要**系统里的 Node.js。

---

## 安装

**推荐方式：Web 界面的 Plugins 页面。** 侧边栏的 **Plugins** 页面管理当前 profile 的 bundle
与插件行，安装时接受**本机绝对路径**（它会去读该路径下的 `package.json`），所以本插件不必先
发布到 npm。把本目录的绝对路径填进去即可：

```
<workspace>\dsh-wxbot
```

命令行等价写法（需要 shell）：

```sh
dsh plugin --profile desktop add "<workspace>\dsh-wxbot"
```

> **profile 名字要选对。** 本机实测：Electron 桌面版实际使用的是 **`desktop`** profile
> （用运行中进程的 `process.cwd()` 确认过，不是推断），而不是 `web`。装错 profile 的症状是
> "装上了但什么也没发生"。证据见 `docs/LOAD-TEST-FINDINGS.md`。

安装会做三件事：把本包加进 profile 的依赖 → 因为本包 `package.json` 声明了 `dsh.bundle.patch`
而把它当作 bundle 选中 → 应用包内的 `cordis.patch.yml`，插入插件行。

安装前 DSH 会做**版本兼容检查**，把本包对 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的
`peerDependencies` 与运行时版本比对。**本包故意不声明任何这类 peer 依赖**——契约写明
"Missing DSH peers impose no constraint"，所以不会被兼容性检查拒绝，代价是失去版本保护。
（本机运行时版本实测为 **`0.2.0-rc.2`**；将来若要收紧，可以按这个版本声明。）

### ⛔ 不要做的事：把 profile 外的绝对路径插进补丁

这里曾经写着「方式 B：在 `cordis.patch.yml` 里直接 `insert` 一个绝对路径」。**那条路是错的，
而且它把用户的 DSH 搞崩过。** 官方文档确实说：

> Inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers.

但**实测**证明它只对 profile 目录树**内部**的导入者有效。模块本身能加载（加载器会把绝对路径
正确转成 file URL，中文路径也没问题），可它一旦 `import '@deepseek-ai/dsh-llm'` 这类宿主包就
**解析失败**，整个模块导入失败，插件被静默跳过——你会得到一个什么都不做、也不报错的插件。
而在一个**正在使用**的 profile 上做这件事，还有把整个 DSH 搞崩的风险。

原因：`$DSH_HOME/profiles/node_modules` 那张运行时解析表**只对 profile 子树内的导入者生效**。
正规安装会把包链接进 `profiles/<name>/node_modules/`，导入者就落在子树里了。

**所以：用正规安装方式，不要手工插绝对路径。** 完整证据见 `docs/LOAD-TEST-FINDINGS.md`。

### 关于热重载

实测热重载是活的：改 profile 补丁后无需重启即生效。但**不要依赖它试错**——错误的补丁会在
重载时被应用。要试就在一次性 profile 里试：

```sh
dsh --profile scratch-verify --from-default-profile desktop
```

> **注意**：补丁文件**为空或只有注释会让 DSH 启动失败**。要停用某一层请写 `[]`，不要留空文件。

---

## 配置项

在补丁行的 `config` 下设置。配置**没有 schema**：`src/index.js` 不导出 `Config`（那需要一个 eager 宿主 import，已被实测证明能让插件静默失效），而是在代码里校验——未知键给警告，非法值回落默认值，**都不会阻止插件加载**。缺的键一律用下面的默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `botAgent` | `dsh-wxbot/1.0.0` | 作为 `base_info.bot_agent` 发送，仅用于服务端日志归因与监控聚合，**不参与鉴权或路由**。ASCII、空格分隔的 `Name/Version`、≤256 字节。 |
| `apiBaseUrl` | `https://ilinkai.weixin.qq.com` | iLink API 基址。首次取二维码固定用这个地址。 |
| `channelVersion` | `2.4.8` | 作为 `base_info.channel_version` 发送。 |
| `storageDir` | 空 = 包目录下的 `.state` | 保存账号 token、`get_updates_buf` 游标、各对端的 `context_token`、`status.json` 与二维码。**含敏感凭据，勿提交到版本控制。** |
| `maxReplyChars` | `2000` | 回复超过此长度就分片发送。协议未规定上限，这是防御性取值。 |
| `typingIndicator` | `true` | agent 工作期间是否驱动微信的「正在输入」。 |
| `replyTimeoutMs` | `300000` | 单次回复的等待上限。 |
| `enableQrRoute` | `true` | 是否尝试注册 HTTP 登录页。⚠️ 实测**目前无效**（见下），保留待将来可用。 |
| `qrRoutePath` | `/wechat/qr` | 上述登录页的路径。 |
| `autoLogin` | `true` | 本地没有账号时是否自动开始扫码登录。 |
| `openLoginUrl` | `true` | 拿到登录链接后**自动用默认浏览器打开**。只放行 `http(s)` 与 `weixin:` 两种协议，且用 `rundll32` 交给系统（不经 shell，URL 里的 `&` 不会被当命令解析）。不想被弹窗就设 `false`。 |
| `sessionCwd` | 空 = **DSH 的默认工作区** | 每个微信会话运行的**工作区**，作为会话创建元数据 `meta.cwd` 传入。留空时的解析链是：**显式配置 → DSH 记录的工作区 → 包目录的父目录（兜底，会记一条 warn）**。DSH 那条读的是 `~/.dsh/storages/workspace.json` 里的 `global.defaultWorkspaceId` → 对应工作区的 `path`——**读的是规则不是路径，所以换台机器自动正确**。⚠️ 早先的默认值是"包目录的父目录"，那编码了"插件就在工作区里"这个**只对开发布局成立**的前提；装到别处（比如 Downloads）会把 agent 的工作区指向它自己的发行目录，**并让 DSH 凭空建一个新工作区**。解析结果与**来源**都记在 `apply:enter.sessionCwd` / `.sessionCwdSource`。 |
| `agentPreset` | `cordis` | 会话选择的**预设 ID**，作为 `meta.agentPreset` 传入。⚠️ **不是** profile 里 `agent-preset-registry` 的 `default`（那是 `standard`，一个只有人格、几乎没有工具的预设）：带工具集的是随 `dsh-web-app` 发布的 `presets/cordis.patch.yml` 声明的 `cordis`。但实测**只把值写进会话头部并不会绑定预设**——`standard` 和 `cordis` 都只得到一个工具，见「仍存在的限制」。 |
| `briefingInterval` | `10` | 每多少条入站消息重发一次**渠道提示词**（会话第一条必发）。提示词说明"对方在微信、只看纯文本、如何发文件"，长度 89 字符。设 `0` = 只在第一条发。存在的唯一理由是**插件写不了系统提示词**（那属于预设）。 |
| `agentProvider` | 空 = **自动发现** | 模型提供方。留空即可。 |
| `agentModel` | 空 = **自动发现** | 模型名。留空即可。 |
| `reasoningEffort` | 空 = **自动发现** | 推理强度。留空即可。 |

> **模型不需要你配置。** 三个键都留空时，插件自己找出这台机器的默认模型。发现链路
> （见 [src/model-discovery.js](src/model-discovery.js)）：
>
> 1. **显式配置** —— 只要填了某一个字段，它就覆盖那一个，其余仍走发现；
> 2. **`ctx.agentDefaultModel.currentSelection()`** —— 由 `@deepseek-ai/dsh-agent-default-model` 提供，
>    它存在的意义就是回答"新 agent 该用哪个模型"，所以**创建 agent 的入口本就该来问它**；
> 3. **profile 自己的** `cordis.patch.yml` / `cordis.yml` 里的 `agent-default-model` 行
>    （用于那个服务没有挂载的宿主）；
> 4. 内置默认值，**并明确告警**（绝不静默降级）。
>
> 每次解析的**来源**都会写进 `status.json` 的 `model:resolved`（`source` 字段是 `config` /
> `default-model-service` / `profile-config` / `fallback` 之一），所以"到底在用哪个模型、谁决定的"
> 永远可查。**整套发现过程不读取任何会话内容，也不从别的会话里借用任何值。**
>
> **为什么需要模型**：系统提示词模板引用了 `{{model}}`，没有模型的会话会装配失败并报
> `prompt variable "{{model}}" has no value for this assembly`，回合在**发起模型调用之前**就结束——
> 从外面看和"agent 没话说"一模一样，没有任何异常。而 profile 里的 `agent-default-model` 条目
> **不覆盖**程序化创建的会话，所以这个值必须有个来源。

---

## 首次登录

> **登录由「启动 DSH」触发，不是由收到微信消息触发。** 登录之前 bot 还没上线，你**发不出**消息给它。

1. 插件启动时若本地没有可用 token，会向 `POST /ilink/bot/get_bot_qrcode?bot_type=3` 申请二维码。
2. 拿到链接后，插件**同时**做三件事：
   - 写进**工作区根目录**的 `wechat-login.txt`（GUI 本来就展示工作区，不用去 `.state/` 里翻）
   - 在 Windows 上用默认浏览器**自动打开**该链接（`openLoginUrl: false` 可关掉）
   - 记进 `.state/status.json` 的 `qr:materialized`
3. **用手机微信扫码。**
4. 若手机提示输入**数字配对码**，把数字写进工作区根目录的 `wechat-verify-code.txt`
   （`.state/verify-code.txt` 也仍然接受）。插件每 2 秒读一次，读到即删除该文件。
5. 扫码成功后，`confirmed` 会返回 `bot_token` / `baseurl` / `ilink_bot_id` / `ilink_user_id`，写入 `storageDir`。
6. 之后即可在微信里直接与机器人对话；**重启不再需要扫码**（会自动恢复已存账号）。

> ⚠️ **`autoLogin` 必须保持 `true`**：它是目前**唯一的登录触发方式**（没有可用的 HTTP 登录页，
> 也没有别的入口）。设成 `false` 会导致**完全无法登录**。

登录会话在本地有 5 分钟 TTL，整体等待约 480 秒，二维码过期或配对码被限制时最多刷新 3 次
—— 这些是**官方客户端的策略值，不是服务端保证不变的协议常量**。

---

## 卸载

```sh
dsh plugin --profile web remove dsh-wxbot
```

手工挂载（方式 B）的话，把那条 `insert` 行删掉即可；想清空登录状态就删掉 `storageDir` 目录。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| 改完补丁后 DSH 起不来 | 该 profile 的 `cordis.patch.yml` 被重命名成了 `.bak-<时间戳>` 兄弟文件，把它改回去或写回 `[]`。也可用官方的 `sanitizeProfile` 恢复（它会备份补丁并恢复 bundle 列表，保留已安装的包）。 |
| 日志说插件版本不兼容 | 本包不声明 DSH peer 依赖，正常不该出现。若出现，用 `dsh plugin --profile web version-exemptions` 查看，`allow-version <包@版本> --dsh-version <运行时> --accept-risk` 授权（**官方要求先向用户说明不兼容插件可能导致崩溃或数据丢失**）。 |
| 日志出现 `ret: -14` / `errcode: -14` | **bot token 已失效**，不是普通网络错误。插件会停止紧密轮询并走受控重新扫码，不要靠反复重试解决。 |
| `sendmessage` 返回 HTTP 200 但微信没收到 | **HTTP 200 不等于投递成功。** 必须同时满足：网络成功 + HTTP 2xx + JSON 可解析 + `ret`/`errcode` 为 0 或缺省。 |
| 收到带 `group_id` 的消息 | 官方插件的入站聊天类型固定为 `direct`，发送路径**没有群聊分支**。本插件会记录并拒绝处理，避免把群消息当私聊回给发言人。 |
| 代理相关 | 四个代理变量 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` **只接受来自 `$DSH_HOME/.env`**，不接受调用目录的 `.env`。 |

---

## 必须知道的风险

1. **这不是一份承诺长期稳定的正式开放 API。** 腾讯在协议文档里明确写道，客户端类型与行为**不能确立完整的服务端契约**，
   TypeScript 里的可选字段**不能证明**服务端接受缺省该字段的请求。腾讯保留限速、内容过滤和**随时终止服务**的权利。
   本插件因此需要版本隔离、错误降级和重新登录能力，**不要把核心业务完全押在它上面**。
2. **仅支持私聊。** 群聊在官方实现里没有发送分支。
3. **登录会绑定你的微信个人账号**，并以扫码授权的方式把消息转发给机器人。请自行确认这符合你的预期、微信的功能条款以及当地法律法规。
4. **DSH 处于 developer preview**，官方声明会有破坏性变更。本插件按 `0.2.0-rc.2` 的契约编写。

---

## 目录结构

```
dsh-wxbot/
├── package.json           # 声明 dsh.bundle.patch；纯 ESM；无第三方依赖
├── cordis.patch.yml       # bundle 补丁：insert 一条插件行
├── README.md              # 本文件
├── LICENSE                # MIT 全文
├── .gitignore             # 挡住 .state/（凭据与第三方资料）与打包产物
├── cleanup.ps1            # 一次性清理：废弃会话 + 脚手架（默认只预览）
├── src/
│   ├── index.js           # Cordis 插件主干：配置校验、生命周期、消息桥接、工作区解析、
│   │                      #   媒体落盘、渠道提示词、出站附件与失败通知
│   ├── ilink-client.js    # iLink HTTP/JSON 协议客户端（协议 + 持久化 + 脱敏的唯一权威）
│   ├── ilink-client.ts    # ⚠️ 转换前的 TypeScript 原始稿：**非运行时文件**，从不被 import，
│   │                      #   仅作溯源保留（删掉就永久失去）。运行时用的是上面的 .js
│   ├── bridge.js          # 消息编排：分类、去重、**打断换新**、回复分片（纯端口注入）
│   ├── channel-briefing.js# 渠道提示词：这是微信、只看纯文本、怎么发文件（按间隔重发）
│   ├── dsh-agent-port.js  # DSH 会话适配：create/resume、经 setup 挂载工具、回复区间
│   ├── media-crypto.js    # AES-128-ECB 加解密与填充长度（入站/出站共用）
│   ├── media-download.js  # 入站媒体：取 URL、挑密钥、解密、类型嗅探
│   ├── media-upload.js    # 出站媒体：取上传地址、加密、构造 item、上传
│   ├── reply-media.js     # 回复里的 `[wechat-send: …]` 约定：解析与剥离
│   ├── model-discovery.js # 模型自动发现链：默认模型服务 → profile 配置 → 内置默认值
│   ├── qr.js              # 二维码落盘与给用户的提示
│   └── status.js          # 状态文件（唯一的观测通道）：`trail` 是叙述，
│                          #   `logTail` 镜像**每一条**日志——新代码无法再"无声"
└── docs/
    ├── DISCLAIMER.md                     # ⚠️ 免责声明与合规提示（十二节，使用前必读）
    ├── INSTALL-ON-ANOTHER-MACHINE.md     # 搬到另一台电脑的流程与最常见的坑
    ├── FIELD-FINDINGS.md                 # 11 个实战根因（全部附日志证据）
    ├── VERIFIED-FACTS.md                 # 已核实事实清单（逐条附来源）
    ├── DSH-PROFILE-AND-PLUGIN-CONTRACT.md  # DSH profile/bundle/补丁契约
    ├── DSH-PLUGIN-API-NOTES.md           # 插件 API 调研（10 章，26 条来源）
    ├── LOAD-TEST-FINDINGS.md             # 那次加载事故的复盘
    └── CODE-REVIEW-1.md                  # 静态审查报告
```

**为什么是纯 JavaScript 而不是 TypeScript**：DSH 加载纯 JS 插件**不需要构建产物**——
没有 `dist/`、没有构建步骤，克隆下来按上面「安装」一节就能装。代码用 JSDoc 保留类型标注。

> 注：开发初期本机沙箱无法启动受限进程，`tsc`/`pnpm` 都跑不了，那是当时的约束；
> 该问题后来已修复（见「必须知道的风险」一节）。但"不引入构建步骤"这个决定依然成立。

---

## 许可

本项目以 **MIT** 许可证发布，全文见 [LICENSE](LICENSE)。作者：**silentmorningche**。

微信 ClawBot 协议与 `@tencent-weixin/openclaw-weixin` 版权归腾讯，同样以 MIT 发布。

⚠️ 使用前请务必阅读 [免责声明与合规提示](docs/DISCLAIMER.md)：其中说明了平台规则风险、
数据与个人信息、生成式 AI 与深度合成合规、责任限制与赔偿等条款。
