# DSH 插件开发 API 笔记

> 目标：查清 DeepSeek Harness (DSH) 的插件开发 API，特别是"把一条外部用户消息送进 DSH 会话并拿回助手回复文本"的确切方法。
>
> **所有代码一律用纯 ESM JavaScript**（宿主环境 shell 不可用，无法运行 tsc/pnpm build）。本文出现的 TypeScript 只出现在"文档原文引用"中，并在旁边给出纯 JS 等价写法。

**标注约定**

| 标记 | 含义 |
|---|---|
| 【文档】 | 直接从官方文档/源码读到的原文或直接改写，附来源 URL |
| 【推断】 | 我基于多条文档事实推出的结论，附推断依据 |
| 【⚠️未验证】 | 我没能从源码或文档确认。不要当事实用 |

---

## 0. 版本锚点（重要）

我读的是 **`master` 分支**的快照：

- `master` HEAD commit = `639ed015397290b3745d163aafe02ffee4aa3f84`
- 提交时间 = `2026-09-29T09:21:31Z`
- 提交信息 = `Merge pull request #5479 from deepseek-harness/worktree/release-dsh-0.2.0-rc.2` / `release: dsh@0.2.0-rc.2`
- 同一次提交把根 `package.json`、`apps/cli/package.json`（`@deepseek-ai/dsh`）、`packages/api/gateway`（`@deepseek-ai/dsh-api-gateway`）、`packages/boot/plugin-manager`（`@deepseek-ai/dsh-plugin-manager`）等**全部**从 `0.2.0-rc.1` 升到 `0.2.0-rc.2`。

来源：<https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master>

**【推断】版本结论**：`master` HEAD == 发布的 **`dsh@0.2.0-rc.2`** == npm 上 `@deepseek-ai/dsh-base` 的 **`next`** dist-tag（你给的 dist-tags 里 `next=0.2.0-rc.2`）。所以本文引用的 API 对应 **0.2.0-rc.2**。

**本机装的是哪个版本 —— ⚠️未验证**：
本机安装在 `C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\`，是 Electron 桌面版：

- `resources\app-update.yml` 显示 `channel: nightly`，`provider: generic`，`url: https://download.deepseek.com/dsh-desk/feeds/win-x64/`
- DSH 运行时代码打包在 `resources\app.asar`（二进制归档）里，`resources\app.asar.unpacked\dsh\node_modules\` 只解包了少数含原生/静态资源的包（`@deepseek-ai/dsh-desktop-host`、`@deepseek-ai/dsh-session-log-export`、`@deepseek-ai/libreoffice-kit` 等），**没有** `dsh-base` 的 `package.json`。
- 我尝试用 ripgrep 直接在 `app.asar` 里找 `"name": "@deepseek-ai/dsh-base", "version": "..."` → **无匹配**（asar 是打包格式，二进制搜索没能命中）。

**⚠️未验证**：本机实际运行的 dsh 版本号无法通过现有工具读出。由于 channel 是 `nightly`，它**很可能不是** 0.2.0-rc.2 的正式发行版。**建议在执行前用 `dsh --version` 或 `dsh --profile web --dump-config` 实测确认**（`--dump-config` 是文档记载的命令，见 §1.5）。

来源：本机文件 `C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\app-update.yml`（已用 read 工具读取）

---

## 1. 第三方 DSH 插件包的精确最小结构

### 1.1 两个概念、两种 manifest【文档】

DSH 文档明确区分两个概念，都由 `package.json` 承载，但 `dsh` 键下声明**不同的** manifest：

- **组合包 (bundle)**：附带一个配置层的 npm 包，manifest 声明 `dsh.bundle`，回答"这个包贡献什么？" —— 一个插入或覆盖插件行的 patch 文件。
- **profile**：位于 `$DSH_HOME/profiles/<name>` 下、描述一份可启动组合的目录，manifest 声明 `dsh.profile`，回答"这套配置由哪些组合包按什么顺序组成？"

> "组合包是你编写并分发的东西；profile 是用户用 `dsh --profile <name>` 启动的东西。**没有东西同时是两者。**"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.zh.md>

**结论：第三方插件包 = 组合包，声明 `dsh.bundle`，不声明 `dsh.profile`。**

### 1.2 目录布局（官方最小样例，逐字抄自文档）

文档给出的目录树：

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.zh.md>

**注意：官方样例就是纯 `index.js`，没有 build 步骤、没有 `lib/`、没有 tsconfig。** 这正好符合你的约束。

### 1.3 `package.json`（逐字抄自文档）

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.zh.md>

**【文档】关于 `dsh.bundle` 的原文**：

- `patch` 是相对路径。也**接受一个有序的文件列表**，例如 `["./base.patch.yml", "./web.patch.yml"]`，"launcher 按该顺序把它们作为同一层应用，每个文件中的相对插件路径相对于该文件解析"。
- "**没有 `dsh.bundle` 声明的包仍然可以安装，但只作为普通依赖**：`dsh plugin` 会打印警告，且不激活任何层。如果一个库供插件包 import，而不是供用户启用，就使用这种包格式。"

> 原文引用：「`patch` 也接受一个有序的文件列表，例如 `["./base.patch.yml", "./web.patch.yml"]`；launcher 按该顺序把它们作为同一层应用，每个文件中的相对插件路径相对于该文件解析。」

**必填字段小结【文档】**：`name`、`version`、`type: "module"`、`main`、`files`、`dsh.bundle.patch`。文档样例中**没有** `exports` 字段。

### 1.4 插件入口 `index.js`（逐字抄自文档）

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.zh.md>

**【文档】插件的三种形态**（来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/index.zh.md>）

> "在 Harness 中，插件是一个导出 `apply` 函数的 TypeScript 模块。"

1. **函数形式**：`export const name = '...'` / `export function apply(ctx) {...}`（可另加 `export const inject = [...]`）
2. **对象形式**：`export default { name, inject, apply(ctx) {...} }`
3. **类形式**：`export default class MyService extends Service { static inject = [...]; constructor(ctx) { super(ctx, 'myService') } }`

> "框架会确保依赖的服务就绪后才加载你的插件。"
> "大多数情况下，函数形式足够了。当插件需要向其他插件提供服务时，可使用类形式。"

### 1.5 包内 `cordis.patch.yml`（逐字抄自文档）

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.zh.md>

**【文档】关键差异**（这条最容易踩坑）：

> "这个 patch 与你写过的 `--patch` overlay 一样，是一个 patch 条目的 YAML 数组；**区别是插件行按包名而不是相对源码路径引用这个包**，这样 Node 的模块解析才能找到已安装的代码"

对比：本地开发教程（`docs/user/develop/basic/index.zh.md`）里用**绝对路径**引用本地源码：

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

> "插件路径必须是绝对路径。patch 文件只贡献配置，不会改变 loader 解析模块路径时使用的 profile 目录。"

**并且必须用绝对路径**——见 §8.2 的取舍风险。

### 1.6 用户如何安装启用【文档】

```sh
dsh plugin --profile <name> <args...>
```

> "`dsh plugin --profile <name> <args...>` 在 profile 目录内转发给 pnpm，**因此所有 pnpm 子命令都可用**。"

具体用法（逐字抄自文档）：

```sh
# 从本地目录 / checkout 安装
dsh plugin --profile demo add ./hello-plugin

# 从 git 安装（需要 prepare 脚本 + 用户授权构建）
dsh plugin --profile demo add github:you/hello-plugin

# 从 tarball 安装
dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz

# 从已发布 npm 包安装（无需构建授权）
dsh plugin --profile demo add your-package

# 卸载（同时移除依赖和对应的层）
dsh plugin --profile demo remove dsh-hello-plugin

# 只验证层，不启动
dsh --profile demo --dump-config   # shows a "# == dsh-hello-plugin" layer
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.zh.md>

