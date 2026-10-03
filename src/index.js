// @ts-check
/**
 * dsh-wxbot — the Cordis plugin entry point.
 *
 * Wires four pieces together:
 *   `ilink-client.js`   the iLink HTTP/JSON protocol (Tencent's documented ClawBot backend)
 *   `bridge.js`         per-message orchestration: classify, dedupe, serialise, chunk
 *   `dsh-agent-port.js` the DSH session adapter, including the reply interval
 *   `qr.js`             QR materialisation and user-facing instructions
 *
 * ── Authoritative sources for everything DSH-specific here ─────────────────────────
 *
 * Bundled in-repo notes: `docs/DSH-PLUGIN-API-NOTES.md` (10 chapters, 26 source URLs)
 * and `docs/DSH-PROFILE-AND-PLUGIN-CONTRACT.md`. The two rules that shaped this file:
 *
 * [R1] A detached async work item producing an **unhandled rejection outside `apply()`'s
 *      promise disposes the whole application and exits non-zero**.
 *      Source: @deepseek-ai/dsh-app-boot README, "Startup and reload failures".
 *      Consequence: every async path below terminates in a catch, `runDetached` is used
 *      for anything not awaited, and `main()` is written so it **cannot reject**.
 *
 * [R2] Disposal must reach **quiescence**, not merely request it, and **multiple async
 *      disposers run concurrently without an ordering guarantee** — so "abort the loop"
 *      and "await the loop's exit" must live in the *same* `ctx.effect()`.
 *      Source: docs/defensive-patterns.md + docs/user/develop/framework.
 *      Consequence: the poll loop below is one `ctx.effect()` returning one async disposer.
 *
 * ⚠️ NOT VERIFIED ON A REAL MACHINE. The plugin has never been loaded. Every DSH API used
 * here is taken from the bundled notes, and each is marked where it matters. See the
 * "unverified" list at the bottom of `dsh-agent-port.js` for the riskiest ones (A1–A4).
 *
 * ⚠️ This module deliberately carries **no eager host import**. An earlier revision began
 * with `import { Schema } from '@deepseek-ai/schemastery'` in order to declare `Config`, and
 * a load test proved the cost of that: when the specifier could not be resolved the module
 * import failed, and under the documented policy for an optional entry the plugin was simply
 * skipped — an inert plugin that reported nothing. Schema validation is not worth that
 * failure mode, so defaults and validation are done in plain code and the plugin can always
 * load and say what it is missing.
 *
 * The one remaining host dependency is `@deepseek-ai/dsh-llm`, imported **dynamically** in
 * `dsh-agent-port.js`, so a failure there becomes a precise log line instead of silence.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ILinkClient, extractTextFromMessage, describeError, runDetached } from './ilink-client.js'
import { WeixinBridge } from './bridge.js'
import {
  firstMediaItem,
  downloadMedia,
  kindLabel,
  ITEM_IMAGE,
  ITEM_FILE,
  ITEM_VOICE,
} from './media-download.js'
import { uploadMedia, UPLOAD_MEDIA_TYPE } from './media-upload.js'
import { extractMediaRequests } from './reply-media.js'
import { channelBriefing, briefingDue } from './channel-briefing.js'
import { materializeQrImage, describeQrForUser } from './qr.js'
import { DshAgentPort } from './dsh-agent-port.js'
import { discoverModel } from './model-discovery.js'
import { createStatusWriter } from './status.js'

/** Cordis plugin name. */
export const name = 'weixin-clawbot'

/** How long the HTTP login route waits for a pairing code before giving up on it. */
const VERIFY_CODE_WAIT_MS = 120_000

/**
 * Names of the login handoff files, written into the **session workspace** rather than into the
 * plugin's private state directory.
 *
 * ⚠️ Location is the whole point. The GUI already shows the workspace, so a file there is visible
 * without hunting; `.state/` is not. See `handleQrCode` for the rest of the reasoning.
 */
const LOGIN_FILE_NAME = 'wechat-login.txt'
const VERIFY_CODE_FILE_NAME = 'wechat-verify-code.txt'

/**
 * Configuration defaults.
 *
 * ⚠️ There is deliberately **no exported `Config`**. Cordis requires a declared `Config` to
 * be a Standard Schema, which would mean a module-scope import of `@deepseek-ai/schemastery`
 * — the exact eager host import removed above after a load test showed it can silently kill
 * the plugin. Plain defaults cannot do that, so they win over generated forms and strict
 * rejection. Unknown patch keys are warned about rather than refused.
 *
 * `configDefaults` is exported for documentation and tooling; it is a frozen plain object,
 * not a schema.
 */
export const configDefaults = Object.freeze({
  /** `base_info.bot_agent`: observability only, never auth or routing. ASCII, <=256 bytes. */
  botAgent: 'dsh-wxbot/1.0.0',
  /** iLink API base. The QR request always goes to the fixed host, per the protocol doc. */
  apiBaseUrl: 'https://ilinkai.weixin.qq.com',
  /** `base_info.channel_version`. */
  channelVersion: '2.4.8',
  /** Where account tokens, the cursor and per-peer context tokens live. Empty = beside the package. */
  storageDir: '',
  /** Split replies longer than this many characters into several messages. */
  maxReplyChars: 2000,
  /** Drive the WeChat "typing" indicator while the agent works. */
  typingIndicator: true,
  /** How long to wait for one agent reply before giving up and reporting it. */
  replyTimeoutMs: 300_000,
  /** Serve the QR code and the pairing-code form over HTTP. */
  enableQrRoute: true,
  /** Path prefix for the login routes. */
  qrRoutePath: '/wechat/qr',
  /** Start the QR login automatically when no account is stored. */
  autoLogin: true,
  /**
   * Open the login link in the default browser as soon as it is issued.
   *
   * A visible side effect on the user's desktop, so it is switchable — but it removes the
   * "find the file, copy the link, paste it" step entirely, and logging in is a deliberate act the
   * user just triggered. Only `https://` and `weixin://` links are ever opened.
   */
  openLoginUrl: true,
  /**
   * The directory an agent created for a WeChat peer runs in.
   *
   * ⚠️ This is not cosmetic. A session's `cwd` is part of its creation metadata, and the
   * documented webhook precedent creates its session with `cwd` equal to the workspace path.
   * An agent created without one produced a turn that started and ended immediately, never
   * admitting the user message at all. Empty means "the directory containing this package",
   * which on the target machine is the workspace the GUI shows.
   */
  sessionCwd: '',
  /**
   * Preset id each WeChat session chooses.
   *
   * ⚠️ This is **not** the registry's `default`. `agent-preset-registry` ships `config.default:
   * standard`, and `standard` turned out to be a *persona-only* preset: an observed session that
   * chose it exposed exactly one tool (`load_workspace_dependencies`), which the session log confirms
   * was the entire `tools` array in the request header. The preset carrying the real toolset is
   * declared in `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml` as `config.id: cordis`, whose
   * `plugins` list mounts `tool-bash`, `tool-pwsh`, `tool-fs`, `tool-fs-search`, `tool-jobs`,
   * `plan-mode`, `compaction`, `delegation`, `tool-web`, `tool-cordis`, `tool-skill`, `present` and
   * more — and whose own comment reads "Same persona as `standard`", i.e. the two differ in plugin
   * set, not in character.
   *
   * So "the deployment default" and "the preset that has tools" are different things, and taking the
   * former for the latter is what left the agent unable to open a file it had just been handed.
   */
  agentPreset: 'cordis',
  /**
   * Every how many inbound prompts to repeat the channel briefing. The first prompt of a conversation
   * always gets it; this governs the refreshes after that.
   *
   * The briefing carries what a preset's system prompt would carry — that this is WeChat, that the user
   * sees plain text, and how to send a file — and a plugin cannot install anything in the system prompt.
   * Repeating it bounds the cost while keeping it inside the window context compaction has not yet
   * summarised away. `0` means "first prompt only".
   */
  briefingInterval: 10,
  /**
   * Model for the agents this plugin creates. **Empty means "work it out".** Leave all three empty
   * and the plugin discovers the model on this machine; set any one of them to override just that
   * field.
   *
   * ⚠️ Why a model is needed at all: the system-prompt template references `{{model}}`, and a session
   * created without one fails assembly with
   *     prompt variable "{{model}}" has no value for this assembly
   * which ends the turn before any model call — indistinguishable from an agent that had nothing to
   * say. The profile's `agent-default-model` row does **not** cover a programmatically created
   * session, so the value must come from somewhere. See src/model-discovery.js for the chain; these
   * keys exist only to override it, and an install that sets none of them is fully supported.
   */
  agentProvider: '',
  agentModel: '',
  reasoningEffort: '',
})

