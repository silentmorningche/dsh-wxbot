# 代码审查（第 1 轮）：`src/store.js`、`src/redact.js`、`src/qr.js`

> 审查方式：**纯人工逐行阅读**。本机 shell 完全不可用（`pwsh` 在任何命令执行前即失败），因此本轮
> **没有运行 node、没有跑语法检查、没有执行任何代码**。所有语法结论来自人工核对括号/花括号/模板
> 字符串/正则字面量/私有字段/可选链/`??=`；所有协议结论来自对照以下两份原文（已用 `web_fetch` 抓取
> HTTP 200 全文）：
>
> - 官方：`https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/docs/protocol.md`（下文简称 **官方文档**）
> - 第三方实测分析：`https://raw.githubusercontent.com/SiverKing/weixin-ClawBot-API/main/weixin-openclaw-api-py-docs.md`
>   （下文简称 **第三方分析**）
>
> 目标运行时：Node >= 22.13.0、`"type": "module"`、无第三方依赖（已核对 `package.json`：
> `"type": "module"`、`engines.node >= 22.13.0`，无 `dependencies`）。

---

## 0. 结论速览

| 级别 | 数量 | 条目 |
|---|---:|---|
| **致命** | **0** | 三个文件内未发现致命问题（无语法错误、无未定义标识符、无游离 Promise） |
| **重要** | **7** | 重要-1 … 重要-7（`store.js` 5 条：账号会话隔离 / 原子写 / 调用契约 / 原型污染 / 写盘前置；`qr.js` 2 条：虚假 `savedPath` / 不校验魔数） |
| **次要** | **22** | 次要-1 … 次要-9（`store.js`）、次要-10 … 次要-15（`redact.js`）、次要-16 … 次要-22（`qr.js`）；其中 3 条（次要-15、次要-18、次要-22）我明确标注为"不确定" |
| 范围外（但影响能否启动） | 1 | `package.json` 的 `main`/`exports` 指向**不存在**的 `src/index.js` |

**没有发现致命问题的判断依据（三条都逐一核对过）：**

1. **语法**：三个文件都是 Node 可直接 `import` 的纯 ESM。
   - 类字段声明（`store.js:70-79`：`#dir` / `#file` / `#state` 无初始化器，`#writeChain = Promise.resolve()`）、
     私有方法（`#snapshot`、`#writeAtomic`）、`?.`（226/152/111）、`??=`（240）、
     调用尾随逗号（267-270）、对象字面量尾随逗号（qr.js:141）、模板字符串内嵌注释
     （qr.js:117 `${/** @type {any} */ (err)?.name ?? 'error'}`）在 Node 22 下**全部合法**。
   - 两处容易误判为正则提前结束的地方是合法的：`qr.js:173` `/^[A-Za-z0-9+/=_-]+$/`
     与 `qr.js:68` `/data:image\/([a-zA-Z0-9.+-]+)/` —— 字符类 `[...]` 内的 `/` 不需要转义，
     类内末尾的 `-`（`+-]`）是字面量，均不构成 `SyntaxError`。
   - `// @ts-check` 只在编辑期生效，不参与运行；`AbortSignal` 仅出现在 JSDoc 里
     （qr.js:48），没有运行时引用，不会 `ReferenceError`。
2. **标识符**：三个文件的 import 全部被使用，没有用到未导入的名字，也没有未使用的 import。
   - `store.js:31-32` 的 `mkdir / readFile / rename / writeFile / chmod / join` 分别在
     106、109、125+289、281、285、89+352 使用；
   - `qr.js:25-26` 的 `mkdir / writeFile / join` 全部使用；`fetch`、`Buffer` 均为 Node 22 全局；
   - `redact.js` 无 import，只用全局 `URL`。
   - 唯一的"未使用声明"是 `redact.js:15` 的 `SecretKind` typedef（见次要-13），属整洁性问题。
3. **游离异步 / unhandled rejection**：三个模块**内部没有任何 fire-and-forget 的 async 调用**。
   所有 reject 都只可能出现在"调用方 await 得到的那个 promise"上，可以被安全 `catch`：
   `store.load()`、`store.flush()` 及全部 mutator、`materializeQrImage()` 都是
   `async` 并且内部 `await` 每一个异步步骤；`redact.js` 完全没有 async。
   **注意**：这依赖调用方 `await`——见 **重要-3**（这是本目录唯一与"DSH 未捕获 rejection 即退出"
   契约直接相关的风险点）。

**另外必须知道的一件事**：`src/store.js`、`src/qr.js`、`src/redact.js` 目前**没有被任何文件 import**。
已核对方式：在 `dsh-wxbot` 全目录搜索 `from './…'` / `require(` / `import(`，只得到
`ilink-client.ts` 里两处 `await import("node:fs/promises")`；`bridge.js:21` 只在注释里提到
`store.js`。也就是说，现存的 `src/ilink-client.js`（自带一套 `redactUrl`/`setAccount`）是另一份独立实现，
本轮三个文件是尚未接线的模块。**结论：这三个文件当前不可能导致应用崩溃（包括 unhandled rejection）**，
风险是"接线之后"的风险。若审查目的是评估接线后的安全性，上面第 3 点的契约问题必须先解决。

---

## 1. 致命

**未发现致命问题。**

（范围外另有一处会直接导致启动失败的问题，见第 5 节，不计入本轮三个文件的结论。）

---

## 2. 重要

### 重要-1｜`setAccount` 会静默复用上一个会话的 `get_updates_buf` 与 `context_token`
**位置**：`store.js:162-172`（相关自述注释在 `store.js:23-24`，方法注释在 `156-163`）

**问题（两处，第一处是确定的）**

```js
// store.js:163-169
const previous = this.#state.account
const changedAccount = previous && previous.ilinkBotId !== acct.ilinkBotId
this.#state.account = { ...acct, savedAt: Date.now() }
if (changedAccount) {
  delete this.#state.cursors[acct.ilinkBotId]
  delete this.#state.contextTokens[acct.ilinkBotId]
}
```