**【文档】`add` 对 profile 的副作用**：首次使用会初始化 profile（`@deepseek-ai/dsh-base` 作为第一个组合包），pnpm 链接该 checkout，而 `dsh` 因为包声明了 `dsh.bundle`，把它追加进 `dsh.profile.bundles`：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:/path/to/hello-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-hello-plugin"
      ]
    }
  }
}
```

来源：同上

**本机 profile 实际形态**（已用 read 工具读取，与文档一致）：

- `C:\Users\<user>\.dsh\profiles\web\package.json`：
  `{"name":"dsh-profile-web","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}`
- `C:\Users\<user>\.dsh\profiles\web\cordis.yml`：空顶层 YAML 数组（注释说不要改它）
- `C:\Users\<user>\.dsh\profiles\web\cordis.patch.yml`：顶层 YAML 数组，唯一元素是 `- id: ui-settings-general` / `name: "@deepseek-ai/dsh-client-ui-settings-general"` / `config: {welcomeNoticeVersion: 2026-08-13.1}`

**所以对"接微信"这个需求，安装命令应当是**：

```sh
dsh plugin --profile web add <你的包 spec>
```

### 1.7 配置层加载顺序【文档】

生效配置在空根之上按以下顺序**逐层**组合（后应用者按行胜出）：

1. profile 的 `dsh.profile.bundles` 列表所列的各个组合包 patch，按列表顺序
2. profile 自己的 `cordis.patch.yml`
3. home 级的 `$DSH_HOME/cordis.patch.yml`（各 profile 共享）
4. 每个 `--patch <path>` overlay，按 argv 顺序

> "后应用的层按行胜出，且 **patch 会替换目标行的整个 `config` 值，而不是深度合并各键**。"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.zh.md>

### 1.8 git 安装的构建门槛（重要警告）【文档】

> "git 安装拉取的是**源码，不是构建产物**：没有任何环节运行你的 `build` 脚本，因此 TypeScript 包到手时没有 `lib/` 输出，加载会失败。"

- 作者要提供自包含的 `prepare` 脚本
- 用户要在 `pnpm-workspace.yaml` 里加 `allowBuilds: { <pkg>: true }`
- **"请把这项授权视为允许该包的代码在安装时于你的机器上执行，且不在 agent 运行的任何沙箱之内。"**

**→ 你的方案（纯 JS）应当发布到 npm 或用 `pnpm pack` 出 tarball，二者都不需要任何构建权限。**

来源：同上

### 1.9 可选的展示元信息【文档】

`locale/en.json` + `locale/zh.json`：

```json
{
  "meta": {
    "title": "Workspace Tools",
    "description": "Tools for your workspace."
  }
}
```

并把以下条目合并进 `package.json`（保留已有的运行时 exports 和发布文件）：

```json
{
  "exports": {
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": ["locale/*.json"]
}
```

回退链：标题 `locale meta.title` → `package.json.name` → 完整 Cordis 插件名；描述 `locale meta.description` → `package.json.description` → 不显示。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/adding-a-package.zh.md>

**⚠️未验证**：`adding-a-package.zh.md` 是**仓库内 workspace 包**的清单（要求 `private: true`、`main: "lib/index.js"`、tsconfig 引用、`ctx.storage` 等 monorepo 约束），**不适用于第三方插件包**。第三方包请以 §1.3 的 `publish.zh.md` 样例为准。二者要求互相冲突（workspace 包要 `lib/index.js`，第三方纯 JS 包要 `index.js`），不要把 `adding-a-package.zh.md` 的 package.json 不变式照搬到第三方包上。

---

## 2. 服务端插件里能拿到什么

### 2.1 配置 `config`【文档】

导出一个 `Config`（Schemastery schema），`apply` 的第二个参数拿到校验后的值。原文是 TS，**纯 JS 等价写法**（去掉类型注解）：

```js
// 文档原文（TS）：
// import Schema from '@deepseek-ai/schemastery'
// export interface Config { greeting: string; maxRetries: number; verbose?: boolean }
// export const Config: Schema<Config> = Schema.object({...})
// export function apply(ctx: Context, config: Config) {...}

// 纯 JS 等价：
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx, config) {
  console.log(config.greeting) // User value or schema default.
}
```

带校验的写法（同样去注解）：

```js
export const Config = Schema.object({
  apiKey: Schema.string().required(),
  timeout: Schema.number().default(30000),
  mode: Schema.union(['fast', 'accurate']).default('fast'),
})
```

**关键约定【文档】**：

> "插件加载时，Cordis 会通过导出的 schema 校验配置，并填充未提供字段的默认值。**不要导出普通对象作为 `Config`**，因为它不满足 Cordis 要求的 Standard Schema 接口。"
> "**凡是不同部署可能需要采用不同值的参数，都必须定义为配置字段**。"
> "配置变更会触发插件热替换：修改 `cordis.yml` 中某个插件的 `config` 后，框架会卸载旧实例并加载新实例。"

在 profile 的 patch 行里传入 config：

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
      config:
        greeting: 'Hi there'
        maxRetries: 5
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/config.zh.md>

### 2.2 日志 `ctx.logger`【文档（源码）】

我直接读了 vendor 源码 `vendor/cordis/src/logger.ts`：

```ts
/** Callable `ctx.logger` service shape. */
export interface LoggerService extends Record<LoggerType, LoggerMethod> {
  (name?: string): Logger
}
```

- `LoggerType = 'error' | 'info' | 'warn' | 'debug'`
- `LoggerMethod = (format: any, ...param: any[]) => void` —— **printf 风格**
- 内置占位符 formatter：`%s`→String、`%d`/`%i`→Math.trunc(Number)、`%f`→Number、`%o`/`%O`→JSON.stringify、`%c`→''（吞掉）、`%C`→带颜色
- 直接用 `ctx.logger.info(...)` 会"用当前 fiber 派生的名字"打日志；`ctx.logger('my-name')` 创建一个具名 logger facade
- `ctx.logger.exporter(exporter)` 注册一个 sink，**是 effect-scoped 的**（`this.ctx.effect(...)`），返回 disposer
- 内置一个 ring buffer exporter：`bufferSize = 1000`

源码原文（关键部分）：

```ts
/**
 * Built-in logging service.
 *
 * Call `ctx.logger()` to create a named logger, or call `ctx.logger.info()`
 * directly to log with the current fiber-derived name.
 */
export class LoggerService {
  bufferSize = 1000
  ...
  exporter(exporter: Exporter) {
    return this.ctx.effect(() => {
      const id = ++this._snExporter
      this.exporters.set(id, exporter)
      return () => this.exporters.delete(id)
    }, 'ctx.logger.exporter()')
  }
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/cordis/src/logger.ts>
（同时 `docs/cordis-api/inherited.md` 把 `ctx.logger` 列为继承的 `ctx` 成员："Ambient handles onto the running context graph"）

**纯 JS 用法**：

```js
export function apply(ctx, config) {
  const logger = ctx.logger('dsh-wxbot')
  logger.info('started, greeting=%s', config.greeting)
  logger.error(new Error('something broke'))
}
```

### 2.3 持久化：`ctx.storage` / `ctx.storageDomain`【文档】

DSH 的通用 KV 持久化是**可选能力 seam**，只有 profile 挂载了它才存在：

- 枢纽（hub）+ Service Definition：`@deepseek-ai/dsh-storage`，服务键 `ctx.storage`
- Service Provider：`@deepseek-ai/dsh-storage-json`（注册为 `json`）、`@deepseek-ai/dsh-storage-sqlite`（注册为 `sqlite`）
- Consumer 数据形式：`@deepseek-ai/dsh-storage-domain`，`ctx.storageDomain`，也可经 `ctx.storage.domain` 访问

> "枢纽自身不做任何 IO：后端拥有介质，数据形式拥有语义，产品包绝不直接触碰后端。"

**声明一个领域**（TS 原文，zod schema）：

```ts
interface DomainSpec {
  readonly name: string          // 必须匹配 UNIT_NAME_RE
  readonly version: number
  readonly layout?: 'single' | 'per-record'
  readonly compatibleVersions?: readonly number[]
  readonly invalidRecords?: 'backup-and-skip'
  readonly global?: DomainGlobalSpec<unknown>
  readonly tables: Record<string, DomainTableSpec>
}
```

**打开领域**：

```ts
abstract open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
```

`Domain<S>` 有 `name`、`global`、`table(name)`、`close()`。
`KvTable` 暴露 `get`/`entries`/`keys`/`size`（**同步读**）与 `put`/`delete`/`update`。
每次持久写入后发出 `domain/changed` 事件。

> "`update(key, fn)` 在其写链 slot 上是一次原子的读-改-写（键缺失时拒绝 `missing-key`）"
> "返回的记录就是存储的对象本身，不是副本——请经 `put`/`update` 整体替换，绝不要就地修改。"
> "Lifecycle: the **CALLER** owns the returned handle and closes it via `Domain.close()`（typically as its own `ctx.effect` disposer）"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/storage.zh.md>

**⚠️未验证 / 重要提醒**：存储是**可选能力**。文档明确说它"是一项可选能力，不属于 agent loop 主干"。**我没有确认 `web` profile 是否挂载 `ctx.storage` / `ctx.storageDomain`。** 如果没挂载，`ctx.storageDomain` 会是 `undefined`。建议：
- 先去 `dsh --profile web --dump-config` 里找 `dsh-storage*` / `dsh-storage-domain` 行；
- 或者干脆**不依赖 storage**：用 Node 内置 `node:fs` 自己写一个 JSON 文件到 `$DSH_HOME` 或会话 `cwd` 下（这是纯 JS 插件完全可做的，最稳、零依赖）。
- 【推断】考虑到"微信用户 → 会话 id"的映射本质就是一张小 map，用 `node:fs` 落一个 JSON 文件比引入 storage seam 更简单可靠。

### 2.4 生命周期【文档】

**Fiber 状态机**：

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

| 状态 | 含义 |
|---|---|
| PENDING | 已声明，但所需依赖未就绪 |
| LOADING | 依赖就绪，正在执行 `apply` |
| ACTIVE | 插件运行中 |
| FAILED | `apply` 抛出异常 |
| UNLOADING | 插件正在卸载并释放资源 |
| DISPOSED | 已完全卸载 |

**依赖驱动的加载**：

> "声明了 `inject` 的插件会等待所有必需服务就绪 … **如果依赖的服务消失（例如提供方被替换时），插件会被自动卸载（ACTIVE → DISPOSED），待服务恢复后重新加载。**"

**自动清理**（这条是本文第 5 问的答案基础）：

> "通过 `ctx` 做的任何注册，在插件卸载时都会自动撤销 … 以下操作都会被自动追踪和清理：
> - `ctx.on(event, handler)` — 事件监听
> - `ctx.tools.register(tool)` — 工具注册
> - `ctx.llm.registerAdapter(names, adapter)` — LLM 适配器注册
> - `ctx.effect(() => cleanup)` — 自定义资源"

**dispose 顺序（关键坑）**：

> "插件卸载时，处置器按注册顺序的**逆序**开始调用，但**多个异步处置器会并发执行，不保证逐个完成**。存在顺序依赖的清理步骤必须放进**同一个 `ctx.effect()`** 返回的处置器中，由该处置器负责串行等待。"

**手动提前终止**：

```js
const fiber = ctx.plugin(myPlugin)
await fiber.dispose()
```

> "`dispose` 保证：1. 该插件拥有的所有注册均被移除；2. 它的子插件也被递归卸载；3. 返回的 Promise 会在所有异步清理完成后兑现"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/framework/index.zh.md>

**继承的 `ctx` 成员完整清单【文档】**（来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/inherited.md>）

- `ctx.on / ctx.once` — 注册事件监听（disposable）
- `ctx.emit / ctx.parallel / ctx.serial / ctx.bail / ctx.waterfall` — 分发事件
- `ctx.plugin / ctx.inject` — 加载插件 / 声明必需服务
- `ctx.effect` — 注册与 fiber 绑定的可释放副作用
- `ctx.get / ctx.set / ctx.provide / ctx.accessor / ctx.mixin` — 低层服务存储访问与绑定
- `ctx.extend / ctx.isolate / ctx.intercept` — 派生子上下文
- `ctx.root / ctx.fiber / ctx.registry / ctx.reflect / ctx.events / ctx.logger` — 运行中 context graph 的环境句柄
- `ctx.timer (+ interval / timeout / throttle / debounce)` — **可释放的定时器辅助方法**（`timer` 键在运行时提供，四个辅助方法直接 mixin 到 ctx 上）
- `ctx.loader` — 启动 app 的配置 Loader

其中 `ctx.timer.interval(...)` **是文档记载的、自带 dispose 的定时器** —— 对第 5 问很有用。

---

## 3. ★ 消息注入与取回（核心问题）

### 3.1 服务名与方法签名【文档】

**注册表服务：`ctx.agents`（类型 `AgentRegistry`，包 `@deepseek-ai/dsh-agent`）**

创建/查找：

```ts
/**
 * Look up a live agent.
 * @param id - the shared agent/session id to look up.
 * @returns the agent, or undefined when no live agent has that id.
 */
get(id: SessionId): Agent | undefined

/**
 * Create and publish a new agent through the registered factory.
 * Distinct from {@link register} (which records an already-constructed
 * agent): this constructs the agent and its session. Rejects if no factory is
 * registered or creation/setup fails. The resolved {@link AgentHandle} lets
 * the owner tear down exactly this agent.
 * @param options - shared identity, optional live parent, session seed/metadata, and agent options.
 * @returns the handle after setup, rollback-covered publication, and loop start complete.
 */
async create(options: CreateAgentOptions): Promise<AgentHandle>

/**
 * Load a persisted session and resume an agent on it through the registered
 * factory.
 * @param options - persisted identity, optional live parent, configuration, and setup.
 * @returns the handle after setup, rollback-covered publication, and loop start complete.
 */
async resume(options: ResumeAgentOptions): Promise<AgentHandle>

/** All live agents, in registration order. */
list(): Agent[]
/** All live top-level agents in registration order. */
roots(): Agent[]
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.zh.md>（生成区块 `ctx.agents` — `AgentRegistry`）；type-equiv 块源码指向 `packages/core/agent/src/index.ts`

**`ctx.agents.get(sessionId)` 在 sessionId 不存在时返回 `undefined`** —— 这是原文字面：

> "Look up a live agent. @param id - the shared agent/session id to look up. **@returns the agent, or undefined when no live agent has that id.**"

来源：同上

**`Agent` 接口（公开的实时 agent 句柄）** —— 逐字抄自文档的 type-equiv 块：

```ts
/** Public live-agent handle; the runtime face augments its live capabilities. */
interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
  /** The provider route and model this agent's requests use. */
  readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /** Agent-owned access to durable pending work. */
  readonly inbox: Inbox
  /** The current lifecycle state, mirrored on every `agent/status` transition. */
  readonly status: AgentStatus
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * Clear queued and steering work — unless `keepInbox` — and abort the active
   * turn or between-turn task. The first cause wins for that activity. With no
   * active activity, cancellation is a no-op and does not arm later work.
   * @param cause - the stable caller intent carried by the active operation signal.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause: AgentCancelCause, options?: CancelOptions): void

  /**
   * Resolve after the current whole-agent activity reaches quiescence. This
   * follows replacement work started before the observed driver retires,
   * but does not identify the settlement of any particular message.
   * @returns fulfillment after no active driver or maintenance task remains.
   */
  whenIdle(): Promise<void>

  /**
   * Route identified input to an inbox boundary and optionally wake the driver.
   */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void

  /**
   * Queue an ordinary follow-up turn and wake the driver. The item becomes the
   * sole ordinary message of its own turn.
   * @param message - identified prompt content and the source that supplied it.
   */
  followup(message: UserMessage): void

  /**
   * Submit steering for the nearest step. An idle driver starts a turn;
   * a running driver consumes it at its next step boundary.
   */
  steer(message: UserMessage): void

  /**
   * Queue model-facing context for the next pre-step without waking the
   * driver.
   */
  inject(message: UserMessage): void
}
```

`AgentStatus = 'idle' | 'running'`；`InboxTarget = 'next-turn' | 'next-step'`。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.zh.md>

**`AgentHandle`（编程式创建返回的属主句柄）** —— 逐字：

```ts
/**
 * An owned agent plus its disposer, returned by {@link AgentRegistry.create} /
 * {@link AgentRegistry.resume}. The disposer is a CAPABILITY: among consumers,
 * only the holder can tear this agent down. ...
 * `dispose()` stops the loop, awaits its exit, unregisters the agent, removes
 * its session from the store, and finally unwinds its scoped world.
 *
 * `ctx.agents.get(id)` still returns a bare {@link Agent} — the handle is
 * exposed only to the consumer owner that created it; ...
 */
interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}
```

> "**`ctx.agents.get(id)` 仍返回裸 `Agent`** —— 句柄只暴露给创建它的消费方。"

来源：同上

### 3.2 ★ 把外部消息送进会话：真实调用样例

**样例 A（逐字抄自官方实操手册 `extension-cookbook.zh.md`，UI 插件章节）** —— 这是**最有说服力的、真实存在的**注入样例：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare function render(text: string): void
declare function onUserInput(handler: (text: string) => void): void

export const name = 'my-ui'
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('agent/assistant-stream', ({ frame }) => {
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      render(frame.chunk.text)
    }
  })
  onUserInput(text => ctx.agents.get(brandString<SessionId>('client-session'))?.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })))
}
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/extension-cookbook.zh.md>