/**
 * Merge a patch-supplied config over the defaults, coercing and reporting problems instead of
 * throwing. A bad value degrades to its default and says so; it never stops the channel, and
 * it never prevents the plugin from loading.
 *
 * @param {any} raw the config object from the profile patch
 * @param {(level: string, message: string) => void} [log]
 * @returns {any} a plain object with every key from `configDefaults`
 */
export function normalizeConfig(raw, log) {
  /** @type {any} */
  const out = { ...configDefaults }
  if (raw === null || raw === undefined) return out
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log?.('warn', `config must be an object; got ${Array.isArray(raw) ? 'an array' : typeof raw}. Using defaults.`)
    return out
  }
  for (const [key, value] of Object.entries(raw)) {
    const fallback = /** @type {any} */ (configDefaults)[key]
    if (fallback === undefined) {
      log?.('warn', `unknown config key "${key}" ignored`)
      continue
    }
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
      else log?.('warn', `config "${key}" expects a boolean; got ${typeof value}. Using ${fallback}.`)
      continue
    }
    if (typeof fallback === 'number') {
      const n = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(n) && n > 0) out[key] = n
      else log?.('warn', `config "${key}" expects a positive number; got ${JSON.stringify(value)}. Using ${fallback}.`)
      continue
    }
    if (typeof value === 'string') out[key] = value
    else log?.('warn', `config "${key}" expects a string; got ${typeof value}. Using ${JSON.stringify(fallback)}.`)
  }
  return out
}

/**
 * Cordis entry point.
 *
 * @param {any} ctx
 * @param {any} rawConfig the config object from the profile patch; validated in code
 */