1. **只在 `ilinkBotId` 变化时清理，`botToken` 变化时完全不动游标与 context_token。**
   文件头 `store.js:23-24` 自己写的规则是：

   > Switching accounts or **tokens** must NOT silently reuse the previous account's cursor or context tokens.

   代码没有实现 "or tokens" 这一半。而"同一个账号重新扫码、bot id 不变但拿到新 `bot_token`"
   恰恰是最常见的重新登录路径（第三方分析 §2.5.2 明确要求 `confirmed` 时持久化新
   `bot_token`；官方文档说明 `get_updates_buf` "is sent … empty for the first request **or after a reset**"）。
   在这种情况下，旧会话的游标与旧 `context_token` 会被原样继续使用。
2. **`delete` 的目标是"新" bot id，而注释声称处理的是"不同" bot id。** 由于 `cursors` /
   `contextTokens` 本身就按 botId 分桶，一个**不同**的 id 永远读不到旧桶——所以这次 `delete`
   唯一可能生效的场景，是"同一个 id 之前就已经有桶"（即上一次同名会话）。也就是说
   **注释描述的效果和代码实际效果不是一回事**，容易让后续维护者误判语义。

**为什么是问题**：第三方分析 §2.6.4 明确："不得把 A 用户、A 账号或**历史已失效的 token** 用到另一条会话"；
用旧游标去长轮询，最坏情况是漏收消息或收到服务端的游标类错误，而且**没有任何日志**能提示这件事发生过。

**建议修法（把"要不要重置会话"变成显式决定，默认保守）**

```js
  /**
   * @param {{ botToken: string, baseUrl: string, ilinkBotId: string, ilinkUserId: string }} acct
   * @param {{ resetSession?: boolean }} [opts]
   *   Whether this is a *new* login (a fresh server-side session) rather than a
   *   bootstrap re-set of the account already on disk. Defaults to true whenever the
   *   account id or the token differs from what is stored.
   * @returns {Promise<void>}
   */
  async setAccount(acct, opts = {}) {
    const previous = this.#state.account
    const sameAccount = Boolean(previous) && previous.ilinkBotId === acct.ilinkBotId
    const sameToken = sameAccount && previous.botToken === acct.botToken
    const resetSession = opts.resetSession ?? !sameToken

    this.#state.account = {
      botToken: acct.botToken,
      baseUrl: acct.baseUrl ?? '',
      ilinkBotId: acct.ilinkBotId ?? '',
      ilinkUserId: acct.ilinkUserId ?? '',
      savedAt: Date.now(),
    }

    const id = this.#state.account.ilinkBotId
    if (id && resetSession) {
      // A completed login starts a new long-poll session: the stored cursor belongs to
      // the session that produced it, and context tokens from the previous session may
      // already be stale. Neither may be carried over - even when the bot id is
      // unchanged and only `bot_token` was rotated.
      delete this.#state.cursors[id]
      delete this.#state.contextTokens[id]
    }
    // Do not keep a superseded account's buckets on disk forever (see 次要-6).
    if (previous?.ilinkBotId && previous.ilinkBotId !== id) {
      delete this.#state.cursors[previous.ilinkBotId]
      delete this.#state.contextTokens[previous.ilinkBotId]
    }

    this.addLocalTokenSync(this.#state.account.botToken)
    await this.flush()
  }
```

**不确定的点**：官方 `protocol.md` **没有**说明"同账号换 token 后旧游标是否仍有效"，
第三方分析只规定了"不得跨账号复用"。因此"默认 `resetSession = true`"是我按保守原则选的策略，
不是文档里的硬性要求；如果作者确认服务端游标是账号级而非会话级、且希望重启后无感续传，
可以显式传 `{ resetSession: false }`。需要作者定夺。

---

### 重要-2｜`#writeAtomic` 失败时残留临时文件；临时名可能撞车；Windows 上 `rename` 无重试
**位置**：`store.js:278-290`（以及 `280` 的临时名、`289` 的 rename）