**样例 B（逐字抄自 `packages/core/agent/README.zh.md`，纯 fake-handle 风格）**：

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
})
// later:
await handle.dispose()   // stops the loop, unregisters, removes the session, unwinds the scope
```

```text
handle.agent.followup({
  content: [{ type: 'text', text: 'Summarize this workspace.' }],
  source: { kind: 'user' },
})
handle.agent.steer({
  content: [{ type: 'text', text: 'Focus on the tests.' }],
  source: { kind: 'plugin', plugin: 'my-plugin' },
})
await handle.agent.whenIdle()
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent/README.zh.md>

**注意**：`create()` 那段在文档里放在 `text` 代码块（不是 `ts`）里，且 `sessionId` 是未定义的自由变量——它是**示意**而非可直接运行代码。

**【推断】纯 JS 版本**：`brandString` 只施加**仅编译期存在**的品牌（"`brandString<T>()` 应用仅编译期存在的字符串品牌"，来源 <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.zh.md>），所以**纯 JS 里直接传字符串即可**，不需要 `brandString`：

```js
// 纯 JS：直接用字符串 session id
const agent = ctx.agents.get('wechat-user-abc123')
```

`brandString` 从 `@deepseek-ai/dsh-brand` 导出（文档 import 语句为 `import { brandString } from '@deepseek-ai/dsh-brand'`）。

### 3.3 ★ 取回助手回复文本：真实调用样例

**方式 1：监听持久 `session/event`，展开 `assistant/message` 的内嵌 stream（推荐）**

**逐字抄自 `extension-cookbook.zh.md` 的"外部协议驱动"章节**：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'

export const name = 'my-protocol-bridge'
export const inject = ['agents', 'sessions', 'sessionPersistence']

export function apply(ctx: Context) {
  // Publish every committed Assistant text delta to the client.
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      for (const { chunk } of expandAssistantStream(event.data.stream)) {
        if (chunk.type === 'text-delta') {
          // sendToClient({ kind: 'message_chunk', text: chunk.text })
        }
      }
    }
  })
  // Inbound "prompt": create/resume an agent, feed it, and return its enqueue receipt.
  // Whole-agent status is a separate notification; no turn end belongs to this prompt.
  // Teardown reaches quiescence via AgentHandle.dispose() (stop + await exit).
}
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/extension-cookbook.zh.md>

**`session/event` 的确切签名**（逐字抄自生成区块）：

```ts
/**
 * Post-commit, fire-and-forget append feed. The listener snapshot resolves
 * before the log push, but callbacks run after it; observer failures are
 * logged and contained without making the committed append fail. Scope-filtered
 * dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only events
 * from sessions entered through that agent's context.
 * @param session - the session whose log grew.
 * @param event - the appended event, exactly as recorded.
 * @mode emit
 */
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.zh.md>

**方式 2：监听瞬态 `agent/assistant-stream`（实时 token，非持久）**

生成区块原文：

```ts
/**
 * Process-local assistant-stream publication. Chunk frames are transient;
 * the loop appends one final v2 `assistant/message` or `assistant/attempt`
 * with the same stream before a committed end frame.
 * @param payload.agent - the agent whose attempt produced the frame.
 * @param payload.frame - one ordered start, chunk, or end publication.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void
```

`AssistantStreamFrame` 是三种之一：

```ts
type AssistantStreamFrame =
  | { readonly type: 'start'; readonly attemptId: LlmAttemptId; readonly revision: number; readonly turn: number; readonly step: number }
  | { readonly type: 'chunk'; readonly attemptId: LlmAttemptId; readonly revision: number; readonly index: number; readonly time: number; readonly chunk: StreamChunk }
  | { readonly type: 'end'; readonly attemptId: LlmAttemptId; readonly revision: number; readonly index: number;
      readonly outcome:
        | { readonly kind: 'committed'; readonly eventType: 'assistant/message' | 'assistant/attempt'; readonly seq: SessionSeq }
        | { readonly kind: 'abandoned' } }
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.zh.md>

`StreamChunk` 是**封闭**判别联合：

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/llm-streaming.zh.md>

### 3.4 `data.stream` 的结构【文档】

`assistant/message` 事件的 payload（逐字抄自 `SessionEventMap`）：

```ts
'assistant/message': {
  turn: number
  step: number
  message: AssistantMessage
  /** Exact timed model stream, compacted without joining delta boundaries. */
  stream: AssistantStreamRecord[]
  usage?: TokenUsage
  interrupted?: true
}
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.zh.md>

`AssistantStreamRecord[]` 的含义（逐字）：

> "`AssistantStreamAccumulator` 把每个 `StreamChunk` 与其原始安全整数时间戳配对，并生成 `AssistantStreamRecord[]`。**同一 block 的连续 text、reasoning 或 tool argument delta 会变成一个 record，使用 `time0`、精确时间戳间隔和每个原始 delta 对应的一个数组成员**；其他 chunk 保留为带时间戳的 raw record。该表示会移除重复 event envelope，但不会合并 token 边界，也不会丢弃 terminal、usage、block、failure 或 replay 事实。"
>
> "`snapshot()` 返回分离且不可变的 stream。**`expandAssistantStream()` 会严格检查 record key、成员数、index、时间戳、tool-call identity 与无损 JSON，再重建精确的带时间 chunk 序列。**"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/llm-streaming.zh.md>

**【文档】更省事的现成 reader**（同页列出，用于"一次扫描回答问题"）：