export function apply(ctx, rawConfig) {
  // Services are read through `ctx.reflect.get(name, false)`, never as `ctx.<name>`.
  //
  // ⚠️ This was the bug that kept the plugin from ever activating. Cordis's context is a
  // Proxy whose `get` trap throws for any service the plugin has not declared in `inject`:
  //     Error: cannot get property "webServer" without inject
  // (vendor/cordis/src/reflect.ts, `ReflectService.handler.get`). Optional chaining cannot
  // suppress it, because the trap itself is what throws.
  //
  // Two reasons for `reflect.get` rather than declaring `inject`:
  //   1. it is documented as "read a service from the store without the inject requirement",
  //      so the read cannot throw;
  //   2. a name listed in `inject` that does not exist leaves the entry **waiting forever**
  //      for a service that never arrives. The exact names are not verifiable from here
  //      (`webServer` vs `webserver`, `agents` vs `agent`), so probing several candidates and
  //      taking whichever exists is strictly safer than committing to one.
  // ⚠️ `web` is deliberately NOT a candidate: @deepseek-ai/dsh-web provides `ctx.web`, the
  // web *access* service (search/fetch), not an HTTP server. Including it selected the wrong
  // object — harmless only because it happens to have no `register`.
  /** Why each candidate service name failed to resolve. Recorded so failures stay visible. */
  const serviceProblems = []
  const services = readServices(ctx, [
    'webServer',
    'webserver',
    'server',
    'agents',
    'agent',
    // The workspace registry is a peer of dsh-agent and is declared OPTIONAL there, so it may or may
    // not be mounted in a given profile — and its exact name is worth probing rather than assuming.
    'workspaceRegistry',
    'workspace',
    'workspaces',
    'workspaceStore',
    'projects',
    'sessionPersistence',
    'sessions',
    // Owns the process-level default model. Its documented job is answering "which model should a
    // new agent use?", so it is asked directly rather than inferred.
    'agentDefaultModel',
    // Owns image and file attachments. An image reaches the model **only** through it; see
    // `describeMedia` for why sending a path instead leaves the model with no pixels at all.
    'attachments',
    // Owns the preset declarations. A preset's sub-plugin list is what owns the model-visible tools,
    // so this service is where "why does a new session get almost no tools?" can be answered.
    'agentPresets',
    'logger',
  ], serviceProblems)
  const webServer = services.webServer ?? services.webserver ?? services.server ?? null
  const agents = services.agents ?? services.agent ?? null
  const workspaceRegistry = services.workspaceRegistry ?? null
  const agentDefaultModel = services.agentDefaultModel ?? null
  const attachments = services.attachments ?? null
  const agentPresets = services.agentPresets ?? null

  /**
   * Assigned a few lines below, once `config` has been normalised — its `storageDir` decides where
   * the file goes. Declared up here because `log` has to reach it: **every** log line is mirrored
   * into the status file, and the logger is constructed first.
   *
   * @type {import('./status.js').StatusWriter|null}
   */
  let status = null
  const log = makeLogger(ctx, services.logger, (level, message) => status?.note(level, message))
  const config = normalizeConfig(rawConfig, log)

  // Default storage directory: beside this package, so it needs no knowledge of $DSH_HOME.
  const packageDir = fileURLToPath(new URL('..', import.meta.url))
  const storageDir = config.storageDir || join(packageDir, '.state')

  // The workspace an agent created for a WeChat peer runs in.
  //
  // ⚠️ The default used to be `dirname(packageDir)` — "the folder containing this plugin" — which
  // silently encoded a *development* layout where the plugin happened to live inside the workspace.
  // Installed anywhere else it points the agent at its own distribution directory, and DSH then registers
  // a brand-new workspace for it. Measured on a fresh install into a Downloads folder:
  //     { "path": "D:\\Users\\<user>\\Downloads\\wechat-clawbot-v6", "title": "wechat-clawbot-v6" }
  //
  // So the default is now DSH's own default workspace, read from DSH's state instead of assumed. The
  // *rule* below is machine-independent; only the value differs per machine:
  //     process.cwd()            the profile directory — the same anchor the host-module resolution uses
  //       → ../../storages/workspace.json
  //       → global.defaultWorkspaceId          (an explicit marker, so nothing guesses which is "the" one)
  //       → tables.workspaces[<that id>].path
  const readDshDefaultWorkspace = () => {
    try {
      const statePath = join(process.cwd(), '..', '..', 'storages', 'workspace.json')
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      const id = state?.global?.defaultWorkspaceId
      const path = id ? state?.tables?.workspaces?.[id]?.path : null
      if (typeof path === 'string' && path.length > 0) return path
      return null
    } catch {
      // A missing or unreadable state file is not an error worth failing over: it just means this
      // deployment has no recorded default yet, and the documented fallback applies.
      return null
    }
  }

  const configuredCwd = String(config.sessionCwd ?? '').trim()
  const dshDefaultCwd = configuredCwd ? null : readDshDefaultWorkspace()
  const sessionCwd = configuredCwd || dshDefaultCwd || dirname(packageDir)
  // ⚠️ Which of the three sources won is recorded, because the third is a *guess* — and a guess that
  // happens to be right looks exactly like a decision that was made. That is precisely how the previous
  // default ("the package's parent directory") survived unnoticed until it aimed an agent's workspace at
  // its own distribution folder and made DSH register a workspace there.
  const sessionCwdSource = configuredCwd
    ? 'config'
    : dshDefaultCwd
      ? 'dsh-default-workspace'
      : 'package-parent-fallback'

  // The status file is this plugin's only observability channel: with no shell, no readable
  // application log and no debugger, "did it load, and how far did it get?" is otherwise
  // unanswerable — a plugin that fails to load and one that loads and fails at login look
  // identical from the outside. See src/status.js.
  status = createStatusWriter(storageDir)
  // Prove the mirror works from the very first line: from here on, every `log()` call also lands in
  // this file's `logTail`, so no future code can be silent merely because its author forgot to
  // mirror it. That mistake was made three times in this plugin; this removes the possibility.
  log('info', `status writer ready at ${status.file}`)
  status.set('apply:enter', {
    storageDir,
    configKeys: Object.keys(config).length,
    autoLogin: config.autoLogin,
    servicesFound: Object.keys(services).sort(),
    serviceProblems,
    sessionCwd,
    sessionCwdSource,
    hasWebServerRegister: typeof webServer?.register === 'function',
    hasAgentsService: Boolean(agents),
    hasEffect: typeof ctx?.effect === 'function',
  })

  if (sessionCwdSource === 'package-parent-fallback') {
    // Loud on purpose. Nothing configured this and DSH had no default recorded, so the agent's workspace
    // is the folder containing the plugin — almost certainly not what the operator wants. Silence in this
    // exact situation is what let the previous default go unnoticed through an entire install-and-test.
    status.note(
      'warn',
      `no workspace configured and DSH records no default; falling back to the package's parent (${sessionCwd})`,
    )
    log(
      'warn',
      `sessionCwd fell back to the package's parent directory (${sessionCwd}); ` +
        'set `sessionCwd` in the plugin config, or open a workspace in DSH so one gets recorded',
    )
  } else {
    log('info', `sessionCwd=${sessionCwd} (source: ${sessionCwdSource})`)
  }

  // ── Discover the model instead of making the user configure it ───────────────────────────────
  //
  // Asked of the service that owns the default, which is the documented path — its job is to answer
  // "which model should a new agent use?". `process.cwd()` is the profile directory for a running
  // DSH, which is where the fallback reads `cordis.patch.yml` from.
  const agentModel = discoverModel({
    configured: {
      provider: config.agentProvider,
      model: config.agentModel,
      reasoningEffort: config.reasoningEffort,
    },
    defaultModelService: agentDefaultModel,
    profileDir: process.cwd(),
  })
  status.set('model:resolved', {
    provider: agentModel.provider,
    model: agentModel.model,
    reasoningEffort: agentModel.reasoningEffort,
    source: agentModel.source,
    detail: agentModel.detail,
  })
  log(
    'info',
    `model: ${agentModel.model} (provider=${agentModel.provider}, effort=${agentModel.reasoningEffort}), ` +
      `source=${agentModel.source}`,
  )
  if (agentModel.source === 'fallback') {
    log(
      'warn',
      'could not discover this machine\'s default model (no live agent to copy, and no ' +
        'agent-default-model row readable in the profile), so the built-in defaults are in use. ' +
        'If turns come back empty, set agentProvider / agentModel explicitly.',
    )
  }

  /** Shared with the HTTP login route: it is the only channel for a pairing code. */
  const login = {
    /** @type {'idle'|'awaiting-scan'|'need-code'|'connected'|'failed'} */
    status: 'idle',
    /** @type {{ savedPath: string|null, link: string|null, note: string|null }|null} */
    qr: null,
    /** @type {string} */
    prompt: '',
    /** @type {string} */
    message: '',
    /** @type {((code: string) => void)|null} */
    submitCode: null,
  }

  const client = new ILinkClient({
    stateDir: storageDir,
    baseUrl: config.apiBaseUrl,
    channelVersion: config.channelVersion,
    botAgent: config.botAgent,
    log: (level, message) => log(level, `[ilink] ${message}`),
    onStaleToken: (info) => {
      login.status = 'failed'
      login.message = 'bot token 已失效（-14），需要重新扫码登录'
      log('error', `stale token for account ${info?.accountId ?? '(unknown)'}: relogin required`)
    },
  })

  // ── Diagnostics wiring ────────────────────────────────────────────────────────────
  //
  // `ctx.logger` output is not reachable from outside the running app, and the message path had
  // no status markers at all — which is why the first real message failed invisibly: the typing
  // indicator appeared and then stopped, and nothing recorded why. Both collaborators below
  // already log at exactly the points that matter (`#loadLlm` prints a precise reason on
  // failure; the bridge narrates every stage), so their `log` callbacks are mirrored into the
  // status file. This needs no change to either module.
  const portLog = (level, message) => {
    log(level, message)
    try {
      status.set(`agent:${level}`, { message: String(message) })
    } catch {
      /* a diagnostic must never disturb the channel */
    }
  }

  const bridgeLog = (message, detail) => {
    log('debug', detail === undefined ? message : `${message} ${safeJson(detail)}`)
    try {
      status.set(`msg:${message}`, detail === undefined ? {} : { detail })
    } catch {
      /* as above */
    }
  }

  const agentPort = new DshAgentPort({
    ctx,
    // The agent service, resolved above without `inject`. Passing it in keeps every service
    // read in one place: `ctx.agents` throws from inside the port otherwise.
    agents,
    // The workspace each WeChat conversation runs in; see `sessionCwd`.
    cwd: sessionCwd,
    // The toolset each conversation gets; see `agentPreset`.
    agentPreset: config.agentPreset,
    // The model each conversation uses. Discovered rather than configured — see `discoverModel`.
    agentOptions: {
      provider: agentModel.provider,
      model: agentModel.model,
      reasoningEffort: agentModel.reasoningEffort,
    },
    log: portLog,
    replyTimeoutMs: config.replyTimeoutMs,
    // Called once per session, as soon as a live agent exists for it.
    onSessionReady: attachToWorkspace,
  })

  // ── Attach each conversation to its workspace project ─────────────────────────────
  //
  // ⚠️ Without this the session stays in the GUI's "未分组" (ungrouped) bucket forever, even though
  // its cwd is correct and it does get a generated title. Grouping comes from
  // `@deepseek-ai/dsh-workspace`: `ctx.workspaceRegistry` holds durable project records plus an
  // ordered account of session ids, and membership requires BOTH an accounted id AND a session
  // header whose canonical cwd equals the project path. The registry bootstraps that account from
  // persisted session headers exactly once — "it never re-bootstraps" — so a session created after
  // that bootstrap is never grouped on its own.
  //
  // `create(path)` is idempotent per canonical path (it returns an existing project unchanged), so
  // this both finds the project and, on a fresh machine, creates it.
  async function attachToWorkspace(sessionId) {
    // Every outcome is mirrored into the status file, not just the log. The first version of this
    // function reported only through `ctx.logger`, which is unreadable from outside the app — so a
    // failure here was completely silent, which is exactly the class of bug this project kept hitting.
    if (!workspaceRegistry) {
      const available = Object.keys(services).sort()
      status.set('workspace:registry-unavailable', { probed: available, cwd: sessionCwd })
      log('warn', `ctx.workspaceRegistry is unavailable (found: ${available.join(', ') || 'none'})`)
      return
    }
    try {
      const workspace = await workspaceRegistry.create(sessionCwd)
      if (!workspace || typeof workspace.attachSession !== 'function') {
        status.set('workspace:no-attach-method', {
          ownKeys: workspace ? Object.keys(workspace).sort() : null,
          prototypeKeys: workspace ? Object.getOwnPropertyNames(Object.getPrototypeOf(workspace)) : null,
        })
        log('warn', 'the workspace entity exposes no attachSession(); the session will stay ungrouped')
        return
      }
      await workspace.attachSession(sessionId)
      status.set('workspace:attached', {
        sessionId,
        workspaceId: String(workspace.id ?? ''),
        path: workspace.path,
        title: workspace.title,
      })
      log('info', `attached session ${sessionId} to workspace "${workspace.title}" (${workspace.path})`)
    } catch (err) {
      status.set('workspace:attach-failed', { sessionId, message: describeError(err) })
      log('warn', `could not attach ${sessionId} to its workspace: ${describeError(err)}`)
    }
  }

  /**
   * Tell the user, in one line, that an attachment could not be sent.
   *
   * ⚠️ This is the other half of why the agent is told *not* to hedge. The agent cannot check whether a
   * file exists, so left to itself it explains its limitations and lists failure modes — while the
   * plugin already knows exactly what went wrong. Reporting it here keeps the explanation where the
   * knowledge is, and keeps it to one line instead of a paragraph of speculation.
   */
  async function notifyAttachmentFailure(peerId, contextToken, reason) {
    try {
      await client.sendText(`（附件发送失败：${reason}）`, { toUserId: peerId, contextToken })
    } catch (err) {
      log('warn', `could not report an attachment failure to ${peerId}: ${describeError(err)}`)
    }
  }

  /**
   * Upload one file the agent asked to send, and post it as its own message.
   *
   * ⚠️ Separate from the text send on purpose: the protocol requires the explanation and the media to
   * travel as two `sendmessage` requests with independent `client_id`s. Failures are reported, never
   * thrown — a failed attachment must not turn into a lost reply.
   *
   * @param {{peerId: string, contextToken: string, path: string}} request
   * @returns {Promise<void>}
   */
  async function sendMedia(request) {
    const { peerId, contextToken, path } = request

    let bytes
    try {
      bytes = readFileSync(path)
    } catch (err) {
      status.set('outbound:unreadable', { path, message: describeError(err) })
      log('warn', `the agent asked to send ${path}, which cannot be read: ${describeError(err)}`)
      await notifyAttachmentFailure(peerId, contextToken, `${path} 读取失败`)
      return
    }

    // The protocol's own media_type, guessed from the extension. A wrong guess here is rejected by the
    // upload rather than silently mis-sent, and the reason lands in the status file.
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(path)
    const result = await uploadMedia({
      bytes,
      mediaType: isImage ? UPLOAD_MEDIA_TYPE.IMAGE : UPLOAD_MEDIA_TYPE.FILE,
      toUserId: peerId,
      fileName: basename(path),
      requestUploadUrl: (req) => client.getUploadUrl(req),
      fetchImpl: fetch,
    })
    if (!result.ok) {
      status.set('outbound:upload-failed', { path, bytes: bytes.length, reason: result.reason })
      log('warn', `could not upload ${path}: ${result.reason}`)
      await notifyAttachmentFailure(peerId, contextToken, `${basename(path)} 上传失败`)
      return
    }

    try {
      await client.sendItems([result.item], { toUserId: peerId, contextToken })
      status.set('outbound:sent', {
        path,
        bytes: result.rawSize,
        cipherBytes: result.fileSize,
        mediaType: isImage ? 'image' : 'file',
      })
      log('info', `sent ${path} to ${peerId} (${result.rawSize} bytes)`)
    } catch (err) {
      status.set('outbound:send-failed', { path, message: describeError(err) })
      log('warn', `uploaded ${path} but sending it failed: ${describeError(err)}`)
      await notifyAttachmentFailure(peerId, contextToken, `${basename(path)} 发送失败`)
    }
  }

  /** `ChannelPort` over the protocol client — see the typedef in bridge.js. */
  const channel = {
    async sendText({ peerId, text, contextToken }) {
      // ── The reply convention: strip any media requests before the text goes out ──────────────
      //
      // ⚠️ The two halves ship together on purpose. Telling the agent about the convention without
      // parsing replies here would leave `[wechat-send: …]` lines visible to the user in WeChat —
      // worse than not having the convention at all.
      //
      // When nothing is requested the original text is sent unchanged, so the working reply path is
      // untouched in the common case.
      const { text: visible, requests, malformed } = extractMediaRequests(text)
      if (malformed.length > 0) {
        log('warn', `reply carried ${malformed.length} malformed media marker(s); left visible`)
      }

      try {
        // The client throws on a business failure; the bridge wants a verdict instead.
        const resp = await client.sendText(requests.length > 0 ? visible : text, {
          toUserId: peerId,
          contextToken,
        })
        // Explanation first, then each attachment as its own message.
        for (const request of requests) {
          await sendMedia({ peerId, contextToken, path: request.path })
        }
        return { ok: true, ret: resp?.ret }
      } catch (err) {
        const anyErr = /** @type {any} */ (err)
        return {
          ok: false,
          ret: anyErr?.ret,
          errcode: anyErr?.errcode,
          errmsg: describeError(err),
        }
      }
    },
    async startTyping(peerId, contextToken) {
      // getConfig supplies the typing_ticket; neither step is allowed to block the reply.
      try {
        await client.getConfig({ ilinkUserId: peerId, contextToken })
      } catch (err) {
        log('debug', `getConfig failed (typing indicator only, ignored): ${describeError(err)}`)
      }
      try {
        await client.startTyping(peerId, contextToken)
      } catch (err) {
        log('debug', `startTyping failed (ignored): ${describeError(err)}`)
      }
    },
    async stopTyping(peerId) {
      try {
        await client.stopTyping(peerId)
      } catch (err) {
        log('debug', `stopTyping failed (ignored): ${describeError(err)}`)
      }
    },
  }

  /**
   * Fetch, decrypt and save the first media item of an inbound message, then describe it to the agent.
   *
   * ⚠️ Delivery choice: the bytes are saved **inside the session workspace** and the agent is told the
   * path, rather than being handed an `ImageBlock`. DSH projects an `ImageBlock` to a real image only
   * for image-capable routes and to a stable placeholder otherwise, and a `FileBlock` never reaches an
   * adapter at all — it becomes handle text naming the file's read-only path. So both routes are safe;
   * the path form simply needs no attachment service and works today. Upgrading to a true `ImageBlock`
   * is an enhancement, not a correctness fix.
   *
   * Saving *inside the workspace* is the part that matters: the agent's file access is scoped to its
   * workspace, so a file under `.state/` would be described to it and still unreadable.
   *
   * @param {any} msg
   * @param {string} peerId
   * @returns {Promise<{ text: string }|{ text: null, reason: string }>}
   */
  async function describeMedia(msg, peerId) {
    const found = firstMediaItem(msg)
    if (!found) return { text: null, reason: 'unsupported item_list (no text, no transcript, no media)' }

    const label = kindLabel(found.itemType)
    const result = await downloadMedia({
      item: found.item,
      itemType: found.itemType,
      cdnBaseUrl: client.cdnBaseUrl,
      fetchImpl: fetch,
    })
    if (!result.ok) {
      status.set('media:failed', { itemType: found.itemType, peerId, reason: result.reason })
      return { text: null, reason: `media download failed: ${result.reason}` }
    }

    // A recognisable name helps both the agent and the user. The protocol carries a real filename for
    // files; everything else is named from its kind and the sender.
    const container = found.item?.[found.itemType === ITEM_FILE ? 'file_item' : ''] ?? null
    const rawName = typeof container?.file_name === 'string' ? container.file_name : ''
    const safeName = rawName.replace(/[^\w.-]+/g, '_').slice(0, 60)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const stem = safeName || `${label}-${String(peerId).slice(0, 8)}`
    const dir = join(sessionCwd, '.wechat-media')
    const filePath = join(dir, `${stamp}-${stem}.${result.ext}`)

    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(filePath, result.bytes)
    } catch (err) {
      status.set('media:save-failed', { filePath, message: describeError(err) })
      return { text: null, reason: `saving media failed: ${describeError(err)}` }
    }

    const extras = []
    if (found.itemType === ITEM_VOICE) {
      const transcript = found.item?.voice_item?.text
      if (typeof transcript === 'string' && transcript.trim()) extras.push(`语音转写：${transcript.trim()}`)
    }
    if (found.itemType === ITEM_FILE && safeName) extras.push(`原文件名：${rawName}`)
    if (result.note) extras.push(`解密备注：${result.note}`)

    // ── Two captions, because there are two different deliveries ─────────────────────────────────
    //
    // An admitted image block already carries the pixels, so its caption must **not** name a path or
    // tell the agent to go read a file. That instruction is actively misleading when the session has
    // no file tool — which is exactly the state that made a working pipeline look broken — and the
    // path is something the model cannot use. The path still reaches the status file, where a human
    // can find it.
    //
    // Files and voice keep the path form with the instruction, because for them that line **is** the
    // delivery (the protocol's own convention is a handle naming the read path). It is also the
    // fallback whenever an image cannot be admitted.
    const imageCaption = `[微信${label}] 用户发来一张${label}。`

    const pathText = [
      `[微信${label}]`,
      `用户发来一个${label}，已保存到：${filePath}`,
      `大小 ${result.bytes.length} 字节，类型 ${result.mime}`,
      ...extras,
      '请先用文件工具读取这个文件再回答；如果读不到内容，就如实说明你拿不到它。',
    ].join('\n')

    status.set('media:saved', {
      itemType: found.itemType,
      filePath,
      bytes: result.bytes.length,
      mime: result.mime,
      encrypted: result.encrypted,
      keySource: result.keySource,
    })

    // ── An image has a better route than a path ─────────────────────────────────────────────────
    //
    // Admitting the bytes as an attachment puts a real image block into the message, so the model
    // receives pixels instead of a filename. DSH projects that block to a real image for an
    // image-capable route and to a stable placeholder otherwise, so the same call is safe either way —
    // and it needs no file tool at all, which is why images can work before the toolset question is
    // settled. Files and voice keep the path form on purpose: a file block never reaches an adapter,
    // and the protocol's own convention for them is a handle line naming the read path.
    //
    // ⚠️ Admission refuses a batch as a whole — "if any image is refused, the whole message fails and
    // nothing is published", which is strictly worse than degrading. So every failure here falls back
    // to the text path and the message still goes out.
    if (found.itemType === ITEM_IMAGE && attachments && typeof attachments.admitPromptContent === 'function') {
      try {
        const admitted = await attachments.admitPromptContent([
          { type: 'text', text: imageCaption },
          {
            type: 'image',
            // Must be canonical base64: the store decodes and re-encodes, rejecting any other form.
            // `Buffer.toString('base64')` is canonical by construction.
            data: result.bytes.toString('base64'),
            mediaType: result.mime,
            name: filePath.split(/[\\/]/).pop() ?? undefined,
          },
        ])
        status.set('media:image-admitted', { filePath, mediaType: result.mime, parts: admitted.length })
        return { content: admitted }
      } catch (err) {
        status.set('media:image-admit-failed', { filePath, message: describeError(err) })
        log('warn', `image could not be admitted as an image block; falling back to its path: ${describeError(err)}`)
      }
    }

    return { text: pathText }
  }

  // A capability marker, so that "is the running code the code I just wrote?" is answerable from the
  // log rather than inferred. A whole test cycle was lost to exactly that question: media messages
  // were dropped with the pre-change refusal string, which looked like a media bug and was in fact an
  // un-reloaded module. Anything whose presence matters at runtime should announce itself here.
  const mediaDir = join(sessionCwd, '.wechat-media')
  status.set('media:enabled', {
    inbound: true,
    itemTypes: '2 image / 3 voice / 4 file / 5 video',
    maxBytes: 100 * 1024 * 1024,
    dir: mediaDir,
  })
  log('info', `inbound media enabled (image/voice/file/video) -> ${mediaDir}`)

  // ── Why does a new session get almost no tools? ──────────────────────────────────────────────
  //
  // The preset reached the session header (`session header keys=[…,agentPreset]`), yet the agent
  // exposed exactly one tool. The registry's documentation narrows that to two causes needing
  // opposite fixes: either the `standard` declaration mounts almost nothing, or its rows fail to
  // mount — "an import failure, a missing service, or a service leaked to the global scope all
  // refuse the mount". `read` renders a declaration's sub-plugin list, which separates the two.
  //
  // Observation only: it changes no behaviour, and it writes into the status file rather than only
  // to a logger that cannot be read from outside the app.
  if (!agentPresets) {
    status.set('preset:registry-unavailable', { probed: Object.keys(services).sort() })
    log('warn', 'ctx.agentPresets is unavailable, so the preset declaration cannot be inspected')
  } else {
    // Detached, not awaited: `apply` is not an `async` function (a top-level `await` here is a syntax
    // error, which is how this was caught), and a rejection escaping a detached call is fatal in DSH.
    // So the whole body is wrapped and handed to `runDetached`, which owns the catch.
    runDetached(async () => {
      try {
        const declaration =
          typeof agentPresets.read === 'function' ? await agentPresets.read(config.agentPreset) : null
        status.set('preset:declaration', {
          id: config.agentPreset,
          readAvailable: typeof agentPresets.read === 'function',
          declaration:
            typeof declaration === 'string' ? declaration.slice(0, 2000) : (declaration ?? null),
        })
        log(
          'info',
          `preset "${config.agentPreset}" declaration captured ` +
            `(${typeof declaration === 'string' ? declaration.length : 0} chars)`,
        )
      } catch (err) {
        status.set('preset:read-failed', { id: config.agentPreset, message: describeError(err) })
        log('warn', `could not read preset "${config.agentPreset}": ${describeError(err)}`)
      }
    })
  }

  /**
   * Per-peer count of inbound prompts, so the channel briefing goes out first and then periodically.
   * Keyed by peer rather than by session because `extractText` only ever sees the message.
   *
   * @type {Map<string, number>}
   */
  const briefingCounts = new Map()

  const bridge = new WeixinBridge({
    channel,
    agent: agentPort,
    // Wrap the protocol's reader so text prompts carry the channel briefing.
    //
    // ⚠️ The empty-string case must stay empty: the bridge uses "extractText produced nothing" to
    // decide whether to try the media path, so appending a briefing there would silently stop images
    // and files from ever being fetched.
    //
    // The briefing goes out on the first prompt of a conversation and then every `briefingInterval`
    // prompts: the standing instruction this channel cannot install in the system prompt belongs to the
    // preset, which a plugin cannot bind, so the inbound prompt is the only surface left.
    extractText: (msg) => {
      const text = extractTextFromMessage(msg)
      if (text.length === 0) return text
      const peer = String(/** @type {any} */ (msg)?.from_user_id ?? '')
      const seen = (briefingCounts.get(peer) ?? 0) + 1
      briefingCounts.set(peer, seen)
      return briefingDue(seen, config.briefingInterval) ? `${text}\n\n${channelBriefing()}` : text
    },
    describeMedia,
    maxReplyChars: config.maxReplyChars,
    typingIndicator: config.typingIndicator,
    log: bridgeLog,
    onError: (err, context) => {
      const message = describeError(err)
      // The failure that matters most, recorded where it can actually be read.
      try {
        status.set(`msg:error:${context}`, { message })
      } catch {
        /* ignore */
      }
      log('error', `${context}: ${message}`)
    },
  })

  // ── Login routes ───────────────────────────────────────────────────────────────
  //
  // A QR code is interactive: the user must scan it, and may then have to type a numeric
  // pairing code. A server-side plugin has no terminal, so the code is collected over HTTP.
  // Pushing a custom card into the Web GUI would need a *client* plugin with a bundle
  // build, which the no-build constraint rules out.
  //
  // ⚠️ The web-server service is documented in the bundled notes as exposing
  // `register({ kind: 'exact', path, handler })` and returning a disposer. It may be absent,
  // so registration is attempted and degrades to "the QR link is only in the log".
  //
  // The service object was resolved above without `inject`, so it must NOT be read from `ctx`
  // here — `ctx.webServer` is precisely the access that threw before.
  if (config.enableQrRoute) {
    ctx.effect(() => {
      /** @type {Array<() => void>} */
      const disposers = []
      try {
        const register = webServer?.register
        if (typeof register !== 'function') {
          log('warn', 'the web-server service is unavailable; the QR code will only appear in this log')
          return () => {}
        }
        disposers.push(
          register.call(webServer, {
            kind: 'exact',
            path: `${config.qrRoutePath}.png`,
            handler: (req, res) => runDetached(() => serveQrPng(res, login), (e) => log('warn', describeError(e))),
          }),
        )
        disposers.push(
          register.call(webServer, {
            kind: 'exact',
            path: config.qrRoutePath,
            handler: (req, res) =>
              runDetached(() => serveQrPage(req, res, login), (e) => log('warn', describeError(e))),
          }),
        )
        log('info', `login page available at ${config.qrRoutePath}`)
      } catch (err) {
        log('warn', `could not register the login route: ${describeError(err)}`)
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    })
  }

  // ── The long-poll loop ─────────────────────────────────────────────────────────
  //
  // [R2]: `ac.abort()` and `await running` live in one effect, because separate async
  // disposers are not ordered.
  ctx.effect(() => {
    const ac = new AbortController()
    const running = main(ac.signal).catch((err) => {
      // `main` is written not to reject; this is the last line of defence for [R1].
      log('error', `weixin channel stopped unexpectedly: ${describeError(err)}`)
    })
    return async () => {
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
      await running
    }
  })

  /**
   * Everything the channel does, from login to polling. **Never rejects.**
   *
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async function main(signal) {
    try {
      status.set('main:start', { aborted: signal.aborted })
      agentPort.start()

      // ── Restore the stored account BEFORE deciding whether to log in ───────────────
      //
      // ⚠️ `getAccount()` reads IN-MEMORY state only, so on a fresh process it is always null.
      // The original code therefore never reached its own resume branch, and every restart
      // re-opened the QR login instead of resuming the long poll — which is exactly why WeChat
      // began reporting "暂无法连接 Open Claw" after a restart: the bot was offline, waiting for
      // a scan that nobody was going to do. The account has to be loaded from disk first:
      // `listLocalAccountIds()` finds the stored account ids, and `setAccountById()` both loads
      // it and installs it in memory.
      let account = client.getAccount()
      if (!account && typeof client.listLocalAccountIds === 'function') {
        try {
          const ids = await client.listLocalAccountIds()
          if (Array.isArray(ids) && ids.length > 0) {
            account = (await client.setAccountById(ids[0])) ?? client.getAccount()
            status.set('account:restored', {
              accountId: ids[0],
              candidateCount: ids.length,
              restored: Boolean(account),
            })
          } else {
            status.set('account:none-stored')
          }
        } catch (err) {
          status.set('account:restore-failed', { message: describeError(err) })
          log('warn', `could not restore the stored account: ${describeError(err)}`)
        }
      }

      if (!account) {
        if (!config.autoLogin) {
          log('warn', 'no stored WeChat account and autoLogin is false; not starting the channel')
          return
        }
        status.set('login:start')
        log('info', 'no stored WeChat account; starting QR login')
        const result = await client.login({
          abortSignal: signal,
          onQrCode: (session) => {
            // `login` accepts an async hook; failures here must not abort the login.
            return handleQrCode(session).catch((err) => {
              log('warn', `could not materialise the QR code: ${describeError(err)}`)
            })
          },
          // Named `qrStatus`, not `status`: the latter is the status writer in this scope.
          onStatus: (qrStatus) => {
            if (qrStatus && qrStatus !== 'wait') log('info', `QR status: ${qrStatus}`)
          },
          onNeedVerifyCode: (prompt, isRetry) => waitForVerifyCode(prompt, isRetry),
        })
        if (!result?.connected) {
          login.status = 'failed'
          login.message = result?.message ?? '登录未完成'
          status.set('login:failed', { message: login.message })
          log('error', `login did not complete: ${login.message}`)
          return
        }
        login.status = 'connected'
        login.message = '登录成功'
        status.set('login:connected')
        log('info', 'WeChat login succeeded')
      } else {
        status.set('account:ready', { botId: account.ilink_bot_id ?? '' })
      }

      if (signal.aborted) return

      await client.notifyStart().catch((err) => log('warn', `notifyStart failed: ${describeError(err)}`))

      const botId = client.getAccount()?.ilink_bot_id ?? ''
      status.set('poll:start', { botId })
      const handle = client.runPollLoop({
        abortSignal: signal,
        onMessage: (msg) => bridge.handleInbound(msg, { botId }),
        onError: (err, consecutiveFailures) => {
          log('warn', `poll failure #${consecutiveFailures}: ${describeError(err)}`)
        },
        onTick: () => {
          /* deliberately quiet: a healthy long poll ticks every ~35s */
        },
      })

      try {
        // `done` never rejects (documented in the client).
        await handle.done
      } finally {
        try {
          await handle.stop()
        } catch {
          /* ignore */
        }
        bridge.dispose()
        await bridge.drain()
        agentPort.dispose()
        try {
          // Independent short timeout, after the long poll has been cancelled.
          await client.notifyStop()
        } catch (err) {
          log('debug', `notifyStop failed (ignored): ${describeError(err)}`)
        }
      }
    } catch (err) {
      log('error', `weixin channel crashed: ${describeError(err)}`)
    }
  }

  /**
   * Fetch and materialise the QR code, then publish it to the log and the HTTP page.
   *
   * @param {any} session
   * @returns {Promise<void>}
   */
  async function handleQrCode(session) {
    const raw = session?.qrcodeImgContent ?? session?.qrcode_img_content ?? ''
    const materialised = await materializeQrImage(raw, { dir: storageDir })
    login.qr = {
      savedPath: materialised.savedPath,
      link: materialised.link,
      note: materialised.note,
    }
    login.status = 'awaiting-scan'

    // ── Publish the login handoff where the user will actually look ──────────────────────────
    //
    // ⚠️ This exists because the HTTP login page cannot be relied on. `@deepseek-ai/dsh-host-webserver`
    // provides `ctx.webServer` with `register(route)`, but that name did not resolve from a plugin
    // here, and the package's own documentation says the Electron window loads the GUI over
    // `file://` and carries fetch over IPC rather than HTTP — so a route would not reach that window
    // even if it registered. A file in the *workspace* works in every case, because the GUI already
    // shows the workspace; `.state/` is hidden from it.
    const handoffPath = join(sessionCwd, LOGIN_FILE_NAME)
    const codePath = join(sessionCwd, VERIFY_CODE_FILE_NAME)
    let handoffWritten = false
    if (materialised.link) {
      try {
        writeFileSync(
          handoffPath,
          [
            '# 微信 ClawBot 登录',
            '',
            '用浏览器打开下面这个链接，然后拿手机微信扫码：',
            '',
            materialised.link,
            '',
            '（这个链接就是登录凭据，几分钟内有效，不要转发给别人。）',
            materialised.savedPath ? `二维码文件：${materialised.savedPath}` : '',
            materialised.note ? `备注：${materialised.note}` : '',
            '',
            `如果微信向你索取配对码，把收到的数字写进这个文件：${codePath}`,
            '插件每 2 秒读一次，读到就会删掉它。',
            '',
          ]
            .filter((line) => line !== '')
            .join('\r\n'),
          'utf8',
        )
        handoffWritten = true
      } catch (err) {
        log('warn', `无法写入登录文件 ${handoffPath}：${describeError(err)}`)
      }
    }

    status.set('qr:materialized', {
      kind: materialised.kind,
      savedPath: materialised.savedPath,
      // The link IS the login credential for the next few minutes, and it is recorded here on
      // purpose: the optional HTTP login page is not guaranteed to exist, and this file is the
      // one channel that is. It expires with the QR session and sits beside the bot token,
      // which is at least as sensitive.
      link: materialised.link,
      note: materialised.note,
      loginFile: handoffWritten ? handoffPath : null,
      codeFile: codePath,
    })
    log('info', describeQrForUser(materialised, { expiresInSeconds: 300 }))
    if (handoffWritten) {
      log('info', `登录链接已写入 ${handoffPath}（就在工作区根目录，打开工作区即可看到）`)
    }

    // Opening the default browser removes the copy-and-paste step entirely. Gated because it is a
    // visible desktop side effect, and scheme-checked because the link comes from a remote API:
    // only http(s) and the WeChat deep-link scheme are ever handed to the OS.
    if (config.openLoginUrl && materialised.link) {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(String(materialised.link))?.[1]?.toLowerCase() ?? ''
      if (scheme === 'https' || scheme === 'http' || scheme === 'weixin') {
        try {
          // `rundll32 url.dll,FileProtocolHandler` hands the URL to the default handler WITHOUT a
          // shell, so an `&` or `|` inside the URL cannot be re-parsed as a command. `cmd /c start`
          // would re-parse it and is therefore avoided on purpose.
          spawn('rundll32.exe', ['url.dll,FileProtocolHandler', String(materialised.link)], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }).unref()
          status.set('qr:opened-browser', { link: materialised.link })
        } catch (err) {
          log('warn', `无法自动打开浏览器：${describeError(err)}`)
        }
      } else {
        status.set('qr:skipped-open', { scheme, reason: 'unexpected scheme; not handed to the OS' })
      }
    }

    if (config.enableQrRoute) {
      log('info', `也可以在浏览器打开 ${config.qrRoutePath} 查看二维码`)
    }
  }

  /**
   * Ask for the numeric pairing code and wait for it, but never forever: an unanswered promise
   * inside the login flow would linger past disposal. On timeout the empty string is submitted,
   * which the client treats as "no code given".
   *
   * Two input channels, because neither is guaranteed:
   *   - the optional HTTP login page, which calls `login.submitCode`;
   *   - **a file**, `<storageDir>/verify-code.txt`, polled every 2 seconds. This is the channel
   *     that always works: the HTTP route depends on a service whose exact name is still
   *     unverified, and the first attempt at it returned 404. The user writes the digits into
   *     that file and the plugin picks them up and deletes it.
   *
   * @param {string} prompt
   * @param {boolean} isRetry
   * @returns {Promise<string>}
   */
  function waitForVerifyCode(prompt, isRetry) {
    login.status = 'need-code'
    login.prompt = `${prompt}${isRetry ? '（上次输入不正确）' : ''}`

    // The workspace file is listed first because it is the one the user can see without hunting:
    // the GUI shows the workspace, and `.state/` is hidden from it. The older `.state/` path stays
    // in the list so an existing habit keeps working.
    const codeFiles = [join(sessionCwd, VERIFY_CODE_FILE_NAME), join(storageDir, 'verify-code.txt')]
    status.set('login:need-code', {
      prompt: login.prompt,
      writeCodeTo: codeFiles[0],
      alsoAccepted: codeFiles[1],
    })

    return new Promise((resolve) => {
      let settled = false
      /** @param {string} code */
      const finish = (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(poller)
        login.submitCode = null
        resolve(code)
      }

      const timer = setTimeout(() => {
        login.prompt = '等待配对码超时'
        status.set('login:code-timeout', { codeFiles })
        finish('')
      }, VERIFY_CODE_WAIT_MS)

      // The file channel. Fully wrapped: a missing file is the normal case, and a callback that
      // threw here would be an uncaught exception in a timer, which DSH treats as fatal.
      const poller = setInterval(() => {
        try {
          /** @type {string|null} */
          let raw = null
          /** @type {string|null} */
          let used = null
          for (const candidate of codeFiles) {
            if (!existsSync(candidate)) continue
            const text = readFileSync(candidate, 'utf8').trim()
            if (!text) continue
            raw = text
            used = candidate
            break
          }
          if (raw === null || used === null) return
          try {
            unlinkSync(used)
          } catch {
            /* leaving the file behind is harmless; the code is what matters */
          }
          const digits = raw.replace(/\D+/g, '')
          if (digits) {
            status.set('login:code-received', { source: 'file', file: used, digits: digits.length })
            finish(digits)
          }
        } catch {
          /* ignore and retry on the next tick */
        }
      }, 2_000)

      login.submitCode = finish
    })
  }

  status.set('apply:ready', { statusFile: status.file })
  log('info', `weixin-clawbot loaded (storage: ${storageDir}; status: ${status.file})`)
}