```js
  async #writeAtomic(payload) {
    await mkdir(this.#dir, { recursive: true })
    const tmp = `${this.#file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    try { await chmod(tmp, 0o600) } catch { /* non-fatal */ }
    await rename(tmp, this.#file)
  }
```

**为什么是问题**

1. **临时文件不清理**：`writeFile` 部分写入后失败（ENOSPC/EACCES）、或 `rename` 失败时，
   `.tmp-*` 直接留在目录里，且下次写入用的是新名字（`Date.now()` 变了），**永远不会被回收**。
   磁盘紧张时这会持续累积。这是"原子写"实现里最常见的漏洞。
2. **临时名不够唯一**：`${pid}-${Date.now()}` 在同一毫秒内的两次写入会同名。单实例下因为
   `#writeChain` 串行化（见重要-3 的正确性结论）不会撞，但**两个指向同一目录的 store 实例
   （例如两个 profile / 两个插件实例共用 `storageDir`）没有互斥**，会互相覆盖临时文件。
3. **Windows rename 的瞬时失败没有重试**：Node 的 `fs.rename` 在 Windows 上走 libuv 的
   `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`，所以**覆盖已存在的 `state.json` 是可行的**
   （不需要先 unlink，这一点代码是对的）。但如果目标此刻被其它进程以"不共享删除"的方式打开
   （杀毒软件扫描、编辑器、OneDrive 等同步盘、另一个 DSH 进程正在读 state），
   `rename` 会抛 `EPERM`/`EACCES`/`EBUSY`。这类失败是**瞬时**的，重试一次通常就成功。
4. 附带：`mode: 0o600` 与 `chmod` 在 Windows 上是 no-op（`fs.chmod` 只切换只读位），
   代码注释已经说清了意图，这点没问题，但不要把它当成 Windows 上的保护（见次要-7）。

**建议修法（不新增 import，维持文件头 `store.js:28` 的"仅 node:fs/promises + node:path"承诺）**

```js
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Windows may hold the destination open for a moment (antivirus, indexer, sync client),
 * which makes MoveFileEx fail with a transient permission error even though the rename
 * itself is valid. Retry those few codes with a short linear backoff.
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = /** @type {any} */ (err)?.code
      if (attempt >= 4 || !RENAME_RETRY_CODES.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}
```

类内：

```js
  /** Process-local counter so the temp name cannot collide within the same millisecond. */
  static #tmpSeq = 0

  async #writeAtomic(payload) {
    await mkdir(this.#dir, { recursive: true })
    const tmp = `${this.#file}.tmp-${process.pid}-${Date.now()}-${WeixinStore.#tmpSeq++}`
    try {
      await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
      try {
        // No-op on Windows; documents the intent on POSIX.
        await chmod(tmp, 0o600)
      } catch {
        /* non-fatal */
      }
      await renameWithRetry(tmp, this.#file)
    } catch (err) {
      try {
        await rm(tmp, { force: true })
      } catch {
        /* the temp file may never have been created; a failure to clean up must not mask `err` */
      }
      throw err
    }
  }
```

> `rm(tmp, { force: true })` 对不存在的文件是安静的；`/tmp` 清理失败被吞掉是**故意**的
> （不能让清理错误覆盖真正的写入错误）。若希望临时名跨进程也唯一，可改用
> `randomUUID()`（`node:crypto` 也是内置），但那会与 `store.js:28` 的自述注释不一致，
> 需要同时改注释。

**不确定的点**：Windows 上 `EPERM` 的实际复现频率我无法在本机验证（无 shell），
第 3 条属"防御性建议"而非已证实的失败；第 1、2 条是**确定的**代码缺陷。

---

### 重要-3｜`flush()` 及其全部 mutator 的 promise **必须**被 await：这是唯一与"未捕获 rejection 即退出"契约相关的风险
**位置**：`store.js:265-272`（`flush`）、`162-178`（`setAccount`/`clearAccount`）、
`213-218`（`setCursor`）、`238-244`（`setContextToken`）、`253-257`（`invalidateSession`）

**先说结论（核对过，是对的）**

- `#writeChain` 的串行化**正确**：`this.#writeChain.then(f, f)` 的**两个**回调都是
  `#writeAtomic(payload)`，所以"一次失败后整条链永久废掉"**不会发生**——下一次写入会挂在
  拒绝分支上照常执行，链永远可恢复。
- payload 在 `flush()` 入口**同步**快照（`JSON.stringify` 在 `.then` 之前执行），
  因此不存在"后一次写入用旧快照"的交错。
- 模块内部**没有**任何不 await 的异步调用，所以 **unhandled rejection 不会由本模块自身产生**。

**风险点**：`flush()` 是 `async` 且 `return this.#writeChain`，它返回的 promise 在写入失败时**会 reject**。
DSH 的契约是"游离异步工作的 unhandled rejection 会销毁整个应用"。因此只要有**任何一处**
调用方漏写 `await`：

```js
store.setCursor(botId, buf)   // 漏 await：磁盘满/权限问题时 -> unhandled rejection -> 应用退出
```

就会命中致命路径。类型标注（`@returns {Promise<void>}`）不会阻止这件事，
`// @ts-check` 在没有 tsc 的情况下也不会报 `no-floating-promises`。
**当前代码本身没问题，但这个 API 形状在 DSH 插件里是高危的**：五个 mutator 全部
"既改内存又写盘还 reject"，调用方任何一个漏 await 都是全校停机。
（注意：这里不能靠给内部 `#writeChain` 加 `.catch(() => {})` 来修——`async` 方法返回时已经
通过 thenable 采纳给内部链挂上了处理器，真正未处理的是**返回给调用方的那个 promise**。）

**建议修法（提供一个永不失手的入口，并在类文档里写死契约）**

```js
  /**
   * Persist without ever producing a rejection.
   *
   * DSH treats an unhandled rejection from stray async work as fatal, so every
   * fire-and-forget write MUST go through this method; use `flush()` only where the
   * caller can await and handle the failure (`await` inside `try`).
   *
   * @returns {Promise<boolean>} true when the document reached the disk
   */
  async flushSafely() {
    try {
      await this.flush()
      return true
    } catch (err) {
      this.#log('failed to persist state', err)
      return false
    }
  }
```

并在类注释（`store.js:69` 之前）加一句契约说明：

```js
/**
 * All mutators (`setAccount`, `setCursor`, `setContextToken`, `invalidateSession`,
 * `clearAccount`) return a promise that rejects when the write fails. Callers MUST
 * either `await` them inside a `try`, or use `flushSafely()`-style wrapping: an
 * unhandled rejection kills the DSH host.
 */
```

**为什么算"重要"而不是"致命"**：缺陷在调用方，不在本文件；本文件已经满足"能被安全 catch"
的最低要求。但它是本轮唯一一条会直接导致整个应用退出的路径，接线时请优先落实上面这段契约。

---

### 重要-4｜`Object.prototype` 污染：`contextTokens[botId] ??= {}` 对 `__proto__` 键会写到全局原型上
**位置**：`store.js:240`（`const bucket = (this.#state.contextTokens[botId] ??= {})`），
同族问题在 `store.js:327`（`ctxs[bot] = bucket`）与 `store.js:313`（`cursors[k] = v`）

**为什么是问题**：`botId` 来自 `confirmed` 响应的 `ilink_bot_id`（服务端可控），
`peerId` 来自入站消息。对普通对象字面量，`obj['__proto__']` 命中的是
`Object.prototype` 上的访问器：

- 读 `contextTokens['__proto__']` → 返回 `Object.prototype`（**不是** `undefined`）。
  因此 `??=` 认为"已有值"，`bucket` 就变成了 `Object.prototype`；
- 紧接着 `bucket[peerId] = token`（`store.js:242`）→ **把 context_token 写到了全局
  `Object.prototype` 上**，此后进程内所有对象都会"凭空"多出这个属性（
  并且它随后会被 `JSON.stringify` 序列化进 state.json 的其它对象里，污染会扩散）。

`migrate` 里 `ctxs[bot] = bucket`（`327`）同理：`bot === '__proto__'` 时是在给 `ctxs`
设置原型而不是加一个（永远读不到的）键。`cursors[k] = v`（`313`）在字符串值下是无害的
（设原型为字符串会被忽略），但机制相同。

**建议修法（最省事、最可靠的是拒绝危险键）**

```js
/** Keys that must never be used as a map key coming from the wire. */
const UNSAFE_KEY = new Set(['__proto__', 'constructor', 'prototype'])

  async setContextToken(botId, peerId, token) {
    if (!botId || !peerId || !token) return
    if (UNSAFE_KEY.has(botId) || UNSAFE_KEY.has(peerId)) return
    const bucket = (this.#state.contextTokens[botId] ??= {})
    if (bucket[peerId] === token) return
    bucket[peerId] = token
    await this.flush()
  }
```

`migrate` 里对 `cursors` / `contextTokens` 的 `for...of` 循环加同一道过滤；
若希望更彻底，可把 `emptyState()` 的两个 Record 改成 `Object.create(null)`
（注意 `#snapshot()` 走 `JSON.parse` 后又会变回普通对象，所以**键过滤仍是必要的**，
`Object.create(null)` 只是额外一层防御）。

**为什么算"重要"而不是"次要"**：`Object.prototype` 污染在一个长期运行的插件进程里后果不可控
（会出现在后续所有 `JSON.stringify`、所有 `for...in`、所有对象的属性查找里）。
**不确定的点**：这需要服务端真的返回 `__proto__` 这类 id 才会触发，我不能证明真实服务端会这么干；
但代码缺陷本身是确定的，加固成本只有两行。

---

### 重要-5｜在 `load()` 之前调用任何 mutator，会把空状态写回磁盘、**静默抹掉已保存的账号**
**位置**：`store.js:105-133`（`load`）与 `store.js:265-272`（`flush`）；构造函数 `86-92` 不调用 `load`

**为什么是问题**：构造函数只做 `this.#state = emptyState()`，是否读盘完全取决于调用方有没有
`await store.load()`。而 `flush()` 无条件 `JSON.stringify(this.#state)` 覆盖 `state.json`。
于是下面这种顺序会**无声地**丢掉 `bot_token`/`baseurl`/`ilink_*`／全部 context_token：

```js
const store = new WeixinStore({ dir })
store.setCursor(botId, buf)     // 忘了（或晚于）await store.load()
// -> state.json 被写成 { account: null, localTokenList: [], cursors: {...}, contextTokens: {} }
// -> 用户必须重新扫码，且没有任何报错
```

`store.js:28-29`、`104` 的注释都没有说明"`load()` 是使用前置条件"。这属于"数据损坏"类风险，
只是触发条件在调用方，所以记在"重要"。

**建议修法（三个单行插入 + 一道闸门）**

```js
  /** @type {boolean} */
  #loaded = false

  async load() {
    await mkdir(this.#dir, { recursive: true })
    let raw
    try {
      raw = await readFile(this.#file, 'utf8')
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'ENOENT') {
        this.#state = emptyState()
        this.#loaded = true          // (1)
        return this.#snapshot()
      }
      throw err
    }
    try {
      // Windows editors happily write a UTF-8 BOM; JSON.parse would reject it and we
      // would quarantine a perfectly good file (see 次要-8).
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
      this.#state = migrate(parsed)
    } catch {
      /* ... 保持原样 ... */
      this.#state = emptyState()
    }
    this.#loaded = true              // (2)
    return this.#snapshot()
  }

  async flush() {
    if (!this.#loaded) {
      // Writing the empty in-memory state over a populated state.json would destroy the
      // saved account with no error at all. Refuse until the document has been read.
      throw new Error('WeixinStore: load() must complete before the state can be written')
    }
    // ... 原样 ...
  }
```

> 注意 (1) 处的提前 return 也必须置位，否则 ENOENT（首次运行）后的第一次写入会被自己的闸门挡住。
> 也不要直接在构造函数里 `await`（构造函数不能 async）；如果希望自动加载，
> 可以加一个 `static async open(opts)` 工厂。

---

### 重要-6｜`qr.js` 的远程链接分支：写入失败被吞掉，**同时把不存在的文件路径报给用户**
**位置**：`qr.js:100-119`（问题在 `107-108` 与 `116-118`）
**与自身文档的冲突**：`qr.js:40-42` 明确承诺

> A filesystem failure propagates, because writing beside the state file is the one step the caller may want to retry.

**问题**：`savedPath` 在 `await writeFile` **之前**就被赋值，且整段被 `try` 包住：

```js
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
        if (buf.byteLength > 0 && (ctype.startsWith('image/') || looksLikeImage(buf))) {
          savedPath = join(dir, `qrcode.${extFor(subtypeFromContentType(ctype))}`) // 先赋值
          await writeFile(savedPath, buf)                                        // 再写盘
          bytes = buf.byteLength
        } else { note = '服务端给的是链接但不是图片，已保留链接供手机打开' }
      } else { note = `下载二维码图片失败（HTTP ${res.status}），已保留链接供手机打开` }
    } catch (err) {
      note = `下载二维码图片失败（${/** @type {any} */ (err)?.name ?? 'error'}），已保留链接供手机打开`
    }
    return { kind: 'remote-url', savedPath, link: content, bytes, note }
```

于是 `writeFile` 一旦抛错（磁盘满、目录被删、EPERM）：

1. 异常被 `catch` 转成一句 `note`，**违反上面引用的 JSDoc 契约**，调用方无法重试；
2. `savedPath` **已经不是 null**，`bytes` 仍是 0，而返回对象照样带着这个路径。
   接着 `describeQrForUser`（`qr.js:155`）无条件渲染
   `二维码图片已保存：<path>` —— **用户被指向一个不存在（或半截）的文件**，
   而真实原因只剩一句 `下载二维码图片失败（Error）`。
   另有可能留下一个截断的 `qrcode.png`，下次 `describeQrForUser` 也不会察觉。

**建议修法**

```js
    try {
      const res = await fetchImpl(content, { signal, redirect: 'follow' })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
        if (buf.byteLength > 0 && (ctype.startsWith('image/') || looksLikeImage(buf))) {
          const target = join(dir, `qrcode.${extFor(extFromMagic(buf, ctype))}`)
          // Write first, publish the path only after the bytes are on disk. A failure
          // here is a real filesystem error and must reach the caller (documented
          // contract), not be downgraded into a note.
          await writeFile(target, buf, { mode: 0o600 })
          savedPath = target
          bytes = buf.byteLength
        } else {
          note = '服务端给的是链接但不是图片，已保留链接供手机打开'
        }
      } else {
        try {
          await res.body?.cancel() // 让 undici 立刻回收连接，而不是等 GC
        } catch {
          /* 已关闭 */
        }
        note = `下载二维码图片失败（HTTP ${res.status}），已保留链接供手机打开`
      }
    } catch (err) {
      if (isFsError(err)) throw err   // ENOSPC/EACCES/EPERM/EROFS/EISDIR -> 交给调用方重试
      note = `下载二维码图片失败（${/** @type {any} */ (err)?.name ?? 'error'}），已保留链接供手机打开`
    }
```

配一个只认文件系统错误码的小判定，避免把 fetch 的失败也抛出去：

```js
const FS_ERROR_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOENT', 'EMFILE', 'ENFILE'])

/** @param {unknown} err */
function isFsError(err) {
  return FS_ERROR_CODES.has(/** @type {any} */ (err)?.code)
}
```

> 这里同时修掉了次要-16（未消费的响应体）与次要-17（扩展名只信 content-type）。

---

### 重要-7｜base64 兜底分支不校验魔数：任意 ASCII 文本都会被当成二维码图片，并报"成功"
**位置**：`qr.js:122-134`（以及同族的 `62-77`）
**为什么是问题**：`decodeBase64`（`171-180`）只要求字符集匹配：

```js
if (!cleaned || !/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) return null
```

于是 `"notfound"`、`"ok"`、`"expired"` 这类**纯字母数字的服务端文本**（空格会被 `\s+` 抹掉，
中文会被字符集拒掉，但英文错误串会被放行）都能通过，写出一个几字节的垃圾 `qrcode.png`，
并返回 `kind: 'base64'` + `note: '按原始 base64 处理，若打不开请检查服务端返回格式'`。
`data:image/…` 分支同理：只按声明的 subtype 定扩展名，payload 内容不校验。
结果是"服务端给的其实是别的东西"这件事**被报告成一次成功**，用户拿到一个打不开的文件。

值得注意的是：本文件**已经有** `looksLikeImage()`（`199-212`）做 PNG/JPEG/GIF/WEBP 魔数判定，
但只在 fetch 分支（`106`）用了一次，兜底分支完全没用它——这属于"已有工具没用上"的疏漏，
而不是缺少能力。

**建议修法**

```js
  // Last resort: the legacy client treated anything else as bare base64. Only accept it
  // when the decoded bytes actually look like an image; otherwise an English error
  // string would be written out as a bogus "successful" qrcode.png.
  const bytes = decodeBase64(content)
  if (bytes && looksLikeImage(bytes)) {
    const savedPath = join(dir, `qrcode.${extFromMagic(bytes, '')}`)
    await writeFile(savedPath, bytes, { mode: 0o600 })
    return { kind: 'base64', savedPath, link: null, bytes: bytes.byteLength, note: null }
  }

  return {
    kind: 'unknown',
    savedPath: null,
    link: null,
    bytes: 0,
    note: '无法识别的二维码内容格式，已丢弃（内容可能含凭据，不写入日志）',
  }
```

`data:image/…` 分支建议同样先 `looksLikeImage` 再落盘（SVG 除外），并在魔数与声明 subtype
不一致时把差异写进 `note`（例如服务端声明 `image/png` 但实际是 JPEG）。
配套的扩展名嗅探函数（同时解决次要-17）：

```js
/**
 * Prefer what the bytes are over what the server claimed.
 * @param {Buffer} buf
 * @param {string} ctype
 * @returns {string}
 */
function extFromMagic(buf, ctype) {
  if (buf.byteLength >= 4 && buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf.byteLength >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.byteLength >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  if (buf.byteLength >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp'
  }
  return extFor(subtypeFromContentType(ctype))
}
```

**不确定的点**：我不确定真实服务端是否会把"非图片文本"放进 `qrcode_img_content`
（两份资料只记录了 URL / `data:image/` / `<svg` / 裸 base64 四种形态）。
所以这条的价值在于"拒绝把不确定的输入当成成功"，而不是"已知线上会出错"。

---

## 3. 次要

### store.js

- **次要-1｜`migrate` 从不读 `parsed.version`。** 位置：`store.js:300-303`。代码无条件
  `out.version = STATE_VERSION`，没有任何按版本分支的迁移逻辑。文件头 `26` 行的
  "carries a small `version` field so the on-disk shape can be migrated" 和 `293-295` 的
  "so a version bump can never brick plugin startup" 只对了一半：现行行为是"尽力逐字段强转"，
  安全但**不是**迁移机制。另外 `load()` 里 `migrate()` 的结果**不会写回磁盘**
  （load 不 flush），所以不合法的旧字段会一直躺在文件里直到下一次 mutator。
  建议：把注释改成实话，或在 `load()` 末尾对"迁移后与原文不一致"的情况调用一次
  `flushSafely()`。
- **次要-2｜`load()` 对非 ENOENT 错误直接 rethrow。** 位置：`store.js:110-115`。
  `104` 行注释写的是 "tolerating absence and corruption"，但 `EACCES`/`EPERM`/`EISDIR`
  会向上抛。如果调用方在启动路径 `await load()`，插件会因一个权限问题起不来。
  建议明确：要么把注释改成"仅容忍缺失与损坏"，要么对权限类错误降级为"只读空状态 + 告警"
  （但那时必须禁止写盘，见重要-5）。
- **次要-3｜`addLocalTokenSync` 名字会误导。** 位置：`store.js:188-194`。它只改内存、
  **不 flush**；`setAccount` 靠后续 `flush()` 落地。公开方法名叫 `…Sync` 容易让人以为
  "调用即已持久化"。建议改名 `addLocalToken` 并在 JSDoc 里写明"仅改内存，需另行 flush"，
  或在方法内自己 flush（同时保证不再从 `setAccount` 里重复调用导致两次写盘）。
- **次要-4｜`setAccount` 把调用方对象的全部字段都写进 state.json。** 位置：`store.js:165`。
  `{ ...acct, savedAt }` 会把 `acct` 上任何多余字段（例如直接传 `confirmed` 原始响应时的
  `status`、`errmsg`）持久化，而 `AccountState` 只声明了 5 个字段。建议按字段显式挑选
  （重要-1 的修法里已经这么写了）。
- **次要-5｜`getCursor`/`setCursor`/`setContextToken` 不校验 `botId` 是否为当前账号。**
  位置：`store.js:201-244`。API 完全依赖调用方传对 id；传错就会静默写到另一个桶里。
  建议加一个 `if (botId !== this.#state.account?.ilinkBotId) return`/`throw`，
  或在 JSDoc 里明确"botId 必须是当前账号"。
- **次要-6｜其它账号的桶永不回收。** 位置：`store.js:253-257`（`invalidateSession` 只删一个 id）、
  `166-169`。第三方分析 §7 明确提醒"实测扫码后 Bot ID 可能变化"，
  配合"按 botId 分桶 + 从不清理"，`cursors`/`contextTokens` 会随每次换 id 无限增长。
  建议保留"仅当前账号 + 上一层最近账号"两个桶，或干脆只保留当前 id 的桶。
- **次要-7｜密钥明文落盘（Windows 上 `mode: 0o600` 无效）。** 位置：`store.js:281`、`285`。
  第三方分析 §2.7.5 的建议是"token 应加密或交给系统凭据存储，不应明文写入日志/仓库"。
  官方 `protocol.md` 没有涉及。纯内置模块在 Windows 上拿不到 DPAPI，**不引入第三方依赖时
  没有完整解法**，所以我不把它列为"重要"。至少应当：把 `state.json` 所在目录权限收紧、
  在 README 里对用户明说"该文件含可直接冒充机器人的凭据"，并确保它不进版本库/同步盘。
- **次要-8｜UTF-8 BOM 会被当成"文件损坏"并触发隔离重建。** 位置：`store.js:118-131`。
  Windows 记事本默认写 UTF-8 BOM，`JSON.parse` 会直接抛错 → 走 quarantine 分支 →
  用户失去登录态（虽然坏文件被改名保留）。修法见重要-5 的
  `raw.replace(/^\uFEFF/, '')`。
- **次要-9｜`defaultStorageDir` 不校验 `dshHome`。** 位置：`store.js:351-353`。
  `join(undefined, …)` 抛 `TypeError`。JSDoc 已把参数标为必填，属可选加固。

### redact.js

- **次要-10（R1）｜`?? '<unparseable-url>'` 是死代码，且可能返回空串。** 位置：`redact.js:75`。
  `String(rawUrl).split('?')[0]` 永远返回字符串（可能为 `''`），不会是 nullish。
  建议明确处理空串：
  ```js
  } catch {
    // Not a parseable absolute URL; drop the query so no secret can be echoed.
    const head = String(rawUrl).split('?')[0]
    return head || '<unparseable-url>'
  }
  ```
- **次要-11（R2）｜"never throws" 是过度承诺。** 位置：`redact.js:12`、`29`、`75`。
  `redact()` 的 `String(value)` 对 `Object.create(null)` 这类对象会抛 `TypeError`
  （"Cannot convert object to primitive value"），带 `Symbol.toPrimitive` 的对象/Proxy 也能抛；
  而 `redactUrl` 的 `catch` 块里的 `String(rawUrl)` **本身不在任何 try 内**，会在兜底路径上逃逸。
  实际输入都是 `JSON.parse` 的产物（其对象都有 `Object.prototype`），所以**现实风险很低**，
  但注释声称的绝对性不成立。建议：
  ```js
  let s
  try {
    s = typeof value === 'string' ? value : String(value)
  } catch {
    return '<unstringifiable>'
  }
  ```
  并把 `redactUrl` 的兜底也包进 try。
- **次要-12（R3）｜在 `URLSearchParams` 里放脱敏文本会被百分号编码，日志可读性变差。**
  位置：`redact.js:70`。`searchParams.set` 会把 `…`、`(`、`=` 编码成
  `%E2%80%A6`、`%28`、`%3D`，实际输出形如
  `…?qrcode=ab12%E2%80%A6cd34%20%28len%3D43%29`；同时同名参数会被合并成一个。
  如果希望日志里是 `qrcode=ab12…cd34 (len=43)`，建议手工拼 query，
  或 `decodeURIComponent` 后再拼。属可读性问题，不影响安全（有编码只会更隐蔽、不会更暴露）。
- **次要-13（R4）｜`SecretKind` typedef 定义后从未使用。** 位置：`redact.js:15`。
  死代码；要么删掉，要么真的把 `redact()` 的 `kind` 参数化。
- **次要-14（R5）｜两处 JSDoc 与实现不一致（都无害）。** 位置：`redact.js:39`（标注
  `headers` 为不可空，代码却写 `headers ?? {}`）、`redact.js:86-101`（模块注释
  `8-10` 列举了 `context_token`、CDN 加密参数、AES key 为"不得打印"，而
  `summarizeResponse` 的白名单里没有这些键）。第二处**不是漏打印，而是更保守**——
  该函数只拷贝白名单内的键，白名单外的字段（含 `context_token`）根本不会被复制，
  所以**没有泄漏**；只是注释列举与实现列举不一致，建议把注释改成"白名单之外一律丢弃"。
- **次要-15（R6，不确定）｜`errmsg` 被原样复制进日志。** 位置：`redact.js:90-92`。
  两个隐患：(a) 长度不可控，服务端返回超长 `errmsg` 会刷屏；
  (b) 若服务端在 `errmsg` 里回显了带 `qrcode=` 的请求 URL，就等于把二维码标识写进了日志——
  而这正是第三方分析 §2.7.1 明确禁止的。我**没有证据**说明服务端会回显 URL，所以标"不确定"。
  低成本加固：`out.errmsg = typeof body.errmsg === 'string' ? body.errmsg.slice(0, 200) : body.errmsg`。

### qr.js

- **次要-16（Q3）｜`!res.ok` 时响应体未被消费/取消。** 位置：`qr.js:113-115`。
  undici 会一直持有这个响应直到 GC，连续失败重试时可能堆积连接。
  修法见重要-6 里的 `await res.body?.cancel()`（包 try）。
- **次要-17（Q4）｜扩展名只信 `content-type`，可能与实际字节不符。** 位置：`qr.js:107`。
  服务端给 `application/octet-stream` + WEBP 字节时，`looksLikeImage` 会放行，但文件仍被命名
  `qrcode.png`。修法见重要-7 的 `extFromMagic()`。
- **次要-18（Q5，不确定）｜非 base64 形态的 `data:` URL 未覆盖。** 位置：`qr.js:62-73`。
  `data:image/svg+xml,<svg …>`（百分号编码、非 base64）是合法的 data URL 形态，
  但会落进 `data:image/` 分支、被 base64 字符集检查拒掉，最终 `kind: 'unknown'`、
  整个内容被丢弃（连 `link` 都没有）。两份资料都没有记录服务端会发这种形态，
  所以我标"不确定"。如要加固，在 `comma` 之后按 `;base64` 是否存在分流，
  非 base64 分支用 `decodeURIComponent` 解码后再判 `looksLikeImage` / `<svg`。
- **次要-19（Q6）｜没有校验 `opts`/`dir`。** 位置：`qr.js:51-59`。
  `materializeQrImage(x, undefined)` 或 `{ dir: undefined }` 会在 `mkdir` 处抛出
  `TypeError [ERR_INVALID_ARG_TYPE]`，报错信息对用户毫无指向性。
  `store.js:87` 那种构造期校验是更好的范本：
  ```js
  const { dir, fetchImpl = fetch, signal } = opts ?? {}
  if (!dir || typeof dir !== 'string') throw new Error('materializeQrImage: `dir` is required')
  ```
- **次要-20（Q7）｜二维码图片没有设权限，且文件名固定会被覆盖。** 位置：`qr.js:75`、`82`、`108`、`126`。
  登录窗口期内，二维码图片本身就是一份短期凭据，但写盘用的是默认权限
  （POSIX 下通常 `0644`），而同一目录里的 `state.json` 是 `0600`。
  建议所有 `writeFile` 都加 `{ mode: 0o600 }`（`Buffer` 与字符串两种都适用）。
  另外四个分支都写固定文件名（`qrcode.png`/`qrcode.svg`/按 subtype 命名），
  上一次登录的二维码会留在同一目录里且不清理；如果用户打开的是旧文件会扫描失败，
  建议带时间戳或每次登录前清理同前缀文件。
- **次要-21（Q8）｜`describeQrForUser` 的两个小问题。** 位置：`qr.js:150`、`159-162`。
  (a) JSDoc 声明了 `opts.stateFilePath`，函数体从头到尾**没有用到它**（要么实现"状态文件位置：
  …"，要么删掉该参数）；(b) `if (opts.expiresInSeconds)` 会把 `0` 当假值，
  且 `Math.round(seconds / 60)` 在小数值时会打印"请在约 **0** 分钟内完成扫码"，
  建议 `Math.max(1, Math.round(...))`。
- **次要-22（Q9，不确定）｜下载二维码的 URL 完全由服务端指定，且没有自带超时。**
  位置：`qr.js:101`。`redirect: 'follow'` + 无 host 白名单 = 服务端可以让客户端去 GET 任意地址
  （SSRF 面；不过 TLS 之下这个"服务端"就是微信后端，威胁模型有限）。
  更现实的是超时：`signal` 是**可选**的（`qr.js:48`），调用方不传时，一个慢速滴流的响应体
  可以把这个登录步骤挂到天荒地老（undici 的默认 `headersTimeout` 管不到持续滴流的 body）。
  建议在 `signal` 为空时兜底 `AbortSignal.timeout(15000)`（Node 内置，不违反无依赖约束）。
  标"不确定"是因为严重程度取决于调用方是否总是传 signal。

---

## 4. 协议一致性逐条核对

对照对象：官方 `protocol.md`（"官方"列）与第三方分析 §2.7.5 / §2.5 / §2.6（"第三方"列）。

| # | 断言 / 声明 | 出处 | 核对结果 |
|---|---|---|---|
| 1 | `get_updates_buf` 只在"响应成功 **且** 新游标非空"时替换 | 官方（"saves a returned cursor only when `get_updates_buf` is nonempty"）；第三方 §2.6.1 | **相符（一半靠调用方）**：`store.js:214` 正确拒绝空串与非字符串；"响应成功"这一半 store 无从判断，只能由调用方保证不在 `ret != 0` 时调用 `setCursor`。建议在 `setCursor` 的 JSDoc 里把这条责任写明。 |
| 2 | `get_updates_buf` 按账号隔离 | 第三方 §2.7.5 | **相符**：`cursors` 以 botId 为键（`store.js:51`、`201-218`）。 |
| 3 | 重启后恢复游标 | 第三方 §2.7.5 | **相符**：`load()` 读回 `cursors`。前提是调用方真的 `await load()`（见重要-5）。 |
| 4 | 首次请求或**重置后**送空串 | 官方（"empty string for the first request or after a reset"） | **部分不符**：`getCursor` 对未知 id 返回 `''` ✓，但"重置"后是否清游标没有任何入口（`invalidateSession` 是唯一重置点，且需调用方在 `-14` 时主动调用）。与重要-1 是同一处。 |
| 5 | `context_token` 按 (账号, 对端) 隔离 | 官方（回复时回传入站 token）；第三方 §2.6.4 | **相符**：`contextTokens[botId][peerId]`（`store.js:52`、`225-244`）。`setContextToken` 对空 botId/peerId/token 直接返回 ✓。 |
| 6 | 不得跨账号复用 context_token / 游标 | 第三方 §2.7.5（"切换到新的 bot 账号/token 时…"） | **见重要-1**：跨**账号**（bot id 不同）已隔离 ✓；**换 token 但 bot id 不变**时未做任何处理，与文件头 `store.js:23-24` 的自述规则不符。 |
| 7 | 必须持久化 `bot_token` / `baseurl` / `ilink_bot_id` / `ilink_user_id` | 官方 `confirmed` 响应；第三方 §2.7.5 | **相符**：`AccountState` 四个字段齐备（`store.js:38-44`、`332-340`）。注意第三方 §7 提醒 bot id 可能变化、不应硬编码 —— 这里每次 `confirmed` 都覆盖 ✓。 |
| 8 | `typing_ticket` 可仅内存缓存，token 切换后清空 | 官方（getConfig 响应）；第三方 §2.7.5、§7 | **无法核验（不在本文件范围）**：store **完全没有** `typing_ticket` 相关代码，所以既不会错存、也不可能帮调用方"在 token 切换时清空"。文件头 `store.js:18` 把它写进了"本文件 enforced 的规则"清单里，容易被误读为已实现。建议把 `18` 行改成"由调用方缓存（本文件不持久化）"，或真的加一个 `clearTypingTickets()` 由 `setAccount` 调用。 |
| 9 | 持久化文件必须"临时文件 + 原子替换"，避免半截 JSON | 第三方 §2.7.5 | **方向相符，实现有漏**：`store.js:278-290` 确实是 tmp + rename（Windows 上 `MoveFileEx` 带 REPLACE_EXISTING，覆盖可行 ✓），但失败时不留清理、rename 无重试 —— 见重要-2。 |
| 10 | `local_token_list` 最多最近 10 个 | 官方（"at most the most recent ten locally stored bot tokens"）；第三方 §2.5.1 | **相符**：`LOCAL_TOKEN_LIMIT = 10`（`store.js:67`）、去重后 `while (list.length > LIMIT) list.shift()`（`192`）、`migrate` 里 `.slice(-LOCAL_TOKEN_LIMIT)` ✓。顺序"最新在最后"与 `localTokenList` 注释一致 ✓。 |
| 11 | 日志不得打印完整 `bot_token` / 二维码标识 / `typing_ticket` / `context_token` / CDN 加密参数 / AES key | 第三方 §2.7.1 | **相符（且偏保守）**：`redact.js` 的 `summarizeResponse` 是白名单式，白名单外的字段一律丢弃，`msgs` 只输出条数（`93`），因此入站消息里的 `context_token` 不会泄漏 ✓。缺口只在 `errmsg` 原样复制（次要-15，不确定）。 |
| 12 | 日志应记录脱敏后的 URL / HTTP 状态 / ret / errcode / errmsg | 第三方 §2.7.1 | **部分相符**：`summarizeResponse` 覆盖 `ret`/`errcode`/`errmsg`/`status` ✓；URL 脱敏由 `redactUrl` 提供，但 iLink 的敏感查询参数只有 `qrcode`/`verify_code`（第三方 §2.5.2）与 CDN 的 `encrypted_query_param`，`redactUrl` 三个都覆盖了 ✓。 |
| 13 | `qrcode_img_content` 可能是 URL / `data:image/…;base64,…` / `<svg` / 裸 base64，**不应直接当 base64 图片写文件** | 官方（"a url or content to display as a QR code"）；第三方 §2.5.1 与踩坑 1 | **相符，且顺序正确**：`qr.js` 先判 `data:image/`（`62`）→ `<svg`/`<?xml`（`80`）→ `http(s)`（`94`）→ 最后才裸 base64 兜底（`122`），正是第三方踩坑 1 给出的分支顺序 ✓。URL 分支会"优先下载本地 + 失败则保留链接给手机打开"，也正是踩坑 1 推荐的降级 ✓。未覆盖的只有非 base64 的 `data:` 形态（次要-18，不确定，两份资料均未记录）。 |
| 14 | 二维码会话 TTL 等数值是客户端策略、不是协议常量 | 第三方 §2.5.2 | **相符**：`qr.js:160` 的注释明确写了"an official client policy, not a server constant"，没有把它写成硬编码常量 ✓。 |

---

## 5. 范围外提醒（不属于本轮三个文件，但会影响"能不能启动"）

1. **`package.json` 的入口指向不存在的文件 —— 这会导致插件加载失败。**
   `package.json:8` `"main": "src/index.js"`、`9-12` `"exports": { ".": "./src/index.js" }`，
   但 `dsh-wxbot` 下**没有** `src/index.js`（全目录只有 `docs/`、`README.md`、
   `cordis.patch.yml`、`package.json`、`src/{bridge.js,ilink-client.js,ilink-client.ts,qr.js,redact.js,store.js}`）。
   `cordis.patch.yml:18` 用的是包名 `dsh-wxbot`，加载时必然走
   `exports["."]` → `ERR_MODULE_NOT_FOUND`。如果三个被审文件是正在进行的重写、`index.js`
   稍后补上，那这条可以忽略；否则这是**唯一一处能确定让插件起不来的问题**。
2. **三个文件目前无 import 者**（见开头"另外必须知道的一件事"），
   现有实现在 `src/ilink-client.js`（自带 `redactUrl`/`setAccount`）。
   接线时请注意：`ilink-client.js:634-638` 的 `redactUrl` 注释写的是
   "剥离 query（可能含 qrcode / 签名），只留 origin + pathname"，
   与 `redact.js:66-77` 的"只脱敏个别参数"是**两种不同策略**；
   同时存在两套会造成"同一条日志两种脱敏结果"，建议接线时统一到 `redact.js` 一份。

---

## 6. 建议的修复顺序

1. **重要-5**（`load()` 前的写入会静默抹掉账号）—— 唯一会造成"用户数据丢失"的路径，改动最小。
2. **重要-6 + 重要-7**（`qr.js`：虚假 `savedPath`/吞掉 fs 错误，以及不校验魔数就报成功）—— 用户直接可见的错误行为。
3. **重要-2**（临时文件残留 + Windows `rename` 重试）—— 长期运行必踩。
4. **重要-1**（重新登录后的会话隔离策略）—— 需要作者对"服务端游标是账号级还是会话级"下判断。
5. **重要-3**（`flushSafely()` + 类契约注释）—— 接线前必须落地，否则任何一处漏 `await` 都是全校停机。
6. **重要-4**（危险键过滤）—— 两行代码。

---

## 7. 我没能验证的东西（明确列出，避免误导）

- **没有执行任何代码**：所有"语法合法"的结论是人工核对的，不是 `node --check` 的结果。
  本轮我逐个核对了三个文件的括号/花括号配平、模板字符串与正则字面量边界、
  类字段与私有字段、`??=`/`?.`/尾随逗号、以及 JSDoc 类型转换注释的位置。
- **Windows 上 `fs.rename` 的具体失败率**：`MOVEFILE_REPLACE_EXISTING` 的行为来自
  libuv 实现的通行认知，不是本机实测（无 shell）。重要-2 第 3 条属防御性建议。
- **真实服务端行为**：`qrcode_img_content` 的实际形态分布、`ilink_bot_id` 是否真会返回
  `__proto__` 这类 id、`errmsg` 是否会回显 URL —— 均无证据，相关条目已标"不确定"。
- **`typing_ticket` 的缓存与失效处理**：不在三个文件的范围内，无法评价；
  但 `store.js:18` 的措辞会让人以为已实现（见协议核对表第 8 条）。