> "记录级读取器（`assistantStreamFirstTokenTime`、`assistantStreamHasVisibleContent`、`assistantStreamHasVisibleText`、`lastAssistantStreamChunk`、`assistantStreamChunks`、**`joinAssistantStreamText`**、`assembleAssistantStream` 以及按 run 的 `runFirstTokenTime` 与 `runFirstVisibleTime`）以提前退出在一次扫描内回答消费方问题"

**`joinAssistantStreamText` 看名字正是"把流拼成完整文本"的现成函数。**

**⚠️未验证**：文档**没有明写** `joinAssistantStreamText` / `expandAssistantStream` 的 import 路径。`expandAssistantStream` 的 import 语句在 cookbook 里是 `import { expandAssistantStream } from '@deepseek-ai/dsh-llm'`（【文档】）；`joinAssistantStreamText` 与它在同一页、同一包的记录级读取器清单里，**【推断】也应从 `@deepseek-ai/dsh-llm` 导出**，但请在 `node -e "import('@deepseek-ai/dsh-llm').then(m=>console.log(Object.keys(m)))"` 里实测确认。

### 3.5 确切的 import 来源汇总

| 符号 | 包 | 证据 |
|---|---|---|
| `createUserMessage` | `@deepseek-ai/dsh-llm` | 【文档】cookbook 原文 `import { createUserMessage } from '@deepseek-ai/dsh-llm'` |
| `expandAssistantStream` | `@deepseek-ai/dsh-llm` | 【文档】cookbook 原文 `import { expandAssistantStream } from '@deepseek-ai/dsh-llm'` |
| `joinAssistantStreamText` | `@deepseek-ai/dsh-llm` | 【推断】同页同包记录级读取器清单，import 路径未明写 ⚠️ |
| `brandString` | `@deepseek-ai/dsh-brand` | 【文档】cookbook 原文 `import { brandString } from '@deepseek-ai/dsh-brand'` |
| `SessionId`（类型） | `@deepseek-ai/dsh-session` | 【文档】cookbook 原文 `import type { SessionId } from '@deepseek-ai/dsh-session'` |
| `Context`（类型） | `@deepseek-ai/cordis` | 【文档】cookbook 原文 `import type { Context } from '@deepseek-ai/cordis'` |
| `Schema` | `@deepseek-ai/schemastery` | 【文档】config 教程原文 `import Schema from '@deepseek-ai/schemastery'` |
| `defineTool` | `@deepseek-ai/dsh-tools` | 【文档】cookbook 提到"带注解的 `defineTool` 示例"，源码路径 `@deepseek-ai/dsh-tools` |

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/extension-cookbook.zh.md> 与 <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/config.zh.md>

**⚠️未验证 —— 最重要的实操风险**：`@deepseek-ai/dsh-llm` 是否是第三方插件可以 `import` 的依赖？文档说（`publish.zh.md`）：

> "与 harness 自身的包一样，**需要与宿主共享实例的 dsh 包同时声明在 `peerDependencies` 与 `devDependencies` 中**。"

**【推断】** 所以你的 `package.json` 里对 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 都要写进 `peerDependencies`（并镜像到 `devDependencies`）。**但是**：你的包是免构建的纯 JS 且不打算装 node_modules，那么 `import` 能否在运行时解析取决于 profile 的 `node_modules` 里有没有这些包。文档说"运行中 dsh 的 runtime resolution 已包含的 peer 使用安装中的副本"，暗示宿主安装里已有这些包。

**务必实测**：`dsh plugin --profile web add <spec>` 后，在插件里 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`，看它能否解析。若不能，退路是**不 import `dsh-llm`**，自己构造消息对象：

```js
// 退路：手写 UserMessage（字段来自 SessionEventMap 的 UserMessage 定义）
// 【⚠️未验证】message 除 role/content/source 外是否需要 id 等字段未确认。
```

`UserMessage` 的文档定义只给了：

```ts
/** A user-role specialization of the shared message representation. */
interface UserMessage extends MessageBase {
  readonly role: 'user'
}
```

且 `MessageSourceMap` 的 `user` 分支是 `user: { kind: 'user' }`。**⚠️未验证**：`MessageBase` 的完整字段（是否必填 `id`）文档未展开，`createUserMessage` 会自动生成 id，所以**强烈建议用 `createUserMessage` 而不是手写**。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/llm-streaming.zh.md> 与 <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.zh.md>

### 3.6 ⚠️ 关键语义警告：`followup()` 不返回回复

**这是最容易写错的地方，文档反复强调。**

`docs/defensive-patterns.md` 原文：

> "## Async state is not synchronous state
> `agent.followup()` has no per-message completion or result; a background job's completion races turn boundaries; `reader.close()` fires for both EOF and disposal. **Never treat `agent/status` or `whenIdle()` as the result of one follow-up**: several queued follow-ups, steering, and injected work may share one `running` interval, while cancellation or disposal can discard unstarted items. **An automation caller that truly owns a run must define its interval explicitly—for example, from its message's durable inbox receipt through the next whole-agent `idle`**—and describe any selected output as interval-wide rather than causally attributed to that message. The guard cuts both ways: if the awaited transition can never occur, the wait hangs, so handle the 'nothing to wait for' branch explicitly."

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/defensive-patterns.md>

`core.zh.md` 原文：

> "`followup()` 不返回句柄：其 `MessageId` 标识的是持久的 inbox 插入、认领与丢弃事实，而非之后的助手输出或轮次结束。`whenIdle()` 观察的是整个 agent，因此只有当调用方**明确拥有从回执到空闲的这段区间**时，才能把它称为一次 run"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.zh.md>

**→ 实践结论【推断，有文档强依据】**：取回复的正确做法是**事件驱动**，不要靠 `await whenIdle()`：

1. 先订阅 `ctx.on('session/event', (session, event) => ...)`
2. 记下 `lastAssistantText`，在 `event.type === 'assistant/message'` 时用 `expandAssistantStream(event.data.stream)`（或 `joinAssistantStreamText`）取文本
3. 以 `event.type === 'turn/end'` 作为**这一轮结束**的信号，再把累积的文本发回微信
4. 用 `session.id` 过滤，只处理你关心的那个会话（每个微信用户一个 session）

`turn/end` 的 payload 是 `{ turn: number; reason: TurnEndReason }`，`reason` 的判别字段是 `data.reason.kind`（Python SDK 的文档明确说 `finish_reason` "是最后一个根会话 `turn/end` 的 `kind`，例如 `completed`、`max-tokens` 或 `error`；**缺少字符串 `data.reason.kind` 的 `turn/end` 违反协议，并会抛出 `SdkProtocolError`**"）。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.zh.md>、<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/python/sdk/README.zh.md>

**【⚠️未验证】** `TurnEndReasonMap` 的完整成员列表（我只确认了 `completed`、`max-tokens`、`error`、`aborted`、`interrupted` 这几个出现在文档里）。

---

## 4. 长期后台任务 + 干净停止

### 4.1 官方一等公民方案：`ctx.jobs`【文档】

DSH 有专门的后台任务运行时。**这是"不停长轮询的循环"的正解**，因为它把生命周期、取消、输出环都管了。

`JobSpec`（逐字）：

```ts
interface JobSpec {
  /** Producer kind — also the id prefix (`bash`, `subagent`, …). */
  kind: JobKind
  /** One-line model-facing label (the command; the delegation description). */
  label: string
  /**
   * Owning session. Access is fenced by it, and the owner's live Agent must be
   * the one currently registered under that id: its disposal cancels and
   * awaits the job. Omitting the owner creates an unowned job, open to any
   * caller until service disposal.
   */
  owner?: SessionId
  outputLimitBytes?: number
  output?: readonly JobOutputSource[]
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once with the job's producer face; a throw leaves nothing registered (the
   * spent ordinal is skipped), and the producer must clean up any partially
   * started resources.
   * @param job - the issued id plus the ring append and progress writers.
   */
  run(job: JobHandle): JobHooks
}
```

```ts
interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually settle
   * {@link done}; throws propagate.
   */
  cancel(reason?: string): void
  /**
   * Resolves after the producer releases its resources, not merely when work
   * finishes. Must not reject; the runtime converts a rejection to `failed`.
   */
  done: Promise<JobOutcome>
}
```

`JobKindMap` 目前只有 `{ bash: 'bash'; subagent: 'subagent' }`，但它是**可合并扩展的 map**："Plugins extend this map by declaration merging; the registry treats every value as an opaque id namespace."

注册表（`ctx.jobs`，抽象 seam `JobRegistry`）的关键方法：`start(spec): JobId`、`list(caller?)`、`get(id, caller?)`、`read(id, caller?)`、`readAt(id, from, caller?)`、`kill(id, caller?, reason?)`、`wait(id, timeoutMs, caller?, signal?)`、`remove(id, caller?)`、`attachController(name)`。

> "Owner and service disposal cancel live work and await compliant producers; a throwing teardown cancel force-fails only the record."
> "**start refuses work while no attached job controller serves the spec's owner**, so a producer cannot start work that owner cannot collect or stop."

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/jobs.zh.md>

**【推断】注意事项**：`start` 需要有一个 **attached job controller** 服务于该 owner，否则会拒绝。"The `LocalJobRegistry` is the process-local Service Provider." 我没确认 `web` profile 是否挂了 `dsh-jobs-local` + controller。**⚠️未验证**。如果没挂，`ctx.jobs` 是 `undefined`，就要走 4.2。

### 4.2 保底方案：`ctx.effect()` + AbortController【文档】

官方第一个教程给的**逐字**样例（TS，纯 JS 去掉注解）：

```ts
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log('heartbeat')
    }, 5000)

    // The returned function runs when the plugin unloads.
    return () => clearInterval(timer)
  })
}
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/index.zh.md>

**对"长轮询循环"的正确改造（这是我要给的写法）** —— 纯 JS：

