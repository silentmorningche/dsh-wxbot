# 在另一台电脑上安装这套插件

> 这份文档假设你**已经在这台机器上跑通了**，现在要搬到另一台。它只讲"搬过去要注意什么"，
> 不讲插件原理（那在 [README](../README.md) 和 [FIELD-FINDINGS](FIELD-FINDINGS.md)）。

---

## 0. 先决条件

| 需要 | 说明 |
|---|---|
| DSH（桌面版或 CLI） | 这套代码是对着 **`0.2.0-rc.2`** 写的。DSH 的插件 API 还在 rc 阶段，版本差得多时 `agents.create/resume` 的选项可能不同 |
| 一个 profile | GUI 首次运行会建。本机上是 `desktop` |
| **不需要 `pnpm install`** | 插件**零第三方依赖**，只用 Node 内置模块。这是它能随便搬的最大原因 |
| Node ≥ 22.13.0 | `package.json` 里声明了；DSH 自带运行时，天然满足 |

---

## 1. 拷贝插件目录

把整个 `dsh-wxbot/` 拷到那台机器上，比如 `D:\dsh-plugins\dsh-wxbot`。

**⚠️ 有两个目录绝对不要拷贝：**

| 目录 | 为什么不能拷 |
|---|---|
| `.state/` | 里面有 **bot token、`get_updates_buf` 游标、各对端的 `context_token`**。拷过去等于让那台机器也持有同一个 bot 的身份，而且**会和原机器抢同一个微信账号**——游标冲突会导致两边都静默丢消息 |
| `.acl-recovery/` | 本机的文件权限诊断报告，对别的机器毫无意义 |

**要拷的是**：`package.json`、`cordis.patch.yml`、`src/`、`docs/`、`cleanup.ps1`、`README.md`。

---

## 2. 配置：**默认什么都不用改**

