# DSH profile 与插件契约（权威事实）

> 来源：`@deepseek-ai/dsh-app-boot@0.2.0-rc.2` 与 `@deepseek-ai/dsh-plugin-manager@0.2.0-rc.2` 的包内 README，
> 经 `https://registry.npmmirror.com/@deepseek-ai/dsh-app-boot/0.2.0-rc.2` 与 `.../dsh-plugin-manager/0.2.0-rc.2` 抓取。
> 这两个包是 profile 加载与插件管理的**权威实现文档**。
>
> ⚠️ **版本注意**：以上是 `0.2.0-rc.2`（2026-09-29 发布）的契约。本机安装版 DSH 的确切版本**尚未确认**，
> 版本间可能有 breaking change（官方自称 developer preview，"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"）。

---

## 一、profile 是什么

- profile 是"同一套 dsh 安装如何呈现不同 app 表面"的机制。官方自带：**`web`、`headless`、`acp`、`sdk`、`sdk-minimal`**。
- profile 位于 **`$DSH_HOME/profiles/<name>`**，由"可安装的 bundle"加上它自己的 `cordis.patch.yml` 组合而成。
- **HMR（热重载）由 YAML 组合开启或关闭**：
  - 自带的 **`web` 模板使用 live reload**；
  - 其他自带模板**只在启动时应用补丁**。
  → 本机 Web GUI 用的就是 `web` profile，**所以配置改动可以立即生效，不必重启。**

## 二、bundle 的声明方式（关键）

- 一个 bundle 通过 `package.json` 里的 **`dsh.bundle.patch`** 声明：值可以是**一个补丁文件**或**有序的文件列表**。
- 加载时把这些补丁文件的 patch 列表**按顺序拼接**成一层。
- 实例：`@deepseek-ai/dsh-base` 的 `package.json` 里就是 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
- **没有 bundle 补丁的包不算 bundle** —— `listBundles` 会把它标成 `not-bundle` 问题。

> 对我们的意义：如果要走"bundle"这条正规路，我们的包必须带 `dsh.bundle.patch` 指向一个 YAML 补丁文件。

## 三、用户补丁层 `cordis.patch.yml`

- 位置有两处，**per-profile 的在前，home 级的在后（因此 home 级覆盖 per-profile）**：
  - `$DSH_HOME/profiles/<name>/cordis.patch.yml`
  - `$DSH_HOME/cordis.patch.yml`
- 能做的事：**替换某个条目的整个 config**（不深合并，要保留的字段必须重述）、**插入新条目**、在启动时插值 `!!js` 表达式。
- 陷阱：
  - 补丁指向一个不存在的条目 → 只打印 stderr 警告；
  - **空文件或只有注释的文件会让启动失败** —— 想停用这层要用 `[]`，不能留空。

### ★ 插入的插件名可以是绝对路径（这条改变了安装方式）

原文：

> Inserted plugin names may be **absolute filesystem paths, file URLs, or package specifiers**. Patch loading converts absolute paths and patch-relative `./` or `../` paths to file URLs within `insert` rows and their nested groups.

**含义**：我们可以在 `cordis.patch.yml` 的 `insert` 里直接写**本机绝对路径**指向我们开发的插件，
**完全不需要发布到 npm，也不需要跑 pnpm**。

> 这是一个可能**绕开损坏的 shell** 的安装路径。但注意：写 `$DSH_HOME` 下的文件在我的沙箱里属于"工作区之外"，
> 需要用户批准；且改坏了会导致 DSH 启动失败（有 `sanitizeProfile` 可恢复）。

## 四、版本兼容性检查（最容易踩的坑）

- **在 profile 导入插件之前**，DSH 会用 `getDshRuntimeVersion()` 返回的**单一运行时版本**，
  检查插件的 **`peerDependencies` 里对 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的声明**。
  **每一条 range 都必须匹配**；预发布版本参与 range 匹配。
- **检查用的是 peer 声明，不是 `engines.dsh`。**
- **缺失 DSH peer 声明则不施加约束**（"Missing DSH peers impose no constraint"）。
- range 非法视为不兼容。
- 这只是兼容性检查，**不是对抗恶意代码的沙箱**。
- 被拒绝的行在启动器自己的组合副本里被拒；不会改 profile 补丁层、依赖清单或 bundle 列表。
- 精确版本豁免写在 profile 自己的 **`compatibility.json`**（不是 `package.json`）。键是精确的 `包名@版本`，值是精确的 DSH 运行时版本列表。

> 对我们的意义（重要）：**最安全的做法是不声明任何 `@deepseek-ai/dsh*` peerDependency**，从而不触发约束；
> 或者先查出本机运行时版本再声明精确的 peer range。绝不要凭猜写一个宽松 range。

## 五、启动与重载失败策略（决定我们的插件必须多稳）