```js
export const name = 'dsh-wxbot'
export const inject = ['agents']

export function apply(ctx) {
  // 1) 一个 AbortController 代表这个插件的全部后台工作
  const ac = new AbortController()

  // 2) 长轮询循环写成一个 async 函数，永不 throw 到顶层
  async function pollLoop(signal) {
    while (!signal.aborted) {
      try {
        const updates = await wechatGetUpdates(signal) // 传入 signal，能被打断
        for (const u of updates) await handleOne(ctx, u)
      } catch (err) {
        if (signal.aborted) break          // 卸载导致的 abort 是预期路径，静默退出
        ctx.logger('dsh-wxbot').warn('poll failed: %s', err?.message ?? err)
        await sleep(2000, signal)          // 退避；sleep 也必须响应 abort
      }
    }
  }

  // 3) 用 ctx.effect 把它挂到 fiber 生命周期上
  ctx.effect(() => {
    // 关键：不要 await / 不要让这个 Promise 逃逸成 unhandled rejection
    const running = pollLoop(ac.signal).catch(err => {
      ctx.logger('dsh-wxbot').error(err)
    })

    return async () => {
      ac.abort()          // 通知循环停止
      await running       // 等它真正退出（"dispose must reach quiescence"）
    }
  })
}

// 可被 abort 打断的 sleep
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}
```

**为什么这样写（每条都有文档依据）**：

1. **卸载自动触发**：`ctx.effect(() => cleanup)` 的返回值在插件卸载时被调用（【文档】"The returned function runs when the plugin unloads."，"`ctx.effect(() => cleanup)` — 自定义资源"被自动追踪和清理）。
2. **必须 await 收敛**：`docs/defensive-patterns.md` 原文 —— "## Dispose must reach quiescence, not just request it / A teardown that issues kills/aborts but returns before the work stops leaves orphans. **Make cleanup async and await the children's exit (kill → await `done`)**, and close listener/notification registries BEFORE killing so late completions stay silent." 来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/defensive-patterns.md>
3. **同一个 effect 内串行**：`framework/index.zh.md` 原文 —— "多个异步处置器会并发执行，不保证逐个完成。**存在顺序依赖的清理步骤必须放进同一个 `ctx.effect()` 返回的处置器中**"。所以 `ac.abort()` 和 `await running` 必须在**同一个** effect 里。
4. **绝不产生游离 rejection**：`defensive-patterns.md` 还有 "## Contain callback exceptions in the dispatcher / A user-supplied listener that throws must not reject the promise it runs inside or starve the listeners after it. Wrap the dispatch loop in try/catch and log; one bad subscriber never breaks core lifecycle." —— 同理，**你自己的后台循环必须自己 try/catch 到底**，让返回的 Promise 只有 resolved 状态。

**【⚠️未验证】** 你提到"DSH 对游离 unhandled rejection 是致命的"。我**没有找到**任何文档明说 unhandled rejection 会杀死进程。我找到的是上引的 defensive-patterns 几条规则（它们强烈暗示"游离的异步失败是真实 bug 类别"，但没有说进程会死）。

**→ 无论是否致命，上面的写法都是必须的**：把循环包成永不 reject 的 Promise，并在 effect disposer 里 await 它。

【文档】另外可用的、自带 dispose 的定时器：`ctx.timer (+ interval / timeout / throttle / debounce)` —— "Disposable timer helpers"。来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/inherited.md>

### 4.3 `ctx.on('dispose')` 存在吗？【⚠️未验证】

我**没有找到** `ctx.on('dispose', ...)` 这种写法。文档里记载的卸载钩子是：
- `ctx.effect(() => cleanup)`（推荐，被自动追踪）
- `fiber.dispose()`（主动提前终止）
- 类形式插件的 `Service` 生命周期

**→ 用 `ctx.effect()`，不要用 `ctx.on('dispose')`。**

---

## 5. 会话创建、持久化与"微信用户 → 会话"映射

### 5.1 `ctx.agents.get()` 不存在时怎么办【文档】

返回 `undefined`（原文见 §3.1）。**按需创建**用 `ctx.agents.create(...)`。

**`CreateAgentOptions` 的确切字段**：文档**没有**完整展开这个 interface。原文描述（逐字）：

> "`CreateAgentOptions` 携带共享标识以及新 agent 发布前所需的一切：可选的存活 `parentAgent`、会话元数据（`meta`——已校验的 `cwd`、fork 谱系、`isSeeded` 标记、来源分类、委派深度与 `agentPreset`）、同级字段 `inheritedEventCount` 所表示的精确 fork cut、可选的 `seed` 回放前缀、按 agent 的 `AgentOptions`、仅创建期有效的取消 `signal`，以及 `setup`。"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.zh.md>

**最具体的一份可读样例**（来自 agent 包 README，示意代码）：

```js
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
})
await handle.dispose()
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent/README.zh.md>

**【文档】`AgentOptions` 完整字段**（逐字）：

```ts
/** Merge-extensible agent creation options. Persona belongs to system-prompt sections. */
interface AgentOptions {
  /** Provider route (must have a registered adapter at call time). */
  provider?: string
  /** Model id interpreted by the selected provider adapter. */
  model?: string
  /** Adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: ReasoningEffortId
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number
}
```

注意：`AgentOptions` 的 `provider` 是**可选**的，但 —— "在 `agent/request` 之后，分发要求 `provider` 与 `model` 都存在。"（来源同 core.zh.md）

**【文档】`CreateSessionOptions`（`ctx.sessions.create` 用）完整字段**：

```ts
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  readonly inheritedEventCount?: SessionLogOffset
  /** Storage metadata read once before publication. */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
}
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/persistence.zh.md>

### 5.2 会话与 agent 的创建关系【文档】

这是文档里**最接近直接回答"如何按需创建会话"** 的一句话：

> "因此，回放/fork 的调用方式为 **`ctx.agents.create({ sessionId, seed, meta })`** —— fork 还会随 `meta.isSeeded: true` 提供 `inheritedEventCount`，且**只有经 agent-loop 发布的会话才会持久化**，且循环会在发布之前通过新会话的写句柄存储 seed；将一个*持久化*会话恢复为活跃 agent 的调用方式为 **`ctx.agents.resume({ resumeSessionId })`**。"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/persistence.zh.md>

**三个层次的服务，别混用【文档】**：

| 层次 | 服务 | 方法 | 用途 |
|---|---|---|---|
| 只有会话（无 agent） | `ctx.sessions`（`SessionStore`） | `create(id?, options?)` | 纯内存事件日志，**不做持久化** |
| agent 工厂（底层） | `ctx.agentLoop`（`AgentLoop`） | `createAgent(ownerCtx, options)` / `resume(ownerCtx, options)` / `create(id, options, meta)` | 直接驱动；**扩展插件不该依赖它** |
| agent 注册表（**你要用的**） | `ctx.agents`（`AgentRegistry`） | `create(options)` / `resume(options)` / `get(id)` | 委托给已注册的 factory |

`ctx.sessions` 的持久化免责原文：

> "Persistence is intentionally not implemented here — the agent lifecycle attaches a session-log writer to each published session's write handle; **a session published outside that lifecycle persists nothing.**"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.zh.md>

**并且【文档】明确说扩展插件不该依赖 agent-loop**：

> "`agent-loop` 是公开 `Agent` 约定的唯一具体实现，放在这里因为它是 harness 的默认产品循环 … **扩展插件依赖 `agent`——包括需要发起 Agent 时——而绝不直接依赖 `agent-loop`**，因此循环保持可替换。"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.zh.md>

**→ 【推断】按需创建会话的正确调用是 `ctx.agents.create({ sessionId, agentOptions: {...} })`。**

### 5.3 持久化【文档】

持久化是一个**能力 seam**：

- 抽象服务：`@deepseek-ai/dsh-session-persistence`，服务键 **`ctx.sessionPersistence`**（类型 `SessionPersistence`）
- 随产品交付的 provider：**`@deepseek-ai/dsh-session-persistence-jsonl`**（"逐会话仅追加的逻辑 JSONL 日志，默认存储为带 checksum 的连续 Zstandard frame，也可配置为原始行；具备崩溃安全的原子实体化、逐批 `fsync` 的 append，以及在第一次新 append 之前截断撕裂尾部。"）

`SessionPersistence`（抽象）方法：`create(header, options?)`、`open(id, access, options?)`、`flush()`、`stat(id, options?)`、`list(options?)`。

`SessionHeader` 完整字段（逐字）：

```ts
interface SessionHeader {
  readonly version: typeof SESSION_FORMAT_VERSION
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: SessionId
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}
```

> "**只有经 agent-loop 发布的会话才会持久化**"（见 §5.2 引用）

【文档】持久化是**可选能力**："它是一项可选能力，不属于 agent loop 主干"（说的是 storage；persistence 类似地是 seam）。但 `dsh-base` README 承诺所有基于 base 的 profile 都有 "**可跨重启存活的持久会话**"：

> "开箱即用，基于本核心构建的每个 profile 都提供：… **可跨重启存活的持久会话** …"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/bundle/base/README.zh.md>

**→ 【推断】`web` profile 基于 `dsh-base`，所以 `ctx.sessionPersistence` 应当已挂载，会话会落盘。但这需要实测确认。**

**落盘位置【⚠️未验证】**：我没有确认默认目录。文档提到 `<dsh_home>/sessions` 是在讲 `sdk-minimal` profile（"会话持久化 | `<dsh_home>/sessions` 下的未压缩 JSONL"），**不能**推断 `web` profile 相同。JSONL provider 的 `SessionLocation` 描述是 "JSONL 提供其**项目/会话目录**内 transcript 的绝对路径"，暗示是**按项目**分目录的，不是单一扁平目录。来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/persistence.zh.md>

**→ 实操建议**：不要猜目录，用 `ctx.sessionPersistence.list()` 或 `stat(id)` 去问。

### 5.4 会话 id 策略【文档】

`ctx.sessions.create(id?, options?)`：

> "@param id - the session id; **omitted, the store mints `session-<n>`**."

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.zh.md>

**id 字符集/长度校验 —— ⚠️未验证**：我没找到 `SessionId` 的校验规则。`core.zh.md` 只说：

> "两个核心 ID 是 `ToolCallId` … 和 `SessionId`（活跃 agent 与持久会话共享的标识；dsh-session）。"

以及

> "构造使用共享 `brandString<T>()` helper 或所属方自定义的校验工厂；比较、日志记录和 JSON 行为与普通字符串相同。"

**→ 【推断】** `SessionId` 在运行时是普通字符串前缀品牌，但持久化层可能有额外校验（storage 的 `UNIT_NAME_RE` 类约束）。**给微信用户生成 id 时请用保守字符集**（`[a-z0-9_-]`），例如 `wechat-<md5(openid)>`，避免中文、`/`、`:`、空格。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.zh.md>