/**
 * Read named services from the context **without declaring `inject`**.
 *
 * ⚠️ Cordis's context is a Proxy whose `get` trap throws for a service property the plugin has
 * not declared in `inject`:
 *
 *     Error: cannot get property "webServer" without inject
 *
 * (vendor/cordis/src/reflect.ts, `ReflectService.handler.get`.) Optional chaining does not
 * help — the trap itself throws. `ctx.reflect.get(name, false)` is documented in that same
 * file as "read a service from the store without the inject requirement", so it is the way to
 * read a service from a plugin that does not want to commit to an `inject` declaration.
 *
 * Declaring `inject` is not used here on purpose: a listed name that does not exist leaves the
 * entry waiting for a service that never arrives, and these names cannot be verified from
 * outside (`webServer` vs `webserver`, `agents` vs `agent`). Probing candidates is safer.
 *
 * Never throws: every read is guarded, and names that resolve to nothing are simply absent.
 *
 * @param {any} ctx
 * @param {string[]} names candidate service names, in preference order
 * @returns {Record<string, any>} the subset of `names` that resolved
 */
function readServices(ctx, names, problems) {
  /** @type {Record<string, any>} */
  const found = {}

  /** @type {any} */
  let reflect = null
  try {
    reflect = ctx?.reflect
  } catch (err) {
    problems?.push({ name: '$reflect', error: describeError(err) })
    reflect = null
  }

  for (const name of names) {
    /**
     * ⚠️ Recorded, not swallowed. The first version of this function reported the same "not found"
     * for "this service does not exist" and for "reading it threw", which hid the real reason
     * behind two separate dead ends — `ctx.webServer` (which `@deepseek-ai/dsh-host-webserver`
     * really does provide, as `ctx.webServer`) and `ctx.workspaceRegistry`.
     *
     * @type {string}
     */
    let viaReflect = 'returned a falsy value'
    try {
      const value = reflect && typeof reflect.get === 'function' ? reflect.get(name, false) : undefined
      if (value) {
        found[name] = value
        continue
      }
    } catch (err) {
      viaReflect = describeError(err)
    }

    try {
      const direct = ctx?.[name]
      if (direct) {
        found[name] = direct
        continue
      }
      problems?.push({ name, viaReflect, direct: 'returned a falsy value' })
    } catch (err) {
      problems?.push({ name, viaReflect, direct: describeError(err) })
    }
  }
  return found
}

