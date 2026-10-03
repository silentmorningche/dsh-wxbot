# 微信 ClawBot × DSH 插件：已核实事实清单

> 本文件只记录**已被实际抓取/读取的证据支持**的事实，每条附来源。
> 推断与未验证内容不写在这里，另见 `DSH-PLUGIN-API-NOTES.md`。
> 最后更新：本轮会话。

---

## 一、微信 ClawBot 是什么

| 事实 | 证据 |
|---|---|
| 是腾讯官方给 **OpenClaw** 做的微信渠道插件，不是通用开放接口 | [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)、[知乎](https://zhuanlan.zhihu.com/p/2019118125963059386) |
| 包名 `@tencent-weixin/openclaw-weixin`，npm 上 dist-tags：`latest=2.4.9`、`beta=2.4.9-beta.0`、`legacy=1.0.3` | `https://registry.npmmirror.com/@tencent-weixin/openclaw-weixin` |
| **MIT 协议，作者标注 Tencent**，维护者多为 @tencent.com 邮箱 | 同上（`license: MIT`、`author: Tencent`） |
| 微信端入口：**我 → 设置 → 插件 → ClawBot**，iOS 8.0.70+ | [菜鸟教程](https://www.runoob.com/ai-agent/openclaw-weixin.html)、[IT之家](https://www.ithome.com/0/931/431.htm) |
| 官方安装流程：`npx -y @tencent-weixin/openclaw-weixin-cli install`，或 `openclaw plugins install "@tencent-weixin/openclaw-weixin"` → 启用 → `openclaw channels login --channel openclaw-weixin`（扫码）→ `openclaw gateway restart` | [菜鸟教程](https://www.runoob.com/ai-agent/openclaw-weixin.html)、包内 README |
| 官方**发布了一份协议文档**，明确写给"实现或集成兼容后端"的开发者 | [docs/protocol.md](https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/docs/protocol.md) |
| 运行时要求：Node >= 22.13.0；peer dependency `openclaw >= 2026.5.12`（npm 包 2.4.6 起） | npm 元数据 + [第三方协议分析](https://raw.githubusercontent.com/SiverKing/weixin-ClawBot-API/main/weixin-openclaw-api-py-docs.md) |

### 协议要点（来自官方 `docs/protocol.md`）

- 传输：**JSON over HTTPS**。业务方法 `POST`，二维码状态轮询 `GET`。JSON 里的字节字段用 base64 字符串。
- 默认 API base：`https://ilinkai.weixin.qq.com`
- 默认 CDN base：`https://novac2c.cdn.weixin.qq.com/c2c`
- 请求头：`Content-Type`、`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`、`X-WECHAT-UIN`（随机 uint32 的十进制字符串再 base64）、`iLink-App-Id`（当前 `bot`）、`iLink-App-ClientVersion`（版本编码为 `0x00MMNNPP`，以十进制字符串发送）、可选 `SKRouteTag`。
- 每个业务 POST 带 `base_info: { channel_version, bot_agent }`；`channel_version` 取自包版本，`bot_agent` 默认 `OpenClaw`，仅用于日志归因，**不参与鉴权或路由**。
- 端点一览：

| 操作 | 方法与路径 |
|---|---|
| `getUpdates` | `POST /ilink/bot/getupdates` |
| `getUploadUrl` | `POST /ilink/bot/getuploadurl` |
| `sendMessage` | `POST /ilink/bot/sendmessage` |
| `getConfig` | `POST /ilink/bot/getconfig` |
| `sendTyping` | `POST /ilink/bot/sendtyping` |
| `notifyStart` | `POST /ilink/bot/msg/notifystart` |
| `notifyStop` | `POST /ilink/bot/msg/notifystop` |
| 取二维码 | `POST /ilink/bot/get_bot_qrcode?bot_type=3` |
| 轮询扫码状态 | `GET /ilink/bot/get_qrcode_status?qrcode=<encoded>` |

- 二维码状态机（官方文档列出的全部取值）：`wait`、`scaned`、`confirmed`、`expired`、`need_verifycode`、`verify_code_blocked`、`scaned_but_redirect`、`binded_redirect`。
- `confirmed` 返回 `bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id`。
- `sendMessage` 文本消息：`msg.message_type=2`、`message_state=2`、`item_list[0] = {type:1, text_item:{text}}`；**回复时回传入站消息的 `context_token`**；`client_id` 每次唯一；`from_user_id` 传空字符串。
- `getUpdates` 响应字段：`ret`、`errcode`、`errmsg`、`msgs[]`、`get_updates_buf`（下一轮游标）、`longpolling_timeout_ms`。旧字段 `sync_buf` 已废弃。
- `ret: 0` 表示成功（用到的地方）。
- `item_list[].type` 枚举：1 文本、2 图片、3 语音、4 文件、5 视频、11 `tool_call_start_item`、12 `tool_call_result_item`。
- 媒体走 CDN + AES-128-ECB + PKCS#7；`media_type`：1 图片、2 视频、3 文件、4 语音。

### 官方文档自己声明的边界（重要，必须如实转达）

- 协议文档的原话：客户端类型与行为**"不能确立完整的服务端契约"**；TypeScript 里的可选字段**不能证明**服务端接受缺省该字段的请求。
- 该文档是**给实现兼容后端的人用的**，不是一份承诺长期稳定的正式开放 API 规范。第三方分析也强调：应保留版本隔离、错误降级和重新登录能力。
- 群聊：官方插件把入站 `ChatType` 固定为 `direct`，发送路径**没有群聊分支**。收到带 `group_id` 的消息不应当私聊回复。

---

## 二、DSH 侧

| 事实 | 证据 |
|---|---|
| DSH 开源、MIT，仓库 `github.com/deepseek-ai/deepseek-harness`，**默认分支 `master`** | `https://api.github.com/repos/deepseek-ai/deepseek-harness`（`license: mit`、`default_branch: master`、`topics` 含 `cordis`/`dsh`/`dsh-plugin`） |
| 描述/口号：**"DeepSeek Harness: Everything is a Plugin."** | 同上 `description` |
| 基于 **Cordis** 插件框架（`@deepseek-ai/cordis ~4.0.4`） | `@deepseek-ai/dsh-base@0.2.0-rc.2` 的 `peerDependencies` |
| 提供 profile 机制，本机 Web GUI 用的 profile 是 `web` | 本机 `C:\Users\<user>\.dsh\profiles\web\` |
| 官方加插件命令：`dsh plugin --profile <name> add <package>` | `@deepseek-ai/dsh-base` 的 README |
| 自带 profile 有 `web`、`headless`、`sdk`、`acp` | 同上 README |

### 本机 profile 的实际内容（已直接读取）

`C:\Users\<user>\.dsh\profiles\web\package.json`：
```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
```

`cordis.yml`（**不要改**，文件内注释明说）：
```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

`cordis.patch.yml`（**这才是加插件的地方**）是一个顶层 YAML 数组：
```yaml
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
```
文件内注释：这是一个"loader patch entry 的顶层 YAML 数组（按 id 定位的 config 覆盖、禁用、以及 **insert 列表**；允许 `!!js` 表达式）"。

装配顺序（`cordis.yml` 注释原文）：`package.json` 的 `dsh.profile.bundles` 里每个 bundle → `cordis.patch.yml` → 任何 `--patch` 覆盖。**后写覆盖先写，逐行 last-write-wins。**

`pnpm-workspace.yaml`：`packages: [.]`、`nodeLinker: hoisted`、`autoInstallPeers: false`。

`profiles/web/` 下**没有 `node_modules`** —— 即当前未安装任何第三方插件。

### 本机可用的运行时

- 自带 node：`C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- 自带 pnpm：`C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\{pnpm.cjs,pnpm.mjs}`

### 已知的 DSH 包（来自 `@deepseek-ai/dsh-base@0.2.0-rc.2` 的 dependencies，全部同版本号）

与"接入一个外部渠道"相关的候选：`dsh-session`、`dsh-session-title`、`dsh-agent`、`dsh-agent-loop`、`dsh-agent-default-model`、`dsh-api-gateway`、`dsh-tools`、`dsh-llm`、`dsh-storage`、`dsh-storage-json`、`dsh-storage-domain`、`dsh-plugin-manager`、`dsh-settings`、`dsh-web`、`dsh-web-fetch-http`、`dsh-web-search-deepseek`、`dsh-credentials-local`、`dsh-commands`、`dsh-tool-jobs`、`dsh-jobs-local`。

> `dsh-session` / `dsh-agent` / `dsh-api-gateway` 是"把消息送进会话并取回回复"最可能落点，具体 API 见 `DSH-PLUGIN-API-NOTES.md`。

### 文档索引（仓库 `master` 分支）

- 插件开发教程：`docs/user/develop/{basic,framework,practice}/`
- Cookbook：`docs/cookbook/`（含 `extension-cookbook`、`adding-a-package`、`adding-a-tool`、`adding-a-settings-card`、`adding-an-llm-adapter`、`adding-a-vendored-package`、`adding-a-remote-api`）
- 概念：`docs/cordis-primer.zh.md`、`docs/architecture.zh.md`、`docs/capability-seams.zh.md`
- API：`docs/cordis-api/`、`docs/cordis-tutorial/`、`docs/api-gateway.zh.md`
- 用户指南：`docs/user/guide/`（含 **`python-sdk.zh.md`**、`providers.zh.md`、`network-proxy.zh.md`、`schedule.zh.md`、`mcp-memory.zh.md`、`github-review.zh.md`）
- 文档站：https://deepseek-harness.github.io/deepseek-harness/

**注意**：`@deepseek-ai/dsh-*` 系列在 npm 上是公开发布的，可读源码；但 `app.asar` 里的**安装版本体读不到**（asar 归档，文件工具解析失败）。npm dist-tags 现状：`latest=0.0.1-rc.1`、`next=0.2.0-rc.2`、`alpha=0.1.7-alpha.2`。本机安装版对应的具体版本**尚未确认**。

---

## 三、本机环境阻塞项

| 事项 | 状态 |
|---|---|
| `pwsh` / shell | **完全不可用**。任何命令在执行前就失败：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区根>)`。两个不同工作区都复现，指向共同上级（疑似 `D:\Users\<user>`）的 Windows 文件权限被改动。Win32 5 = 拒绝访问。DSH 是失败即关闭，宁可不执行也不降级。 |
| 文件读写工具（read/write/glob/grep） | **可用**。已验证能列出 `D:\Users\<user>` 下 95108 个路径、能写入工作区。 |
| `web_search` | **坏的**：请求发到了对话端点 `https://api.deepseek.com/anthropic/v1/messages`，返回 `fetch failed`。 |
| `web_fetch` | **可用**，是绕过搜索的通道。注意 `duckduckgo.com` 连不上（国内正常），要用 `https://cn.bing.com/search?q=<urlencoded>`。 |

**影响**：写代码可以，但 `dsh plugin add`（要调 pnpm）、重启 DSH、跑测试都做不了。**装插件和验证必须有 shell。**

---

## 四、待确认（下一步要解决的）

1. 一个 DSH 第三方插件的**精确包结构**与 `cordis.patch.yml` 补丁行写法（含 insert 列表语法）。
2. 插件如何**把外部消息送进 DSH 会话并取回助手回复**——服务名与方法签名。（三条候选路径：进程内 Cordis 插件 / Python SDK / `acp`·`sdk` profile）
3. 本机安装版 DSH 的**确切版本**，以对齐插件 API。
4. 二维码怎么呈现给用户（终端渲染 / Web GUI / 存成图片）。
