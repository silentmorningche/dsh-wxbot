# 加载测试结果（一次代价很大的实验）

> 这份文档记录一次**真实加载测试**的结果。它不是推演，是探针在运行中的 DSH 进程里
> 实际执行后写出来的数据。
>
> ⚠️ **这次测试是在用户的 live profile 上做的，并且导致了 DSH 崩溃。**
> 教训与正确做法记在最后一节。任何后续验证都必须在**一次性 profile** 上做。

---

## 一、测试环境（实测，非推断）

| 项 | 值 | 来源 |
|---|---|---|
| 宿主 | `C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe` | 探针 `process.execPath` |
| 运行时 | Electron **44.0.0**，Node **v24.18.1** | 探针 `process.versions` / `process.version` |
| **实际使用的 profile** | **`desktop`**（`cwd` = `C:\Users\<user>\.dsh\profiles\desktop`） | 探针 `process.cwd()` |
| **DSH 运行时版本** | **`0.2.0-rc.2`** | 探针调用 `getDshRuntimeVersion()` |
| 热重载 | **是活的**：改 profile 补丁后无需重启即生效 | 两次探针都在文件写入后数秒内执行 |
| 安装渠道 | nightly 桌面版（`app-update.yml`: `channel: nightly`） | 读取 `app-update.yml` |

**这一条推翻了一个此前的猜测**：我原以为 live 的是 `web` profile（本机两个 profile 都存在，
且都 bundle 了 `@deepseek-ai/dsh-web-app`）。实测是 `desktop`。我用 `cwd` 确认了，不是猜的。

**版本锚点得到确认**：仓库 `master` HEAD 的提交就是 `release: dsh@0.2.0-rc.2`，而宿主
`getDshRuntimeVersion()` 返回的正是 `0.2.0-rc.2`。所以按 `0.2.0-rc.2` 的源码与文档写的插件，
面对的确实是同一个版本。

---

## 二、决定性发现：宿主包只在 profile **内部**可解析

同一个探针逻辑，放在两个位置，结果完全相反：

### 位置 A：profile 之外 —— `D:\...\dsh-wxbot\verify\load-probe.js`

```
@deepseek-ai/schemastery : FAILED — Cannot find package '@deepseek-ai/schemastery' imported from D:\...\load-probe.js
@deepseek-ai/dsh-llm     : FAILED — Cannot find package '@deepseek-ai/dsh-llm' imported from ...
@deepseek-ai/dsh-app-boot: FAILED — Cannot find package '@deepseek-ai/dsh-app-boot' imported from ...
```

### 位置 B：profile 之内 —— `C:\Users\<user>\.dsh\profiles\desktop\host-resolve-probe.js`

```
@deepseek-ai/schemastery  : OK — 1 exports
@deepseek-ai/dsh-llm      : OK — 66 exports
@deepseek-ai/dsh-app-boot : OK — 54 exports
@deepseek-ai/dsh-session  : OK — 28 exports
@deepseek-ai/dsh-agent    : OK — 8 exports
@deepseek-ai/dsh-tools    : OK — 23 exports
@deepseek-ai/cordis       : OK — 26 exports
```

**含义**：`$DSH_HOME/profiles/node_modules` 那张运行时解析表，对 **profile 目录树内部的导入者**
生效，对树外的导入者**不生效**。`dsh-app-boot` README 里那句
"runtime resolution entries occupy their package names at `$DSH_HOME/profiles/node_modules`;
every other name sees that directory as an ordinary ancestor" 是**有前提的**——前提就是导入者得在
那棵子树里。我之前只读了这句话就下了结论，是错的。

### 由此确立的两条安装事实

1. **`insert` 一行指向 profile 外的绝对路径，对会 import 宿主包的插件是走不通的。**
   模块本身能加载（加载器会把绝对路径正确转成 file URL，中文路径也没问题——
   见探针写出的 `file:///D:/.../%E9%BB%98%E8%AE%A4%E5%B7%A5%E4%BD%9C%E5%8C%BA/...`），
   但它一 import 宿主包就失败。