**【文档】"一个微信用户一个会话"是否有官方先例** —— 有，而且是**一等公民机制**：

`docs/subsystems/webhook.zh.md` 描述的 Webhook runtime 就是这个模式：

> "Webhook 子系统会把**已通过身份验证的外部交付转换为可选的普通根 Session**。"
> "`WebhookSessionRequest` 要求绝对 `workspacePath`、标题、文本提示词、agent preset 与 permission preset。可选 `model` 会指定明确的提供方／模型路由与可选输出 token 上限。"
> "非 `null` 结果会在异步预检前生成快照。runtime 会验证 permission 与 agent preset，解析或创建规范 Workspace，**创建 Session cwd 等于 Workspace 路径的 Agent**，在发布前挂载所选 agent preset，并在应用权限、标题与初始 follow-up 前持久附加 Session。"
> "follow-up 是普通持久 user-role 消息，使用 **`source.kind: "webhook"`**，并携带提供方／来源／交付／规则来源信息。"

```ts
/**
 * Register one trusted programmatic rule.
 * @param rule - unique id, provider kind, and arbitrary callback.
 * @returns awaitable effect disposer that aborts and drains this rule's active callbacks.
 */
register<K extends string>(rule: WebhookRule<K>): () => Promise<void>

/**
 * Start every currently matching rule and return before any callback settles.
 * @throws synchronously when the runtime is closing or the delivery is malformed.
 */
dispatch<K extends string>(delivery: VerifiedWebhookDelivery<K>): void
```

`WebhookRule<K>` 包含 "唯一 id、提供方种类与 `run(delivery, signal)`"，"回调可以执行任意受信任代码"，"**异步工作若应在注册卸载时停止，就必须观察 signal**"。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/webhook.zh.md>

**⚠️ 但 Webhook runtime 是 fire-and-forget，拿不到回复**：

> "runtime **没有队列、重试、去重、执行状态、崩溃重放、Agent 状态监听器或完成结果**。重复交付可能创建重复 Session。"
> "runtime 不执行特殊 flush，也不等待轮次"

**→ 【推断】结论**：
- **不要**用 webhook runtime 来要回复（它是 fire-and-forget）。
- **要**照抄它的**模式**：外部交付 → 解析/创建 Workspace → 创建 Session cwd = workspace 路径的 Agent → `followup()` 一条带来源标记的 user 消息。
- **回复**自己用 `ctx.on('session/event')` 收。
- **`source.kind` 的取值有冲突**：`llm-streaming.zh.md` 说 `MessageSourceMap` 是"可合并扩展的和类型——each producer declares its own `kind` in its own module; **there is no shared catch-all `plugin` kind**"，但 `agent/README.zh.md` 和 cookbook 的样例都写 `source: { kind: 'plugin', plugin: 'my-plugin' }`。**⚠️未验证**：第三方插件到底能不能用 `kind: 'user'` 以外的值。**建议直接用 `{ kind: 'user' }`**（这个在所有文档里都稳定、必合法）；若想要区分度，再实验 `{ kind: 'plugin', plugin: 'dsh-wxbot' }`。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/llm-streaming.zh.md>、<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent/README.zh.md>

---

## 6. 二维码呈现：服务端插件能不能注册 HTTP 路由？

### 6.1 能 —— `ctx.webServer.register()`【文档】

`ctx.webServer`（`@deepseek-ai/dsh-host-webserver`）是"GUI Host 的浏览器 HTTP 载体：一个提供 `ctx.webServer` 的 `node:http` 插件，包含具名路由注册表、可选的 gzip 响应压缩、index.html 转换回调，以及一个可由插件认领的回退处理器。**它不属于 agent loop，也不是能力 seam；它不了解任何 harness 概念。其他插件负责注册所有功能路由。**"

类型与注册方法（逐字）：

```ts
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

```ts
/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler.
 * @returns the disposer removing the route.
 */
register(route: WebRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler answering every request no named
 * route matches (the SPA dist server in the shipped Web composition). One
 * owner only — a second registration throws.
 */
registerFallback(handler: WebRoute['handler']): () => void
```

匹配顺序："先查 exact 表，再取最长匹配前缀，最后落到已注册的回退。"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/web-server.zh.md>

**→ 可以这样做【推断，基于文档 API】**：

```js
export const name = 'dsh-wxbot'
export const inject = ['agents', 'webServer']   // 【⚠️未验证】web 插件里服务键是否就是 webServer

export function apply(ctx, config) {
  ctx.effect(() => {
    // 把当前二维码（PNG buffer）放这里
    let currentQr = null

    const off = ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-wxbot/qr',
      handler: (req, res) => {
        if (!currentQr) { res.statusCode = 404; res.end('no qr yet'); return }
        res.setHeader('Content-Type', 'image/png')
        res.setHeader('Cache-Control', 'no-store')
        res.end(currentQr)
      },
    })

    // 顺手给个纯文本登录链接页
    const off2 = ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-wxbot',
      handler: (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<img src="/dsh-wxbot/qr" alt="wechat qr">')
      },
    })

    return () => { off(); off2() }
  })
}
```

**⚠️ 安全警告（文档原文）**：

> "`host` 只接受 `127.0.0.1`（默认姿态）和 `0.0.0.0`（刻意的网络暴露）。**载体本身不拥有 TLS、认证或 Origin 策略**，因此绑定到非回环地址会暴露服务器，除非组合层提供这些控制。"
> "随附的 `dsh web` 命令选择 loopback 并拒绝 `--host 0.0.0.0`；其 Connection 插件为每个 Host API route 与 stream 提供 Host/Origin 校验和浏览器会话认证。"

而 `ctx.connection` 提供了给别的 Web route 加认证的方法（逐字）：

```ts
/**
 * Apply Connection's Host/Origin checks and browser authentication to
 * another Web route.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns rejection status, or undefined when the route may accept the request.
 */
requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection

/**
 * Admit one request: it passes {@link requestRejection} and speaks for the
 * operator, or it is refused with that status.
 */
admit(request: ConnectionTrustRequest): PeerAdmission
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/web-server.zh.md>

**→ 【推断】你的二维码路由是 `/dsh-wxbot/qr`，不叫 `/api`，所以它属于"其它 Web route"，默认是公开的。** 在 loopback + 本机浏览器场景下风险可接受；但如果用户开了 `0.0.0.0`，任何人都能看到二维码。**建议**：要么调用 `ctx.connection.requestRejection(req)` 自行鉴权，要么干脆不注册路由——见 6.2。

**⚠️未验证**：`ctx.webServer` 是否在 `web` profile 中存在（很可能存在，因为 `dsh web` 就是靠它服务的），以及插件里 `inject` 的服务键字面量是不是 `'webServer'`（生成区块标题是 **"`ctx.webServer` — `WebServer`"**，所以键就是 `webServer` —— 【文档】，键名可靠）。

**⚠️未验证**：`WebServer` 是否要求"认领回退席位"的插件先注册。文档说："the fallback handler answers anything not yet claimed during startup with 404 until its owner registers"。所以启动期自注册路由没问题。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/web-server.zh.md>

### 6.2 往 Web GUI 里"推送内容"：分两种，结论不同

**（a）把内容当作会话消息推进去 —— 能，且很简单【文档】**

只要 `followup()` 一条消息给一个**当前在 GUI 里打开着的会话**，GUI 就会按正常流程渲染出来（用户消息 + 助手回复）。这就是"在 GUI 里显示二维码链接"的最低成本方式：

```js
agent.followup(createUserMessage({
  content: [{ type: 'text', text: `微信登录二维码：http://127.0.0.1:<port>/dsh-wxbot/qr` }],
  source: { kind: 'user' },
}))
```

**（b）注册自定义 GUI 卡片 / 组件 —— 需要 client 插件 + 构建产物，与你的免构建约束冲突**

【文档】client 插件包的要求：

> "`packages/client/*` 包改为 extends `tsconfig.base.client.json`（而非 `tsconfig.base.json`）；**client 插件包还需在 package.json 声明 `dsh.client`、导出 `./client`、调用共享 tsdown preset（`packages/client/tsdown.client.ts`）**"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/adding-a-package.zh.md>

client 侧文档（`docs/subsystems/client-modules.zh.md` 摘要）："Web 插件表：`dsh.client` 声明、`WebBootGraph` 协议格式组合、bundle 路由与 index 挂接点"。
`docs/subsystems/slots.zh.md`："类型化 Web UI 组合：声明所有权、cardinality 与 scope、框架与功能注入、props 推导及已交付的层级结构"。

**→ 【推断】结论：**
1. **能注册 HTTP 路由**（服务端插件，纯 JS，无需构建）→ 二维码图片/链接可以直接给用户。
2. **能通过 `followup()` 把链接塞进会话**，GUI 会显示它。
3. **不能**（在免构建约束下）注册自定义 GUI 卡片/组件 —— 那需要 client 插件 + tsdown 构建产物。

**【⚠️未验证】** 是否有一种**纯 JS** 就能给 Web GUI 注入内容的机制（例如 `webserver/index-inject` 只注入 index.html 的启动行，看描述是给"模块图的启动 manifest 行"用的，不是给业务内容用的）。我没有找到纯 JS 的 GUI 内容注入路径。

`webserver/index-inject` 事件（逐字）：

```ts
/**
 * Collect the structured index injection table. Emitted on every index
 * render and every worker boot-payload request; listeners push their
 * current rows, so a row's data is read fresh at emit time.
 * @param table - Mutable row table; listeners append in activation order.
 * @mode emit
 */
'webserver/index-inject'(table: IndexInjection[]): void
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/web-server.zh.md>

---

## 7. 官方 Python SDK（外部进程路径）

**这是一条独立且成熟的路，而且它直接解决了"提交一条用户消息、拿回助手回复"。**

### 7.1 安装【文档】

```sh
python -m pip install deepseek-harness-sdk
```

> "安装 `deepseek-harness-sdk` 时，会同时安装当前平台上版本完全相同的 `deepseek-harness-runtime-bin` wheel 包。"
> "**普通 SDK 运行不需要系统 Node.js。**"

前置条件：Python 3.10+、Git、Linux x64 / Linux arm64 / macOS 14+ on arm64 / **Windows x64**、DeepSeek 兼容 endpoint 与凭据。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/guide/python-sdk.zh.md>、<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/python/sdk/README.zh.md>