插件开箱可用。**模型是自动发现的**——你**不需要**去抄那台机器的 `agent-default-model`，也不需要设置
任何模型键。发现链路见 [README 的配置项一节](../README.md#配置项)，源码在
[src/model-discovery.js](../src/model-discovery.js)。

只有这两种情况才需要动配置：

| 你想要的 | 改哪个键 |
|---|---|
| 让微信会话在**指定的项目目录**里跑（默认是插件包所在目录的父目录） | `sessionCwd` |
| 覆盖自动发现的模型（比如那台机器上有多个模型可选） | `agentProvider` / `agentModel` / `reasoningEffort`（填哪个就覆盖哪个） |

> **先看一眼这两个字段，再决定要不要改**：启动后 `.state/status.json` 里
> `apply:enter.sessionCwd` 写明会话将运行在哪个目录，`model:resolved.source` 写明模型是从哪来的
> （`config` / `default-model-service` / `profile-config` / `fallback`）。

---

## 3. 装进 profile

两种方式，等价：

**A. Web 界面（推荐）**：Plugins 页面 → 从本地目录添加 → 选那台机器上的插件目录。

**B. 命令行**：

```
dsh plugin --profile <profile> add <插件目录的绝对路径>
```

装完后 profile 的 `package.json` 里会出现一条 **`link:` + 那台机器的绝对路径**。
**所以安装记录不能从本机照抄**——路径肯定不一样。

---

## 4. 重启 DSH —— 登录是**自动**发生的

> **⚠️ 这里没有"先在微信里发一句话"这一步。**
> 在你登录之前这个 bot 还没上线，**你在微信里根本发不出消息给它**。
> 登录的触发点是**启动 DSH**，不是收到消息。

顺序是这样的：

1. **重启 DSH。**
2. 插件启动时发现本地没有账号。因为 `autoLogin: true`，它**自动**去取一张登录二维码，然后**同时做三件事**：
   - 把登录链接写进 **工作区根目录**的 `wechat-login.txt`
   - （Windows 上）**自动用默认浏览器打开**那个链接
   - 把链接也记进 `.state/status.json` 的 `qr:materialized`
3. **你用手机微信扫码。**
4. 如果微信向你索取配对码：把数字写进工作区根目录的 `wechat-verify-code.txt`
   （旧的 `.state/verify-code.txt` 也仍然接受）。插件每 2 秒读一次，读到就删掉该文件。
5. 登录成功后，登录状态存进 `.state/`，**以后重启不再需要扫码**（会自动恢复账号）。
   **这时**才轮到"在微信里给它发一句话"来验证收发 —— 见第 6 节。

> **⚠️ `autoLogin` 必须保持 `true`。**
> 它是目前**唯一的登录触发方式**：没有可用的 HTTP 登录页，也没有别的入口。
> 设成 `false` 会导致**完全无法登录**（除非那台机器上已经存有账号，或 token 失效触发了受控重登）。

---

## 5. 最可能踩的坑（按概率排序）

### ① 模型**发现失败** → 微信那头"完全没反应"

**这是最容易踩、也最难看出来的一个。** 现在它不太会发生了（模型是自动发现的），但**发现链路全都失败时**
会回落到内置默认值，而如果那台机器的实际模型和内置默认值不同，症状就是**"agent 什么都没说"**。

根因：profile 里的 `agent-default-model` **不覆盖程序化创建出来的会话**。模型不对时，系统提示词装配会
失败并报：

```
prompt variable "{{model}}" has no value for this assembly
```

回合在**发起模型调用之前**就结束。从外面看就是**"agent 什么都没说"**——没有异常、没有报错、
微信那头只是「正在输入」闪一下然后没动静。

**怎么查（两步）：**

1. 看 `.state/status.json` 的 **`model:resolved`**：
   - `source: "fallback"` → **发现失败了**，用的内置默认值。日志里同时有一条 warn 说明。
     这时把 `agentProvider` / `agentModel` 显式填上即可。
   - `source: "default-model-service"` 或 `"profile-config"` → 模型是从这台机器上取到的，基本可以排除这个原因。
2. 还不行就看 **`logTail`**（它镜像了每一条日志，**什么都不会漏**），里面有 `turn/end` 的 `reason`，
   会写明是哪个变量没有值。

### ② `sessionCwd` 留空 → 会话跑在插件包所在目录

把插件放在 `C:\dsh-plugins\dsh-wxbot`，微信会话的工作目录就是 `C:\dsh-plugins`。
**建议显式设成你真正想用的工作区。**

### ③ 改了 `sessionCwd` 或模型，但已有会话没跟着变

`resume()` **没有 `meta` 参数**，所以会话会保留它**创建时**的 cwd 和模型。插件现在会对此
**明确告警**（`logTail` 里有一条 warn，写着"这个会话保留的是创建时的工作区…"）。

要让改动真正生效，只能把 `src/bridge.js` 里 `sessionIdFor` 的 **`v2` 改成 `v3`**
——代价是**丢掉那一段对话**。这是有意设计成显式动作的。

### ④ 自动打开浏览器只在 Windows 生效

用的是 `rundll32 url.dll,FileProtocolHandler`（不经 shell，URL 里的 `&` 不会被当命令解析）。
macOS / Linux 上会记一条 warning，**但工作区里的 `wechat-login.txt` 依然有效**，手动打开即可。

### ⑤ 没有 HTTP 登录页 —— 这不是配置问题

实测确认：`ctx.reflect.get('webServer', false)` **返回空且不抛错**（直接读才抛
`without inject`），说明提供路由的 `@deepseek-ai/dsh-host-webserver` **没有挂载进桌面版的插件树**。
而它的文档写明 **Electron 窗口用 `file://` 加载 dist、fetch 走 IPC**，只有浏览器访问才经过 HTTP。

**所以能用的登录通道就是工作区文件 + 自动开浏览器**，在别的机器上同样如此。不必再尝试修它。

### ⑥ `cleanup.ps1` 里的路径是本机写死的

`$sessionRoot = 'C:\Users\<user>\.dsh\sessions'` —— 换机器要改。它只是个一次性的清理脚本，
不影响插件运行。

---

## 6. 搬过去之后建议立刻做的两件事

1. **在微信里发一句话确认能回**。回不了就看 `.state/status.json` 的 `logTail`——现在所有日志
   都在里面，包括每个事件和 `turn/end` 的失败原因。
2. **确认会话落在了你想要的工作区**：看 `.state/status.json` 里 `apply:enter` 那条的 `sessionCwd`，
   以及 `logTail` 里有没有"保留创建时的工作区"的告警。