| 失败形态 | 启动时可选条目 | 启动时必需条目 |
|---|---|---|
| 模块导入失败 / 模块求值抛错 | 警告并继续 | 停止启动 |
| 插件 config schema 校验失败 | 警告并继续 | 停止启动 |
| `!!js` 求值抛错 | 警告并继续 | 停止启动 |
| `disabled` 求值抛错 | 警告并继续 | 停止启动 |
| 同步 `apply()` 抛错 | 警告并继续 | 停止启动 |
| 异步 `apply()` 抛错 | 结算后警告并继续 | 结算后停止启动 |
| 注入的服务不可用 | 警告并继续，条目等待依赖 | 停止启动 |
| **`apply()` 返回的 Promise 之外的游离异步工作产生 unhandled rejection** | **致命：销毁整个 app 并以非零码退出** | 同样致命 |
| 同步回调（流 `'data'` 监听器、定时器）在任意时刻抛未捕获异常 | **致命：销毁 app 并退出** | 同样致命 |

- 全局**必需条目**名单：`agent-loop`、`webserver`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`。
  **我们的插件绝不能被列入必需条目。**

> 对我们的意义（关键设计约束）：**长轮询循环必须完全挂在 `apply()` 的生命周期上，不能产生任何 unhandled rejection。**
> 否则不只是我们的插件坏掉，而是**把整个 DSH 拖崩**。每一层 `await` 都要 catch，定时器回调内部要自捕获。

## 六、安装与管理（`dsh-plugin-manager`）

- 官方插件管理服务，被 **dsh CLI、Web、agent 工具**共用。描述：`Current-profile plugin and bundle management shared by dsh CLI, Web and agent tools`。
- **Web 侧边栏有 Plugins 页面**可以管理 profile 的 bundle 和条目（无需手改文件）。Settings 里的 Plugin 列表是只读的。
- agent 侧有一个 **`plugin_manager` 工具**（Creator 模式下启用）。**每个工具动作都要求 `danger-full-access` 或当次批准的审批。**
  → 我这个会话的工具列表里**没有**它，走不了这条路。
- **`installBundle` 接受的 spec 包括绝对路径**：
  - `inspect(spec)` 的行为明说："**an absolute path has its `package.json` read**"；git 地址或 tarball 只回答形式与来源 host。
  - 问题码：`invalid-spec`、`already-installed`、`not-found`、`not-a-package`、`not-a-bundle`、`network`、`unknown`。
- **版本兼容在 pnpm 运行之前就检查**："a local path is read from its own `package.json`" —— 不兼容的 DSH peer 会在下载任何东西之前就拒绝。
- 安装失败会**还原 `package.json` 和 `pnpm-lock.yaml`**；但 pnpm 已下载的文件可能残留。
- 移除顺序：先从 `dsh.profile.bundles` 去掉 → 卸载运行时贡献 → 再 `pnpm remove`。
- 注册表配置：`registry` 默认用 pnpm 自己的；`fallbackRegistries` 默认 **`['https://registry.npmmirror.com/']`**（国内友好）。
- CLI 还有：`dsh plugin --profile <profile> version-exemptions`、`allow-version <package@version> --dsh-version <runtime> --accept-risk`、`revoke-version`。

> 对我们的意义：**`dsh plugin --profile web add <绝对路径>` 是被支持的**，不需要发布到 npm。
> 但那仍然要跑 pnpm → 仍然需要 shell。真正能绕开 shell 的是第三节那条"`insert` 里写绝对路径"。

## 七、恢复手段

- **`sanitizeProfile(binName, profileDir, bundles)`**：不做插件加载、不解析补丁的文件系统恢复。
  它把 profile 的 `cordis.patch.yml` 重命名为带时间戳的 `.bak-<timestamp>` 兄弟文件，并恢复给定的 bundle 列表，
  **保留已安装的包和其他 manifest 字段**。返回备份路径。
  - 只能在**停止 profile 之后**、且排除并发写入时调用。
  - 下次启动会重建一个空的补丁文件。
  - home 级补丁不受影响。
- 所以即使我们把 `cordis.patch.yml` 改坏了，也有官方恢复路径。

## 八、其他可能与后续相关的点

- **`.env` 分层**：调用目录的文件优先于 Harness-home 的文件，两者都低于继承的环境变量。
  决定进程如何启动的变量（`PATH`、`DSH_*`、`XDG_*` 等）**被禁止**从文件里设置，必须 export。
  **四个代理变量 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 只接受来自 Harness-home 的 `.env`**，不接受调用目录的。
- **app-boot 的描述**提到"the temporary **Python SDK runtime**" —— Python SDK 是通过一个 wheel 提供的，里面打包了 CLI。
- `--dump-config` 可以预览生效的配置（报告配置的组合，被策略拒绝的行仍会出现，但被拒绝的 bundle 不贡献任何行）。
- `--dump-config-schema` 会导入每个组合模块来读 schema —— **只对已经信任的 profile 运行**。
- 插件显示元数据（图标、多语言文案）可通过 `readPluginMeta(specifier, parentURL)` 在不导入不激活的情况下读取；
  作者格式见 `docs/cookbook/adding-a-package.md#plugin-display-metadata`。