### 7.2 最小可用代码【文档，逐字】

```python
from pathlib import Path

from deepseek_harness import DeepSeekHarness

workspace = Path("/absolute/path/to/disposable-workspace").resolve()
dsh_home = Path("/absolute/path/to/example-dsh-home").resolve()
with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cwd=str(workspace),
    dsh_home=str(dsh_home),
    profile="sdk-minimal",
) as harness:
    result = harness.run(
        "Inspect the repository and fix the failing tests.",
        session_id="example-001",
    )

print(result.final_response)
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/guide/python-sdk.zh.md>

另一份（`python/sdk/README.zh.md`）多了一个 `reasoning_effort="max"`：

```py
with DeepSeekHarness(
    dsh_home="/absolute/path/to/isolated-dsh-home",
    cwd="/absolute/path/to/workspace",
    provider="deepseek-official",
    model="deepseek-v4-flash",
    reasoning_effort="max",
    max_tokens=49_152,
) as harness:
    result = harness.run("Say hi.", session_id="example-001")

print(result.final_response)
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/python/sdk/README.zh.md>

### 7.3 是否支持"创建/复用会话 + 提交消息 + 拿回复"？**全部支持【文档】**

- **启动与复用**："`DeepSeekHarness` 延迟启动运行时，并在调用 `close()` 或退出上下文管理器前**复用该进程**。"
- **会话复用**："同时复用 harness 与会话 ID 会延续持久对话和会话资源。"
- **提交消息**：`harness.run(prompt, session_id=...)`
- **拿到回复**：
  > "`Session.run()` 的活动区间从提示词被持久 inbox 接收时开始，到整个 agent 下一次进入空闲状态时结束，并返回 `RunResult(session_id, final_response, finish_reason, events, notifications)`。**`final_response` 是该区间内根会话最后提交的助手文本。** `finish_reason` 是最后一个根会话 `turn/end` 的 `kind`，例如 `completed`、`max-tokens` 或 `error`；没有轮次结束时为 `None`。缺少字符串 `data.reason.kind` 的 `turn/end` 违反协议，并会抛出 `SdkProtocolError`。"

- **底层 API（不等整轮）**：
  > "底层 `session_prompt()` 会**立即返回已排队消息的 id**；绕过 `Session.run()` 的调用方自行负责后续活动边界。"
- **流式通知**：`RunResult.notifications` 与 `on_notification` 按协议顺序接收通知。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/python/sdk/README.zh.md>

**这一点很关键**：Python SDK 的 `Session.run()` **明确替你定义了 defensive-patterns 要求的那个"从 inbox 回执到下一个 idle"的区间** —— 这正是文档说"自动化调用方如果真要拥有一次 run，必须自己定义区间"的那个区间。**SDK 已经把这个坑填好了。**

### 7.4 只影响单次调用的 patch【文档】

```py
with DeepSeekHarness(
    dsh_home="/absolute/path/to/isolated-dsh-home",
    profile="sdk",
    patches=("/absolute/path/to/first.patch.yml", "/absolute/path/to/last.patch.yml"),
) as harness:
    result = harness.run("Make the requested code change.")
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/python/sdk/README.zh.md>

---

## 8. ★ 方案取舍结论：A（进程内插件） vs B（Python SDK） vs C（acp / sdk profile）

### 8.1 三条路的本质

| | 机制 | 是否需要进程内 | 消息注入 | 拿到回复 |
|---|---|---|---|---|
| **A. 进程内 Cordis 插件** | 写成 `dsh.bundle` 包，`dsh plugin --profile web add` 装进 profile | **是** | `ctx.agents.get(id).followup(createUserMessage(...))` | `ctx.on('session/event')` 里展开 `assistant/message` 的 `data.stream` |
| **B. Python SDK** | `pip install deepseek-harness-sdk`，`DeepSeekHarness(...)` 起子进程走 stdio JSON-RPC | 否（独立子进程） | `harness.run(prompt, session_id=...)` | `result.final_response`（**现成**） |
| **C. `acp` / `sdk` profile** | DSH 自带的 profile：`dsh --profile acp`（ACP JSON-RPC over stdio）/ `dsh --profile sdk`（SDK JSON-RPC server） | 否（独立进程） | ACP `session/prompt` / `session/new` / `session/resume` | ACP `session/update` 里的已提交 assistant 消息 |

来源：
- A：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.zh.md> + <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/extension-cookbook.zh.md>
- B：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/python/sdk/README.zh.md>
- C：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/acp/acp/README.zh.md> + <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/bundle/base/README.zh.md>

### 8.2 各条路的细节与坑

#### A. 进程内 Cordis 插件

**优点**
- 唯一能**直接访问内部服务**（`ctx.agents`、`ctx.sessions`、`ctx.webServer`、`ctx.storage`、`ctx.jobs`、`ctx.webhookRuntime`）。
- 唯一能**注册 HTTP 路由**（二维码）。
- 和用户在看的 Web GUI **共享同一个进程和同一批会话** —— 用户能在 GUI 里看到微信对话流。
- 纯 JS 免构建完全可行（官方教程样例就是 `index.js`）。

**缺点 / 坑**
- **必须重启 DSH 或触发 HMR** 才生效。装完插件后，`web` profile 的会话历史/GUI 需要重载。
- **⚠️未验证 —— 最大的风险**：你的插件能否 `import '@deepseek-ai/dsh-llm'` 等宿主包。文档说 peer 依赖"运行中 dsh 的 runtime resolution 已包含的 peer 使用安装中的副本"，但本机 runtime 打包在 `app.asar` 里，第三方插件能否解析到这些 peer **我没有验证**。**这是必须第一个做实验证的事。**
- **⚠️未验证**：本机是 Electron `nightly` 构建，profile 解析路径（`app.asar` vs `app.asar.unpacked`）与文档描述的 npm 安装形态可能不同。`dsh plugin` 命令在本机是否可用/可用哪个 `dsh` 二进制，也需要实测。
- 文档里的"local 插件用绝对路径"（`docs/user/develop/basic/index.zh.md`）说明本地源码插件是要绝对路径的；而"bundle 用包名"（`publish.zh.md`）需要经 `dsh plugin add` 走 pnpm。**在 shell 不可用的机器上，`dsh plugin add` 可能跑不了** —— 这条会直接卡住 A 的安装步骤。**⚠️未验证**，但风险很高。
- 消息注入 + 取回复需要自己写事件循环（见 §3.6），且官方反复警告 `followup()` 没有 per-message 结果。

#### B. Python SDK

**优点**
- **`result.final_response` 直接就是助手回复文本** —— 零解析、零事件循环。
- `Session.run()` 已经替你实现了 defensive-patterns 要求的"从 inbox 回执到下一个 whole-agent idle"区间。
- `session_id` 复用即延续对话 —— "一个微信用户一个 session_id"是最自然的写法。
- **不需要系统 Node.js**（wheel 自带同版本 runtime bin）。
- 版本可控：`pip install deepseek-harness-sdk==<pin>` 明确锁定，不会和本机 nightly 桌面版混在一起。
- 不需要装进 DSH 进程、不需要重启 GUI、不需要碰 profile。

**缺点 / 坑**
- **独立进程、独立 home、独立会话存储**。默认 `profile="sdk"` 或 `"sdk-minimal"`，**不会**和 `web` profile 共享会话 —— 所以微信对话**不会**出现在用户正在看的 Web GUI 里。
  - 【文档】"需要隔离 profile、插件、凭据、设置与会话时，应使用新的 home。"
  - 【文档】`sdk-minimal` 是"独立显式配置树，而不是 `dsh-base` 上的 overlay"。
- 【文档】"`web` 是独立 CLI 应用，**不能为 Python SDK client 提供服务**。"
- 需要 Python 3.10+（本机 shell 不可用，但运行 Python 脚本不需要 shell —— 只要有个宿主进程能 spawn 它；**⚠️未验证**本机能否跑 Python）。
- 想加自己的插件仍要走 `dsh plugin --profile <name> add`（需要 `pnpm`），但**只在管理外部包时需要**："运行 SDK 不需要系统 Node.js"。

#### C. `acp` / `sdk` profile

**优点**
- 标准协议（[ACP](https://agentclientprotocol.com) v1），有生态、有别的客户端实现。
- 多会话：**一个连接可以同时运行多个会话，彼此独立**，`session/new` / `session/resume` / `session/close` 都是标准调用。
- 持久化：`acp` profile 挂载会话持久化，"客户端可以列出、恢复和关闭持久会话"。
- 自带进程外 subagent（`dsh-subagent-acp`）。

**缺点 / 坑**
- **没有 Python/JS 官方客户端** —— 你要自己实现 JSON-RPC over stdio 的客户端，工作量远大于 B。
- 【文档】刻意只给标准 ACP v1 界面："当人类需要 DSH 专用呈现卡片、计划、标题、todo、终端视图或 elicitation 时**请避开**"。
- 不支持：`session/load`、删除、fork、附加目录、mode、命令、计划、终端、客户端文件系统操作与 elicitation。
- 仍然要启动一个独立的 `dsh --profile acp` 进程。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/acp/acp/README.zh.md>

### 8.3 推荐

**对"把微信消息接进 DSH 并回回复"这个场景，我的推荐是：**

> **主路 = B（Python SDK），因为它是唯一"开箱即得回复文本"的路，且不需要改动 DSH 安装、不需要重启 GUI、不需要构建、版本可控。**
>
> **备路 = A（进程内纯 JS 插件），如果产品的核心价值是"微信对话要出现在用户正在看的 Web GUI 里"，或者需要注册 HTTP 路由展示二维码。**

**理由展开**

1. **场景本质是"网关"，不是"GUI 功能"。** 微信侧是一个长轮询循环 + 一张 `openid → session_id` 映射表 + 收发文本。这**完全不需要进程内**。B 满足全部需求。

2. **B 的 reply 是现成的**：`result.final_response`。A 要自己实现 `session/event` 订阅 + `expandAssistantStream` + `turn/end` 边界判定，而这个边界判定官方明确标为"容易写错"（defensive-patterns："Never treat `agent/status` or `whenIdle()` as the result of one follow-up"）。

3. **A 的安装路径在你的机器上有真实风险**：shell 完全不可用 ⇒ `dsh plugin --profile web add` 可能跑不了；且本机是 `app.asar` 打包的 Electron nightly，第三方插件能否解析宿主 peer 包我没验证。

4. **两条路的会话存储是分开的**，所以这不是"选更好的"，而是"选哪个会话库"。**如果用户可以接受微信对话在 GUI 里看不到**，选 B（简单得多）。**如果必须看到**，才需要 A。

5. **混合方案（不推荐，但可行）**：B 起 SDK 处理微信收发，同时用 min 的 A 插件（或干脆不用插件）让 GUI 能看到 —— 但这样会有两份会话历史，语义混乱。

6. **C 不推荐**：没有官方客户端，工作量大，且能力被刻意裁剪（无呈现数据、无 plan/todo/终端）。除非你已经有 ACP 客户端。

**如果你选 B，最小可行骨架（纯 Python，无第三方依赖）**

```python
# wechat_dsh_bridge.py
import json, os, pathlib, threading, time
from deepseek_harness import DeepSeekHarness