2. **正规安装（Web 界面 Plugins 页面，或 `dsh plugin --profile desktop add <路径>`）会解决这个问题**，
   因为 pnpm 会把包链接到 `profiles/desktop/node_modules/` 里面，导入者就落在子树内了。
   解析路径：`profiles/desktop/node_modules/dsh-wxbot/` → 上溯到
   `profiles/desktop/node_modules` → `profiles/node_modules`（运行时解析表）→ 命中。

---

## 三、宿主 API 的实测清单（不再需要推断）

这些名字此前都是"文档说的"或"推断的"，现在是运行中的进程里 `typeof` 出来的：

| 符号 | 实测 |
|---|---|
| `Schema.object` / `Schema.string`（`@deepseek-ai/schemastery`） | 都是 function |
| `createUserMessage`（`@deepseek-ai/dsh-llm`） | function |
| `expandAssistantStream` | function |
| `joinAssistantStreamText` | **function（此前只是推断，现已确认存在）** |
| `getDshRuntimeVersion`（`@deepseek-ai/dsh-app-boot`） | function → `0.2.0-rc.2` |

`@deepseek-ai/dsh-llm` 的 66 个导出已完整取得，其中与本插件相关的还有：
`assembleAssistantStream`、`assistantStreamChunks`、`assistantStreamFirstTokenTime`、
`assistantStreamHasVisibleContent`、`assistantStreamHasVisibleText`、`lastAssistantStreamChunk`、
`isTokenDelta`、`isVisibleChunk`、`chunkHasVisibleText`、`runFirstTokenTime`、`runFirstVisibleTime`。

> 这意味着 `src/dsh-agent-port.js` 里"⚠️ A1：`@deepseek-ai/dsh-llm` 的确切导出名未验证"
> 这一条**已经解决**。剩下的 A2（`ctx.agents.create` 的参数形状）、A3（`data.stream` 的具体结构）
> 仍未验证，因为探针没有调用它们。

---

## 四、这次测试是怎么把用户的 DSH 搞崩的

**我做了什么**（五次写入正在使用的 profile，几分钟内）：

1. `profiles/web/cordis.patch.yml` — 追加 `insert`，指向 profile 外的 `src/index.js`
2. `profiles/desktop/cordis.patch.yml` — 追加同一个 `insert`
3. 上面两个补丁各再改一次，加一行 profile 外的探针模块
4. 新建 `profiles/desktop/host-resolve-probe.js`（这一次在 profile 内），并把补丁加了第三行

**确定的**：探针确实在运行中的进程里执行了，说明这些 insert 行真的被挂进了正在运行的插件树。

**最可能的致命机制（无法证实，因为没有日志）**：插件树里被塞进了一个**永远无法完成导入**的条目。
契约说可选条目的导入失败是"警告并继续"，但 DSH 有 `installFailLoud`——未捕获异常或游离
unhandled rejection 会**直接销毁应用并以非零码退出**。在一个带活动会话的实时重载里踩到这条路径，
就表现为整个应用崩溃。次可能的原因是几分钟内五次全树重载本身。

**结论：不要在 live profile 上验证未验证的模块。** 我犯的错不是"想验证"，而是把**用户正在用的
profile 当成了试验台**，而且没有在第二次写入之前就准备好回滚。

---

## 五、后续验证的正确做法

1. 先建一个一次性的 profile，绝不碰正在用的那个：
   ```sh
   dsh --profile scratch-verify --from-default-profile desktop
   ```
2. 在那个 profile 上装插件、跑探针。崩了只影响这个一次性 profile。
3. 一次性 profile 里也要有退路：`sanitizeProfile` 会把 `cordis.patch.yml` 备份成
   `.bak-<时间戳>` 并恢复 bundle 列表。
4. 探针**永远**只插进一次性 profile。仓库里的 `verify/load-probe.js` 因此已被改成警告墓碑。
5. 宿主包解析问题现在已知：**要么装在 profile 内，要么别 import 宿主包。**

---

## 六、仍未验证的两件事

- **`ctx.agents.create(options)` 的确切参数形状**（文档给了两种样例，未在运行时确认）。
- **`session/event` 里 `event.data.stream` 的结构**，以及 `expandAssistantStream` 返回的 chunk
  形态（`text-delta`？`text`？）。`src/dsh-agent-port.js` 里的读取器对几种形态都做了容错，
  但正确形态需要一次真实运行才能确认。