/**
 * Build a printf-free logger.
 *
 * ⚠️ `ctx.logger` is a *callable* service: `logger(name?)` returns a facade with
 * `.error/.info/.warn/.debug`. It is passed in already resolved (see `readServices`), because
 * reading `ctx.logger` directly would throw for exactly the reason `ctx.webServer` did. When
 * it is absent the fallback forwards to `console`, so the plugin still reports.
 *
 * @param {any} ctx
 * @param {any} loggerService the resolved logger service, or null
 * @param {(level: string, message: string) => void} [mirror] receives every line, whatever the sink
 * @returns {(level: string, message: string) => void}
 */
function makeLogger(ctx, loggerService, mirror) {
  /** @type {Record<string, (s: string) => void>|null} */
  let facade = null
  try {
    if (typeof loggerService === 'function') {
      const candidate = loggerService.call(ctx, 'weixin-clawbot')
      if (candidate && typeof candidate === 'object') facade = candidate
    } else if (loggerService && typeof loggerService === 'object') {
      facade = loggerService
    }
  } catch {
    facade = null
  }

  return (level, message) => {
    const text = String(message)

    // Mirror first, and outside the facade branch below. The whole point of `mirror` is that nothing
    // can be invisible, so the file must receive the line no matter which sink ends up handling it —
    // and that branch returns early.
    try {
      mirror?.(level, text)
    } catch {
      /* a diagnostic must never disturb the channel */
    }

    try {
      const fn = facade?.[level]
      if (typeof fn === 'function') {
        fn.call(facade, text)
        return
      }
    } catch {
      /* fall through to console */
    }
    // eslint-disable-next-line no-console
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(`[weixin-clawbot] ${text}`)
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * @param {any} res
 * @param {any} login
 * @returns {Promise<void>}
 */
async function serveQrPng(res, login) {
  const path = login?.qr?.savedPath
  if (!path) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('no QR image available')
    return
  }
  const bytes = await readFile(path)
  res.writeHead(200, { 'content-type': pngContentTypeFor(path), 'cache-control': 'no-store' })
  res.end(bytes)
}

/**
 * @param {any} req
 * @param {any} res
 * @param {any} login
 * @returns {Promise<void>}
 */
async function serveQrPage(req, res, login) {
  const url = new URL(req?.url ?? '/', 'http://127.0.0.1')
  const code = url.searchParams.get('code')
  if (code && typeof login?.submitCode === 'function') {
    login.submitCode(code.trim())
    res.writeHead(303, { location: url.pathname })
    res.end()
    return
  }

  const status = String(login?.status ?? 'idle')
  const note = login?.qr?.note ? `<p class="note">${escapeHtml(login.qr.note)}</p>` : ''
  const link = login?.qr?.link
    ? `<p>二维码链接（可发到「文件传输助手」后在手机上打开）：<br><a href="${escapeHtml(login.qr.link)}">${escapeHtml(login.qr.link)}</a></p>`
    : ''
  const image = login?.qr?.savedPath
    ? `<p><img src="qr.png" alt="微信 ClawBot 二维码" width="320" height="320"></p>`
    : ''
  const form = status === 'need-code'
    ? `<form method="get"><p>${escapeHtml(login?.prompt ?? '请输入手机微信上显示的数字配对码')}</p>
       <p><input name="code" inputmode="numeric" autofocus> <button type="submit">提交</button></p></form>`
    : ''
  const message = login?.message ? `<p class="msg">${escapeHtml(login.message)}</p>` : ''

  const html = `<!doctype html>
<meta charset="utf-8">
<title>微信 ClawBot 登录</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:2rem auto;max-width:44rem;line-height:1.6}
 .note,.msg{color:#8a6d3b;background:#fcf8e3;border:1px solid #faebcc;padding:.5rem .75rem;border-radius:6px}
 code{background:#f5f5f5;padding:.1rem .3rem;border-radius:4px}
</style>
<h1>微信 ClawBot 登录</h1>
<p>当前状态：<code>${escapeHtml(status)}</code></p>
${message}${image}${link}${note}${form}
<p>需要用手机微信（iOS 8.0.70 及以上）扫描，路径是「我 → 设置 → 插件 → ClawBot」。</p>
`

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

/** @param {string} path */
function pngContentTypeFor(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/png'
}

/** @param {unknown} s */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