HOME   = os.environ["DSH_SDK_HOME"]                  # 独立的 dsh_home，别用 ~/.dsh
WS     = os.environ["WECHAT_DSH_WORKSPACE"]          # agent 的 cwd
STATE  = pathlib.Path(HOME) / "wechat-sessions.json" # openid -> session_id

def load_map():
    return json.loads(STATE.read_text("utf-8")) if STATE.exists() else {}

def save_map(m):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(m, ensure_ascii=False, indent=2), "utf-8")

# 一个 harness 进程，长期复用（文档：延迟启动并复用到 close()）
harness = DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    cwd=WS,
    dsh_home=HOME,
    # profile="sdk-minimal",   # 【⚠️未验证】本机是否已随 wheel 装上这个 profile
)
sessions = load_map()

def handle(openid: str, text: str) -> str:
    sid = sessions.get(openid)
    if sid is None:
        sid = "wechat-" + openid_hash(openid)      # 保守字符集
        sessions[openid] = sid
        save_map(sessions)
    result = harness.run(text, session_id=sid)     # 复用 session_id = 延续对话
    return result.final_response

# while True: updates = wechat_get_updates(); for u in updates: reply(handle(u.openid, u.text), u)
```

**⚠️注意**：`harness.run()` 是**阻塞**的（区间到 agent idle 才结束），所以如果要并发处理多个微信用户，需要多线程/多进程，或者用 Python SDK 的异步/通知接口（【⚠️未验证】SDK 是否提供 async API；文档提到 `on_notification` 与 `session_prompt()` 立即返回，暗示可以自己做并发）。

---

## 9. 明确"没找到 / 未验证"的清单

按重要程度排序：

1. **本机实际运行的 dsh 版本号** —— ⚠️未验证。打包在 `app.asar` 里，ripgrep 找不到 `@deepseek-ai/dsh-base` 的版本。用 `dsh --version` / `dsh --profile web --dump-config` 实测。
2. **本机 `dsh plugin` 命令是否可用** —— ⚠️未验证。shell 不可用，且这是 Electron 桌面安装（非 npm 全局安装）。
3. **纯 JS 第三方插件能否 `import '@deepseek-ai/dsh-llm'` / `'@deepseek-ai/dsh-agent'` / `'@deepseek-ai/cordis'`** —— ⚠️未验证。**这是 A 路的头号风险**。
4. **`web` profile 是否挂载 `ctx.storage` / `ctx.storageDomain` / `ctx.jobs` / `ctx.webServer` / `ctx.sessionPersistence`** —— ⚠️未验证（只有 `dsh-base` README 的概括承诺"持久会话"）。用 `dsh --profile web --dump-config` 查。
5. **`joinAssistantStreamText` 的确切 import 路径** —— 【推断】`@deepseek-ai/dsh-llm`，未在文档里明写 import 语句。
6. **会话默认落盘目录** —— ⚠️未验证。文档只给了 `sdk-minimal` 的 `<dsh_home>/sessions`，JSONL provider 说"项目/会话目录"。用 `ctx.sessionPersistence.list()` / `stat()` 问，别猜路径。
7. **`SessionId` 的校验规则（字符集/长度）** —— ⚠️未验证。建议保守用 `[a-z0-9_-]`。
8. **`MessageSourceMap` 里第三方插件能用哪些 `kind`** —— ⚠️未验证且文档自相矛盾（`llm-streaming.zh.md` 说"没有 shared catch-all `plugin` kind"，但 `agent/README.zh.md` 和 cookbook 样例都写 `{kind:'plugin', plugin:'...'}`）。**用 `{kind:'user'}` 最稳。**
9. **`MessageBase` 的完整字段（`UserMessage` 是否必填 `id`）** —— ⚠️未验证。**所以用 `createUserMessage()` 而不是手写对象。**
10. **`TurnEndReasonMap` 的完整成员** —— ⚠️未验证（只确认了 `completed` / `max-tokens` / `error` / `aborted` / `interrupted`）。
11. **`ctx.on('dispose')` 是否存在** —— **没找到**。文档记载的卸载钩子是 `ctx.effect(() => cleanup)` 与 `fiber.dispose()`。用 `ctx.effect()`。
12. **unhandled rejection 是否真的致命** —— ⚠️未验证。我在 `docs/defensive-patterns.md` 里只找到"Dispose must reach quiescence"与"Contain callback exceptions in the dispatcher"两条相关规则，**没有**"游离 unhandled rejection 会杀进程"的明文。但按 defensive-patterns 的写法做（永不 reject 的循环 + effect 里 await 收敛）无论如何都是对的。
13. **`CreateAgentOptions` 的完整字段清单** —— 文档只给了散文描述（`sessionId` / `parentAgent` / `meta` / `inheritedEventCount` / `seed` / `agentOptions` / `signal` / `setup`）与一个示意样例，**没有** type-equiv 展开。⚠️部分未验证。
14. **`ctx.jobs` 的 `JobKindMap` 是否允许第三方插件合并新 kind、以及是否需要 `attachController`** —— 【文档】允许合并（"Plugins extend this map by declaration merging"），且 `start` "refuses work while no attached job controller serves the spec's owner"。但**具体谁来 attach controller、web profile 里有没有，⚠️未验证**。
15. **纯 JS 给 Web GUI 注入自定义 UI 的路径** —— **没找到**。client 插件需要 `dsh.client` + tsdown 构建（与免构建约束冲突）。
16. **`@deepseek-ai/dsh-llm` 等包在 npm 上的可用版本** —— 未查。我只读了仓库 `master`。

---

## 10. 参考来源清单

| # | 内容 | URL |
|---|---|---|
| 1 | master HEAD = 0.2.0-rc.2 | <https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master> |
| 2 | 打包与安装插件（`dsh.bundle`、`dsh plugin add`、层顺序、git 构建门槛） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.zh.md> |
| 3 | 第一个插件（`apply(ctx)`、三种形态、`ctx.effect` 清理） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/index.zh.md> |
| 4 | 插件配置（Schemastery `Config`） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/config.zh.md> |
| 5 | 插件与生命周期（Fiber 状态机、自动清理、dispose 语义、HMR） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/framework/index.zh.md> |
| 6 | Cordis 入门（五概念、分发模式、waterfall、loader 配置） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.zh.md> |
| 7 | 继承的 Cordis API（`ctx.effect` / `ctx.timer` / `ctx.logger` / `ctx.loader` 全清单） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/inherited.md> |
| 8 | Cordis logger 源码（`ctx.logger(name)`、`%s` formatter、`exporter`） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/cordis/src/logger.ts> |
| 9 | 扩展实操手册（**真实注入 + 取回复代码**） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/extension-cookbook.zh.md> |
| 10 | core 子系统（`Agent` / `AgentHandle` / `ctx.agents` / `CreateAgentOptions` / `agent/*` 事件） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.zh.md> |
| 11 | session 子系统（`SessionEventMap` / `session/event` / `ctx.sessions`） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.zh.md> |
| 12 | 会话持久化（`ctx.sessionPersistence` / `SessionHeader` / `CreateSessionOptions` / JSONL provider） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/persistence.zh.md> |
| 13 | LLM 流式输出（`ContentBlockMap` / `StreamChunk` / `AssistantStreamRecord` / `expandAssistantStream` / 记录级读取器） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/llm-streaming.zh.md> |
| 14 | 后台任务运行时（`ctx.jobs` / `JobSpec` / `JobHooks`） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/jobs.zh.md> |
| 15 | 存储（`ctx.storage` / `ctx.storageDomain` / `DomainSpec`） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/storage.zh.md> |
| 16 | HTTP 服务器（`ctx.webServer.register` / `ctx.connection` 鉴权） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/web-server.zh.md> |
| 17 | Webhook runtime（外部交付 → Session 的官方模式） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/webhook.zh.md> |
| 18 | defensive patterns（异步状态 ≠ 同步状态；dispose 要达到停稳；dispatcher 兜住异常） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/defensive-patterns.md> |
| 19 | `@deepseek-ai/dsh-agent` 包 README（`create` / `resume` / `followup` / `steer` / `whenIdle` 样例） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent/README.zh.md> |
| 20 | `@deepseek-ai/dsh-acp` 包 README（ACP 协议面、何时选用/避开） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/acp/acp/README.zh.md> |
| 21 | Python SDK 参考（`DeepSeekHarness` / `RunResult.final_response` / profile） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/python/sdk/README.zh.md> |
| 22 | Python SDK 入门教程 | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/guide/python-sdk.zh.md> |
| 23 | `@deepseek-ai/dsh-base` 包 README（随发行版的 4 个 profile、`dsh plugin add`） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/bundle/base/README.zh.md> |
| 24 | 添加 workspace 包（client 插件需 `dsh.client` + tsdown preset） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/adding-a-package.zh.md> |
| 25 | 子系统索引（全部子系统页清单） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/README.zh.md> |
| 26 | 扩展子系统（`ctx.dynamicCordisRunner` 动态插件） | <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/extensions.zh.md> |

**随发行版的 profile 名单【文档】**（来源 #23）：

> "随发行版交付的 `web`、`headless`、`sdk` 与 `acp` profile 会在首次使用时为你创建。"

本机现有 profile：`C:\Users\<user>\.dsh\profiles\web\`（已用 glob/read 确认）。
