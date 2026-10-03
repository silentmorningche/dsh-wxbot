// @ts-check
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * `AgentPort` implementation over DSH's in-process agent services.
 *
 * This is the one file that contains the part the DSH documentation explicitly warns is
 * the easiest thing to get wrong, so the warning is reproduced verbatim here:
 *
 *   > `agent.followup()` has no per-message completion or result … **Never treat
 *   > `agent/status` or `whenIdle()` as the result of one follow-up** … An automation
 *   > caller that truly owns a run must define its interval explicitly — for example,
 *   > from its message's durable inbox receipt through the next whole-agent `idle`.
 *   — `docs/defensive-patterns.md` of deepseek-ai/deepseek-harness
 *
 * The interval this file implements is therefore:
 *
 *   t0 = the return value of `agent.followup(...)`  (the durable inbox receipt)
 *   t1 = the first `turn/end` session event for this session observed after t0
 *   backstop = `agent.whenIdle()` resolving after t0
 *   deadline = a wall-clock timeout
 *
 * Assistant text observed strictly between t0 and t1 belongs to this prompt. Text is
 * accumulated from `assistant/message` events via `expandAssistantStream`.
 *
 * ⚠️ UNVERIFIED ON A REAL MACHINE — see the block below. Every assumption here is written
 * so that being wrong degrades into "the prompt times out and reports why" rather than
 * into a crash, because the DSH contract makes a detached unhandled rejection fatal to
 * the whole application.
 *
 * ⚠️ Assumptions, with their current status:
 *   A1. ✅ **RESOLVED by a load test.** A probe evaluated inside the running DSH profile
 *       confirmed that `@deepseek-ai/dsh-llm` exports `createUserMessage`,
 *       `expandAssistantStream` **and** `joinAssistantStreamText`, all as functions (66
 *       exports in total). The specifier still resolves only for an importer inside the
 *       profile tree — see docs/LOAD-TEST-FINDINGS.md — which is exactly why the import stays
 *       **dynamic**: a resolution failure must become a precise log line, never a plugin that
 *       silently does nothing.
 *   A2. ⚠️ Still unverified. `ctx.agents.create(...)`'s exact option shape. The notes record
 *       two forms seen in the docs — `{ sessionId, seed, meta }` for replay/fork, and
 *       `{ sessionId, agentOptions: { provider, model } }` — so the call is made with a
 *       minimal `{ sessionId }` plus optional overrides, and both a returned handle and a
 *       returned agent are accepted.
 *   A3. Partly mitigated. `joinAssistantStreamText` is now preferred, because it is the
 *       package's own reader and therefore guesses nothing about chunk shape. The hand-rolled
 *       `expandAssistantStream` + delta accumulation survives only as a fallback, and it
 *       ignores any shape it does not recognise rather than throwing.
 *   A4. Session id validation. WeChat ids are sanitised to `[A-Za-z0-9._-]` by the bridge,
 *       which is the conservative charset.
 */

/**
 * The subset of a DSH `Agent` this adapter relies on.
 *
 * @typedef {object} DshAgentLike
 * @property {(message: unknown) => unknown} followup
 * @property {() => Promise<void>} [whenIdle]
 * @property {() => void} [cancel]
 * @property {() => Promise<void> | void} [dispose]
 */

/**
 * @typedef {object} AgentPortOptions
 * @property {any} ctx                the Cordis plugin context
 * @property {any} [agents]           the agent service, resolved by the caller WITHOUT `inject`
 * @property {string} [cwd]           workspace for created sessions; required for a usable turn
 * @property {string} [agentPreset]   preset id the session chooses; without one it exposes almost no
 *                                    tools, so it cannot read files it has just been told about
 * @property {any} [agentOptions]     model/provider for created sessions; REQUIRED in practice,
 *                                    because the system prompt references `{{model}}` and assembly
 *                                    fails without it
 * @property {(sessionId: string) => Promise<void>|void} [onSessionReady]
 *                                    called once per session after a live agent exists
 * @property {(level: string, msg: string) => void} log
 * @property {number} [replyTimeoutMs] Defaults to 300000 (5 minutes).
 */

export class DshAgentPort {
  /** @type {any} */
  #ctx
  /**
   * The agent service, passed in by the caller.
   *
   * ⚠️ Never read as `ctx.agents`: Cordis's context proxy throws for a service the plugin has
   * not declared in `inject` ("cannot get property \"agents\" without inject"), and declaring
   * `inject` would leave the entry waiting forever if the name were wrong. The caller resolves
   * it through `ctx.reflect.get(name, false)`, which needs no declaration.
   *
   * @type {any}
   */
  #agents
  /**
   * Workspace directory for sessions this port creates.
   *
   * ⚠️ A session's `cwd` is part of its creation metadata, and an agent created without one
   * produced a turn that began and ended immediately without ever admitting the user message:
   * `turn/start`, `step/start`, `step/end`, `turn/end`, and no `user/message` at all. The
   * documented webhook precedent creates its session with `cwd` equal to the workspace path.
   *
   * @type {string|null}
   */
  #cwd
  /**
   * Preset id the created session chooses.
   *
   * ⚠️ Not cosmetic. The profile's `agent-preset-registry` declares `default: standard`, but that
   * default is not applied to a programmatically created session — the same shape as
   * `agent-default-model`. An observed session without it exposed exactly one tool, an
   * environment-dependency query, so a fully working media pipeline still ended in "I cannot see it".
   *
   * @type {string|null}
   */
  #agentPreset
  /**
   * Per-agent model options for created sessions.
   *
   * ⚠️ The `agent-default-model` entry in a profile does **not** cover a session created
   * programmatically here. Without this, system-prompt assembly fails with
   * `prompt variable "{{model}}" has no value for this assembly` and the turn ends before any
   * model call — which looks exactly like an agent that produced nothing.
   *
   * @type {any}
   */
  #agentOptions
  /** @type {(level: string, msg: string) => void} */
  #log
  /** @type {number} */
  #replyTimeoutMs

  /** Resolved lazily so a bad specifier is reportable instead of fatal. */
  /** @type {{ createUserMessage: Function, expandAssistantStream: Function, joinAssistantStreamText: Function|null }|null} */
  #llm = null
  /** @type {Error|null} */
  #llmError = null

  /**
   * One waiter per session: the bridge serialises per session, so at most one prompt per
   * session is in flight.
   *
   * @type {Map<string, { collect: string[], sawAssistant: boolean, sawEvent: boolean, eventTypes: string[], finish: (why: string) => void }>}
   */
  #waiters = new Map()

  /** @type {(() => void)|null} */
  #offSessionEvent = null

  /** Set once the first session/event of any kind has been observed, so it is logged once. */
  #sawAnyEvent = false

  /**
   * Remaining per-event detail lines for this whole process. See the logging in `#onSessionEvent`:
   * bounded per process, not per prompt, so the status trail stays readable.
   */
  #eventDetailBudget = 12

  /** Session ids already reported through `onSessionReady`, so that work happens once each. */
  #announced = new Set()

  /** Session ids whose preset has already been bound through a session event; see `runPrompt`. */
  #presetBound = new Set()

  /** Session ids whose approval policy has already been set to `never`; see `runPrompt`. */
  #approvalPoliced = new Set()

  /**
   * Steered messages that still owe this session a turn, per session id.
   *
   * ⚠️ Why this exists. A steered message is folded into a turn that is *already running*, so its answer
   * is emitted in a later turn than the one the first caller is waiting on. The interval used to close at
   * "the first `turn/end` after the follow-up", so that caller collected and sent only the pre-steer text
   * and returned — leaving the steered message's answer with nobody listening.
   *
   * Measured symptom: the user's second message was accepted (`steered into the running turn` appeared in
   * the log) and WeChat never received the reply to it, while the first turn's text arrived normally.
   *
   * @type {Map<string, number>}
   */
  #steersPending = new Map()

  /**
   * Called once per session, right after a live agent exists for it. The plugin uses this to
   * attach the session to its workspace project, which is what makes the GUI group it.
   *
   * @type {((sessionId: string) => Promise<void> | void)|null}
   */
  #onSessionReady = null

  /**
   * Stable session id -> the id actually usable in this process.
   *
   * ⚠️ Workaround, not the design. `agents.create()` refuses a session that already exists in
   * durable storage (`SessionAlreadyExistsError`), and `agents.resume()` rejects a bare
   * `{ sessionId }` because it needs the loaded event log — it fails on `undefined.length`. Until
   * resume is wired, the fallback in `#ensureAgent` opens the conversation under a derived id and
   * records the mapping here for the lifetime of the process, so every later message reuses one
   * session instead of spawning a fresh one per message.
   *
   * The cost is explicit and logged, not silent: a conversation does **not** survive a DSH restart
   * yet.
   *
   * @type {Map<string, string>}
   */
  #actualIds = new Map()

  /** Per-process suffix used by that fallback. */
  #nonce = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`

  /** @param {AgentPortOptions} opts */
  constructor(opts) {
    if (!opts?.ctx) throw new Error('DshAgentPort: `ctx` is required')
    this.#ctx = opts.ctx
    this.#agents = opts.agents ?? null
    this.#cwd = opts.cwd ?? null
    this.#agentPreset = opts.agentPreset ?? null
    this.#agentOptions = opts.agentOptions ?? null
    this.#onSessionReady = opts.onSessionReady ?? null
    this.#log = opts.log ?? (() => {})
    this.#replyTimeoutMs = opts.replyTimeoutMs ?? 300_000
  }

  /**
   * Resolve the `@deepseek-ai/dsh-llm` exports this adapter needs.
   * Never throws; a failure is cached and surfaced by `runPrompt`.
   *
   * @returns {Promise<{ createUserMessage: Function, expandAssistantStream: Function, joinAssistantStreamText: Function|null }|null>}
   */
  /**
   * Resolve and import one of the host's own plugin packages.
   *
   * ⚠️ Same two-step resolution as `#loadLlm`, for the same measured reason: a bare specifier does not
   * resolve from this package's real location (a linked plugin sits outside the profile tree), so a
   * `createRequire` anchored at `process.cwd()` — the profile directory — is the step that works.
   *
   * @param {string} name
   * @returns {Promise<any|null>}
   */
  async #loadHostPlugin(name) {
    try {
      const direct = await import(name)
      const plugin = direct?.default ?? direct
      if (plugin) return plugin
    } catch {
      /* fall through to the profile-anchored resolve */
    }
    try {
      const req = createRequire(join(process.cwd(), '__dsh_plugin_resolve__.cjs'))
      const resolved = req.resolve(name)
      const viaProfile = await import(pathToFileURL(resolved).href)
      return viaProfile?.default ?? viaProfile ?? null
    } catch (err) {
      this.#log('warn', `could not load host plugin ${name}: ${describe(err)}`)
      return null
    }
  }

  /**
   * Give this session the tools a chat channel needs, composed through `setup` — the plugin-facing hook.
   *
   * Why necessary: the preset that normally mounts these rows cannot be bound by a plugin (measured:
   * `ctx.agentPresets` is unreachable, and appending the selection event only records a choice). A
   * session created here therefore exposes almost nothing, and cannot open a file it has just been told
   * about. `CreateAgentOptions.setup` documents exactly this use: "Everything registered through
   * `agentCtx` (scoped tools, prompt sections/variables, …) exists before `session/created`,
   * `agent/created`, and the first prompt assembly."
   *
   * `tool-fs` declares no config in the shipped preset and `tool-pwsh` only a platform gate, so these
   * mount bare — no configuration is reproduced here.
   *
   * ⚠️ Each mount is wrapped individually. The same contract says "a setup throw/rejection … rolls the
   * scope back without publishing either id", so one tool that fails to mount must not take the whole
   * session — and therefore the entire channel — down with it.
   *
   * @param {any} agentCtx the unpublished Agent scope
   * @returns {Promise<void>}
   */
  async #composeTools(agentCtx) {
    if (!agentCtx || typeof agentCtx.plugin !== 'function') {
      this.#log('warn', 'setup received no usable agent context; the session runs without extra tools')
      return
    }
    const wanted = [
      '@deepseek-ai/dsh-tool-fs',
      process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash',
    ]
    for (const name of wanted) {
      try {
        const plugin = await this.#loadHostPlugin(name)
        if (!plugin) continue
        agentCtx.plugin(plugin)
        this.#log('info', `mounted ${name} into this session scope`)
      } catch (err) {
        this.#log('warn', `could not mount ${name}: ${describe(err)}`)
      }
    }
  }

  /**
   * The tools this session would otherwise not have; see `#composeTools`.
   *
   * @returns {(agentCtx: any) => Promise<void>}
   */
  #toolsSetup() {
    return (agentCtx) => this.#composeTools(agentCtx)
  }

  async #loadLlm() {
    if (this.#llm) return this.#llm
    if (this.#llmError) return null

    /** @type {any} */
    let mod = null
    let via = ''

    try {
      // First attempt: the ordinary bare specifier, resolved from this module's own location.
      mod = await import('@deepseek-ai/dsh-llm')
      via = 'bare specifier'
    } catch (bareErr) {
      // Second attempt: resolution anchored INSIDE the profile. `process.cwd()` is the profile
      // directory for a launched profile (observed as C:\...\.dsh\profiles\desktop), and host
      // packages do resolve for an importer inside that tree. This fallback exists because the
      // bare attempt can fail for a module whose real location is outside the profile: the
      // plugin is installed as a link, and Node resolves links to their real path.
      try {
        const req = createRequire(join(process.cwd(), '__dsh_plugin_resolve__.cjs'))
        const resolved = req.resolve('@deepseek-ai/dsh-llm')
        mod = await import(pathToFileURL(resolved).href)
        via = `profile-anchored resolution -> ${resolved}`
      } catch (anchoredErr) {
        this.#llmError = anchoredErr instanceof Error ? anchoredErr : new Error(String(anchoredErr))
        this.#log(
          'error',
          'could not import @deepseek-ai/dsh-llm, so inbound messages cannot be answered. ' +
            `Bare specifier failed: ${describe(bareErr)}. ` +
            `Profile-anchored resolution failed: ${describe(anchoredErr)}. ` +
            'See docs/LOAD-TEST-FINDINGS.md.',
        )
        return null
      }
    }

    try {
      const createUserMessage = mod.createUserMessage ?? mod.default?.createUserMessage
      const expandAssistantStream = mod.expandAssistantStream ?? mod.default?.expandAssistantStream
      // Confirmed present by a load test. Kept optional so that a future removal degrades to the
      // hand-rolled reader below instead of breaking the plugin.
      const joinRaw = mod.joinAssistantStreamText ?? mod.default?.joinAssistantStreamText
      if (typeof createUserMessage !== 'function') {
        throw new Error('module has no `createUserMessage` export')
      }
      if (typeof expandAssistantStream !== 'function') {
        throw new Error('module has no `expandAssistantStream` export')
      }
      const joinAssistantStreamText = typeof joinRaw === 'function' ? joinRaw : null
      this.#llm = { createUserMessage, expandAssistantStream, joinAssistantStreamText }
      this.#log(
        'info',
        `resolved @deepseek-ai/dsh-llm via ${via} (createUserMessage, expandAssistantStream` +
          `${joinAssistantStreamText ? ', joinAssistantStreamText' : ''})`,
      )
      return this.#llm
    } catch (err) {
      this.#llmError = err instanceof Error ? err : new Error(String(err))
      this.#log(
        'error',
        `@deepseek-ai/dsh-llm loaded via ${via} but is unusable: ${this.#llmError.message}`,
      )
      return null
    }
  }

  /**
   * Subscribe to session events once, and return a disposer.
   * The listener must never throw: the documented rule is that a user-supplied listener
   * which throws must not reject the promise it runs inside.
   *
   * @returns {() => void}
   */
  start() {
    if (this.#offSessionEvent) return this.#offSessionEvent
    const handler = (session, event) => {
      try {
        this.#onSessionEvent(session, event)
      } catch (err) {
        // Swallow: a throwing listener would destabilise the dispatcher.
        try {
          this.#log('warn', `session/event listener threw (ignored): ${describe(err)}`)
        } catch {
          /* never propagate from a log call inside a listener */
        }
      }
    }
    try {
      const off = this.#ctx.on('session/event', handler)
      this.#offSessionEvent = typeof off === 'function' ? off : () => {}
    } catch (err) {
      this.#log('warn', `could not subscribe to session/event: ${describe(err)}`)
      this.#offSessionEvent = () => {}
    }
    return this.#offSessionEvent
  }

  /** Stop listening. Idempotent. */
  dispose() {
    try {
      this.#offSessionEvent?.()
    } catch {
      /* ignore */
    }
    this.#offSessionEvent = null
    for (const waiter of this.#waiters.values()) {
      try {
        waiter.finish('disposed')
      } catch {
        /* ignore */
      }
    }
    this.#waiters.clear()
  }

  /**
   * Submit one prompt and resolve with the assistant's reply text — or with `{ steered: true }` when the
   * message was folded into a turn that was already running.
   *
   * ⚠️ The two outcomes are structurally different on purpose. A steered message produces no reply of its
   * own, so the caller must not report the resulting emptiness as a failure — and the caller's only other
   * input is agent-authored text. A string sentinel could be produced by the agent itself, or typed by a
   * person in WeChat; a distinct object cannot. See the steer branch below.
   *
   * @param {string} sessionId
   * @param {string} text
   * @returns {Promise<string | { steered: true }>}
   */
  async runPrompt(sessionId, input) {
    const llm = await this.#loadLlm()
    if (!llm) {
      // Fail loudly but without crashing the channel: the bridge reports this per message.
      throw new Error('@deepseek-ai/dsh-llm is unavailable; see the plugin log for the reason')
    }

    const agent = await this.#ensureAgent(sessionId)

    // Report the session once, so the caller can attach it to its workspace project. Use the id
    // actually in use, which differs from the stable id only when the derived-id fallback ran.
    const liveId = this.#actualIds.get(sessionId) ?? sessionId
    if (this.#onSessionReady && !this.#announced.has(liveId)) {
      this.#announced.add(liveId)
      try {
        await this.#onSessionReady(liveId)
      } catch (err) {
        this.#log('warn', `onSessionReady failed for ${liveId}: ${describe(err)}`)
      }
    }

    // ── Bind the preset, because the header does NOT do it ──────────────────────────────────────
    //
    // `meta.agentPreset` lands in the session header, but the registry's own source says the header
    // "is only a creation fact": the preset is bound by an **event**. That is why a session whose
    // header read `agentPreset: "standard"` — and later `"cordis"` — still exposed exactly one tool,
    // and why changing the id changed nothing. The GUI path receives that event from the host's
    // session controller; a plugin calling `agents.create()` receives nothing.
    //
    // The registry's own binding call is
    //     agent.session.append('agent-preset/selected', { agentPreset })
    // (dsh-agent-preset-registry/lib/index.js), and the registry listens for exactly that session
    // event and mounts the preset's plugin rows in response. Appending it here is the same act, on the
    // one object already in hand.
    //
    // Guarded three ways: only when a preset is configured, only when the session exposes `append`,
    // and once per session. Failures are reported, never thrown.
    if (this.#agentPreset && !this.#presetBound.has(liveId)) {
      const session = /** @type {any} */ (agent)?.session
      if (session && typeof session.append === 'function') {
        this.#presetBound.add(liveId)
        try {
          session.append('agent-preset/selected', { agentPreset: this.#agentPreset })
          // ⚠️ Deliberately *not* phrased as "bound". Appending this event records a choice and does
          // nothing else — measured: the tool count in `request/header` was 1 both before and after the
          // append, so the preset was never mounted. This line used to read "bound preset … via a session
          // event", asserting something already proven not to happen, and a log that lies is worse than
          // no log: it is what sent the preset investigation down four wrong hypotheses before the
          // measurement settled it. The tools this session actually gets come from `setup`; see
          // `#composeTools`.
          this.#log(
            'info',
            `recorded preset choice "${this.#agentPreset}" for ${liveId} ` +
              '(a record only — it does not mount the preset; this session\'s tools come from setup)',
          )
        } catch (err) {
          this.#log('warn', `could not bind preset "${this.#agentPreset}" to ${liveId}: ${describe(err)}`)
        }
      } else {
        this.#log(
          'warn',
          `session ${liveId} exposes no append(), so preset "${this.#agentPreset}" cannot be bound`,
        )
      }
    }

    // ── This channel has nobody to answer an approval prompt ─────────────────────────────────────
    //
    // DSH's approvals are built for a session with a UI: a request is dispatched to answerers and, with
    // none available, closes as `unavailable` — which from the WeChat side is indistinguishable from the
    // agent silently stalling. The `never` policy is the deterministic answer.
    //
    // `setApprovalPolicy(session, policy)` in `@deepseek-ai/dsh-user-approval` is exactly "validate, then
    // append `approval/policy`", and the service applies that policy BEFORE the answerer waterfall, so
    // nothing can route around it. It also swaps the model-facing sentence to "Approval prompts are
    // disabled in this session … do not request sandbox escalation", so the model stops asking at all.
    //
    // ⚠️ Session-scoped by construction: this appends an event to *this* session and the policy is
    // evaluated per agent, so sessions in the GUI are untouched. That containment is why this was chosen
    // over an always-denying listener, and it is the property to re-check if this code ever moves
    // somewhere less obviously per-session.
    //
    // ⚠️ The accepted trade-off: under `never` the request never reaches the waterfall, so there is no
    // event for this plugin to observe and therefore no separate "that step was refused" message. The
    // model is informed instead and reports it in its reply. Safety was chosen over visibility, on
    // purpose.
    if (!this.#approvalPoliced.has(liveId)) {
      const approvalSession = /** @type {any} */ (agent)?.session
      if (approvalSession && typeof approvalSession.append === 'function') {
        this.#approvalPoliced.add(liveId)
        try {
          approvalSession.append('approval/policy', { policy: 'never' })
          this.#log('info', `set approval policy "never" on ${liveId}`)
        } catch (err) {
          this.#log('warn', `could not set the approval policy on ${liveId}: ${describe(err)}`)
        }
      } else {
        this.#log('warn', `session ${liveId} exposes no append(), so the approval policy stays "ask"`)
      }
    }

    // ── Warn when this conversation's workspace differs from the configured one ──────────────
    //
    // `resume()` accepts no `meta`, so a session keeps the `cwd` it was created with. Changing
    // `sessionCwd` later therefore has no effect on existing conversations and would otherwise be
    // ignored in silence — the same failure shape as the `{{cwd}}` bug, where a stale value only
    // surfaced as a turn that produced nothing. Membership in the GUI is validated against exactly
    // this persisted value, so a mismatch is worth stating out loud.
    if (this.#cwd) {
      const header = /** @type {any} */ (agent)?.session?.header ?? null
      const persisted = header && typeof header === 'object' ? (header.cwd ?? null) : null
      this.#log(
        'debug',
        `session header keys=[${header ? Object.keys(header).join(',') : '(none)'}] ` +
          `persistedCwd=${JSON.stringify(persisted)}`,
      )
      if (typeof persisted === 'string' && persisted.length > 0 && persisted !== this.#cwd) {
        this.#log(
          'warn',
          `this conversation keeps the workspace it was created with (${persisted}), but the plugin ` +
            `is configured for ${this.#cwd}. resume() accepts no meta, so the change cannot apply to an ` +
            `existing session — version the session id in bridge.js to start this peer fresh.`,
        )
      }
    }

    // ⚠️ Interrupt-and-replace, and this block must sit **before the waiter below** — it takes that slot
    // over, so the interrupted interval has to be found and settled first. Placed after the registration it
    // settled and marked its own waiter, which short-circuited this very call into returning the silent
    // sentinel without ever prompting.
    //
    // It is built only from primitives whose behaviour has been observed here:
    //   1. `cancel({ kind: 'user' })` ends the running turn (`cancel(cause, options?)` is on the interface,
    //      and `AgentCancelCause` includes `{ kind: 'user' }`);
    //   2. `whenIdle()` waits for it to actually stop;
    //   3. the interrupted interval is settled and marked, so it neither lingers to its reply timeout nor
    //      reports its discarded partial text as a failure;
    //   4. falling through to the ordinary `followup` starts a fresh turn for this message **while the first
    //      message is already in the session history**, so one turn answers both.
    //
    // ⚠️ A throwing `cancel` or `whenIdle` is caught, leaving an ordinary prompt — the behaviour that
    // already worked. This replaced an attempt at `agent.steer()`, which produced no turn at all.
    if (agent.status === 'running') {
      this.#log('info', `interrupting the running turn on ${sessionId} to answer a newer message`)
      try {
        agent.cancel({ kind: 'user' })
      } catch (err) {
        this.#log('warn', `cancel() threw on ${sessionId}: ${describe(err)}`)
      }
      try {
        await agent.whenIdle()
      } catch (err) {
        this.#log('warn', `whenIdle() threw on ${sessionId} after cancel: ${describe(err)}`)
      }
      const interrupted = this.#waiters.get(sessionId)
      if (interrupted && typeof interrupted.finish === 'function') {
        interrupted.interrupted = true
        interrupted.finish('interrupted')
      }
    }

    /** @type {string[]} */
    const collect = []
    this.start() // ensure the listener exists before the receipt, or we would miss turns
    const waiter = { collect, sawAssistant: false, sawEvent: false, eventTypes: [], finish: (_why) => {} }
    // Register under both the stable id and whichever id this process actually uses, so an event
    // carrying either is attributed to this prompt.
    const actualId = this.#actualIds.get(sessionId)
    // ⚠️ Plain replacement, deliberately. An earlier version refused to overwrite an existing waiter —
    // correct for `steer`, where the incoming message was not a prompt at all, but wrong now: with
    // interrupt-and-replace the newer message *is* the prompt that will answer, so refusing the slot left it
    // collecting nothing. The interrupted interval is settled and marked just above, so taking over is safe.
    this.#waiters.set(sessionId, waiter)
    if (actualId) this.#waiters.set(actualId, waiter)

    try {
      // The documented follow-up example passes a plain literal, not a built message:
      //     handle.agent.followup({ content: [...], source: { kind: 'user' } })
      // A built message may add fields the loop requires (an id), so both are merged: the literal
      // wins for `content`/`source`, and anything the builder added is kept. The keys actually sent
      // are logged, because a message the inbox silently declines looks exactly like an agent that
      // produced nothing — which is the failure this code is chasing.
      // `input` is either plain prompt text or an already-built content-part array. The array form is
      // how an image actually reaches the model: an image block must sit in `content`, and DSH
      // projects it to a real image for an image-capable route (and to a stable placeholder
      // otherwise). Sending a file *path* instead — which this plugin did at first — means the model
      // never receives a single pixel, however capable it is. A whole test cycle was spent on that.
      const content = Array.isArray(input) ? input : [{ type: 'text', text: String(input ?? '') }]
      const literal = { content, source: { kind: 'user' } }
      /** @type {any} */
      let message = literal
      try {
        const built = llm.createUserMessage({ ...literal })
        if (built && typeof built === 'object') message = { ...built, ...literal }
      } catch (err) {
        this.#log('warn', `createUserMessage failed; sending the literal form instead: ${describe(err)}`)
      }
      this.#log('debug', `followup message keys=[${Object.keys(message).join(',')}]`)

      // ── 插话: a turn is already running, so this message joins it instead of queueing ───────────────
      //
      // `Agent.steer()` is the platform's own third delivery mode, alongside `followup` and `inject`, and
      // the session controller applies exactly this rule for the GUI: while running, a message with
      // `mode: 'steer'` is placed as `steering`, otherwise as `queued`. `steer` is legal only while
      // `agent.status === 'running'` (the controller throws `session/steer-unavailable` otherwise), so the
      // status check is the precondition, not an optimisation.
      //
      // ⚠️ Placement here is load-bearing, and getting it wrong cost three rounds. This branch needs
      // `message`, which is only built a few lines above — placing it earlier (to sit before the waiter,
      // which was the other half of the problem) made `agent.steer(message)` throw `ReferenceError`
      // *before* the counter below was incremented, so the guard that holds the interval open read zero
      // and never fired. Both halves are now handled in their own way: the branch lives where `message`
      // exists, and the waiter registration refuses to clobber (see the comment there).
      //
      // ⚠️ The return value is an **object**, deliberately. A steered message produces no reply of its own,
      // so the caller must not report the resulting emptiness as a failure — and the caller's only other
      // input is agent-authored text. A string sentinel could be produced by the agent itself, or typed by
      // a person in WeChat; an object cannot. "Silent on purpose" and "silent because something broke" have
      // to be distinguished by type, not by value.
      // ⚠️ The paragraphs above record an attempt that failed: `agent.steer()` was accepted and logged, then
      // produced **no turn at all** — the interval's event count never moved, so the answer never existed to
      // collect and the user lost the reply to their second message. They are kept because they explain why
      // this site now does something else.
      //
      // Interrupt-and-replace, built only from primitives whose behaviour has been observed in this plugin:
      //   1. `cancel({ kind: 'user' })` ends the running turn — the interface declares `cancel(cause,
      //      options?)`, and `AgentCancelCause` includes `{ kind: 'user' }`;
      //   2. `whenIdle()` waits for it to actually stop, which also guarantees the previous interval has
      //      settled and released its waiter before a new one registers — so the no-clobber guard below is
      //      not fighting this path;
      //   3. falling through to the ordinary `followup` starts a fresh turn for this message **while the
      //      first message is already in the session history**, so a single turn answers both. No text has to
      //      be concatenated by hand.
      //
      // ⚠️ Failure is safe by construction: if `cancel` or `whenIdle` throws, both are caught and this
      // degrades to an ordinary prompt — the behaviour that already worked.
      // t0 — the durable inbox receipt.
      const receipt = agent.followup(message)
      this.#log('debug', `followed up session ${sessionId} (receipt=${describeReceipt(receipt)})`)

      const reason = await this.#awaitTurnEnd(sessionId, agent, waiter)
      if (waiter.interrupted) {
        // Cancelled on purpose by a newer message: stay silent. The replacement turn answers the same
        // question, so sending this partial text — or reporting its absence as a failure — would be noise.
        this.#log('info', `interval on ${sessionId} ended by interruption (${reason}); staying silent`)
        return { interrupted: true }
      }
      const reply = collect.join('').trim()
      const kinds = [...new Set(waiter.eventTypes)].join(',')
      this.#log(
        'debug',
        `session ${sessionId} settled by ${reason}; reply length=${reply.length}; ` +
          `events=${waiter.eventTypes.length}${kinds ? ` [${kinds}]` : ''}`,
      )
      return reply
    } finally {
      // ⚠️ Remove only our own entry. An interrupting prompt has already put its waiter in this slot, and the
      // interrupted caller's cleanup runs *after* that — unconditionally deleting here would remove the
      // waiter the replacement is collecting into, which is the same defect as clobbering it, from the
      // cleanup side.
      if (this.#waiters.get(sessionId) === waiter) this.#waiters.delete(sessionId)
      if (actualId && this.#waiters.get(actualId) === waiter) this.#waiters.delete(actualId)
      if (actualId) this.#waiters.delete(actualId)
    }
  }

  /**
   * Resolve when the turn ends, when the agent falls idle **after the work has started**, or on
   * timeout — whichever comes first. `whenIdle()` bounds the interval; it never supplies the
   * reply text.
   *
   * ⚠️ The idle backstop must be gated on observed activity. `followup()` returns while the agent
   * is still idle — the turn has not begun — so calling `whenIdle()` immediately resolves at once
   * and closes the interval before any output exists. That is exactly what the first real message
   * did: "settled by agent-idle" after 203 ms with zero characters. The documentation warns about
   * precisely this: "Never treat `agent/status` or `whenIdle()` as the result of one follow-up".
   * Idle is therefore honoured only once this session has produced at least one event.
   *
   * @param {string} sessionId
   * @param {DshAgentLike} agent
   * @param {{ collect: string[], sawAssistant: boolean, sawEvent: boolean, eventTypes: string[], finish: (why: string) => void }} waiter
   * @returns {Promise<string>}
   */
  #awaitTurnEnd(sessionId, agent, waiter) {
    return new Promise((resolve) => {
      let settled = false
      let idleProbeInFlight = false
      // Steering bookkeeping for this interval; see the comment on `finish`. `heldAtEvents` is what proves
      // the steered turn actually ran — without it, the idle probe re-fires 250 ms later and settles the
      // interval before the interjection's answer exists.
      let heldAtEvents = null
      let heldAt = 0
      /** How long a steered message may hold the interval open before it is released. */
      const STEER_HOLD_MS = 30_000
      /**
       * @param {string} why
       * @returns {boolean} whether the interval actually settled (false = held back for a steered message)
       */
      const finish = (why) => {
        if (settled) return true
        // ⚠️ A steered message owes this session another turn, so a closure that arrives *before* that
        // turn's answer must not end the interval — the caller would collect and send only the pre-steer
        // text and abandon the reply the user is still waiting for.
        //
        // ⚠️ Two conditions, and the second is the one that took three attempts to find:
        //
        //   1. a steer is outstanding, or
        //   2. nothing new has happened since the last hold.
        //
        // Condition 1 alone is not enough. Holding once and decrementing looked right, but the idle probe
        // re-fires 250 ms later — while the steered message is still sitting in the inbox with no turn
        // started — and with the counter back at zero that second closure settled the interval anyway. The
        // symptom was exact: the reply contained everything up to the interjection and nothing after it.
        //
        // Condition 2 is what actually waits for the steered turn, and `STEER_HOLD_MS` bounds it so that a
        // steer which never runs cannot hold the caller until the full reply timeout. The timeout itself is
        // never held: it is the last resort guaranteeing this promise settles.
        if (why !== 'timeout') {
          const pending = this.#steersPending.get(sessionId) ?? 0
          const events = waiter.eventTypes.length
          const waited = heldAt > 0 ? Date.now() - heldAt : 0
          const expired = heldAt > 0 && waited > STEER_HOLD_MS
          const nothingNew = heldAtEvents !== null && events <= heldAtEvents
          if (pending > 0 || (nothingNew && !expired)) {
            if (pending > 0) this.#steersPending.set(sessionId, pending - 1)
            heldAtEvents = events
            // ⚠️ Only the FIRST hold starts the clock. Refreshing `heldAt` on every hold made `expired`
            // unreachable — `waited` was reset to ~0 each time — so a single steer held the interval open
            // until the full reply timeout, and the user saw no reply at all rather than a late one.
            if (heldAt === 0) heldAt = Date.now()
            this.#log(
              'info',
              `interval closure (${why}) held on ${sessionId}: ${pending} steer(s) outstanding, ` +
                `events=${events}, waited=${waited}ms`,
            )
            return false
          }
        }
        settled = true
        clearTimeout(timer)
        clearTimeout(noEventTimer)
        clearInterval(probe)
        waiter.finish(why)
        resolve(why)
      }
      waiter.finish = finish

      const timer = setTimeout(() => finish('timeout'), this.#replyTimeoutMs)

      // If not a single event is attributed to this session, the user must not be left waiting for
      // the full reply timeout. `turn/start` normally follows the receipt within about a second, so
      // "nothing matched" is a distinct outcome that reports itself quickly — it means the
      // session-id matching is wrong, not that the agent is slow.
      const noEventTimer = setTimeout(() => {
        if (!waiter.sawEvent) finish('no-events-matched')
      }, 30_000)

      // The primary end signal is `turn/end`, raised from `#onSessionEvent`. This probe only
      // supplies the idle backstop, and only once the session has shown signs of life.
      const probe = setInterval(() => {
        if (settled || idleProbeInFlight) return
        if (!waiter.sawEvent) return // the turn has not started, so "idle" means nothing yet
        if (typeof agent.whenIdle !== 'function') return
        idleProbeInFlight = true
        try {
          Promise.resolve(agent.whenIdle()).then(
            () => {
              // ⚠️ If the closure was held back for a steered message, the probe must be allowed to fire
              // again. Leaving `idleProbeInFlight` true would disable the backstop permanently after a
              // single idle observation, and the caller would then wait out the whole reply timeout.
              if (!finish('agent-idle-after-activity')) idleProbeInFlight = false
            },
            (err) => {
              this.#log('warn', `whenIdle() rejected for ${sessionId}: ${describe(err)}`)
              idleProbeInFlight = false
            },
          )
        } catch (err) {
          this.#log('warn', `whenIdle() threw for ${sessionId}: ${describe(err)}`)
          idleProbeInFlight = false
        }
      }, 250)
    })
  }

  /**
   * @param {any} session
   * @param {any} event
   */
  #onSessionEvent(session, event) {
    if (!event || typeof event !== 'object') return
    const candidates = collectSessionIdCandidates(session, event)
    // Match by VALUE against the sessions actually being awaited. A field-name guess cannot
    // silently attach an event to the wrong conversation this way.
    let sessionId = ''
    for (const c of candidates) {
      if (this.#waiters.has(c)) {
        sessionId = c
        break
      }
    }
    const type = typeof event.type === 'string' ? event.type : `(no type: ${typeof event.type})`

    // Record the shape once. When no id ever matches, the symptom is identical to "the agent
    // produced nothing", so the first event is logged with every candidate it carried and the set
    // of sessions being awaited.
    if (!this.#sawAnyEvent) {
      this.#sawAnyEvent = true
      this.#log(
        'info',
        `first session/event: type=${type} matched=${sessionId || '(none)'} ` +
          `candidates=[${candidates.join(' , ')}] awaiting=[${[...this.#waiters.keys()].join(' , ')}] ` +
          `sessionArg=${describeShape(session)} eventKeys=${Object.keys(event).join('|')}`,
      )
    }

    if (!sessionId) return
    const waiter = this.#waiters.get(sessionId)
    if (!waiter) return

    waiter.sawEvent = true
    if (waiter.eventTypes.length < 40) waiter.eventTypes.push(type)

    // Log what each event actually carries, drawing on a per-process budget rather than a per-prompt
    // one. These payloads are what made the silent failures diagnosable — a turn that ends without
    // ever calling the model keeps its reason at `turn/end.data.reason.error` — but a
    // twelve-lines-per-prompt budget flooded the status trail and evicted the lifecycle entries that
    // matter (login, account restore, create/resume). Twelve lines per process keeps the first-run
    // picture and drops the noise.
    if (this.#eventDetailBudget > 0) {
      this.#eventDetailBudget -= 1
      this.#log(
        'debug',
        `event ${type} keys=[${Object.keys(event).join(',')}] data=${previewData(/** @type {any} */ (event).data).slice(0, 1500)}`,
      )
    }

    if (type === 'assistant/message') {
      const text = this.#readAssistantText(event)
      if (text) {
        waiter.collect.push(text)
        waiter.sawAssistant = true
      }
      return
    }

    if (type === 'turn/end') {
      // Only accept a turn end once this prompt has produced something, so a stale
      // turn/end from a previous turn cannot close the interval prematurely.
      if (waiter.sawAssistant) waiter.finish('turn-end')
      return
    }
  }

  /**
   * Turn one `assistant/message` event into plain text.
   *
   * `joinAssistantStreamText` is preferred because it is the package's **own** reader: it
   * knows the `AssistantStreamRecord[]` layout and therefore guesses nothing about chunk
   * shape. The hand-rolled path below exists only for the case where that export is ever
   * absent, and it stays tolerant — an unrecognised shape yields `''` plus a warning, never a
   * throw (assumption A3).
   *
   * @param {any} event
   * @returns {string}
   */
  #readAssistantText(event) {
    const llm = this.#llm
    if (!llm) return ''
    const stream = event?.data?.stream
    if (!stream) return ''

    // Preferred: the package's own joiner. It returns the whole assistant text for the stream.
    if (llm.joinAssistantStreamText) {
      try {
        const joined = llm.joinAssistantStreamText(stream)
        if (typeof joined === 'string') return joined
        if (joined === null || joined === undefined) return ''
        this.#log('debug', `joinAssistantStreamText returned ${typeof joined}; falling back`)
      } catch (err) {
        this.#log('warn', `joinAssistantStreamText failed; falling back: ${describe(err)}`)
      }
    }

    /** @type {any[]} */
    let chunks
    try {
      const expanded = llm.expandAssistantStream(stream)
      chunks = Array.isArray(expanded) ? expanded : [...(expanded ?? [])]
    } catch (err) {
      this.#log('warn', `expandAssistantStream failed (ignored): ${describe(err)}`)
      return ''
    }

    let out = ''
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue
      const kind = typeof chunk.type === 'string' ? chunk.type : ''
      if (kind !== 'text-delta' && kind !== 'text') continue
      const piece = chunk.text ?? chunk.delta ?? chunk.value
      if (typeof piece === 'string') out += piece
    }
    return out
  }

  /**
   * Return a live agent for `sessionId`, creating one when none exists.
   * ⚠️ A2 — `create`'s option shape is only partly documented.
   *
   * @param {string} sessionId
   * @returns {Promise<DshAgentLike>}
   */
  async #ensureAgent(sessionId) {
    const agents = this.#agents
    if (!agents) {
      throw new Error(
        'the agent service is unavailable in this profile, so a session cannot be started. ' +
          'The plugin resolves it with ctx.reflect.get("agents" | "agent", false).',
      )
    }

    // The id this process actually uses for the conversation, which is the stable id unless the
    // fallback below had to derive one.
    const actualId = this.#actualIds.get(sessionId) ?? sessionId

    // A live agent for this session, if any. `get` sees LIVE agents only.
    if (typeof agents.get === 'function') {
      const existing = agents.get(actualId)
      if (existing) return existing
    }

    /** @param {any} handle @returns {any|null} */
    const unwrap = (handle) => {
      const agent = handle?.agent ?? handle
      return agent && typeof agent.followup === 'function' ? agent : null
    }

    /**
     * Creation options for a new session. `meta.cwd` is the workspace: without it the turn starts
     * and immediately ends without admitting the user message.
     *
     * @param {string} id
     * @returns {any}
     */
    const createOptions = (id) => {
      /** @type {any} */
      const opts = { sessionId: id }
      /** @type {Record<string, unknown>} */
      const meta = {}
      if (this.#cwd) meta.cwd = this.#cwd
      // ⚠️ A session that chooses no preset exposes almost no tools. Observed symptom: an agent whose
      // only tool was an environment-dependency query, so it could not read a file it had just been
      // told about — a working media pipeline still ended in "I cannot see it". The profile's
      // `agent-preset-registry` documents `default: standard`, but that default is not applied to a
      // programmatically created session, exactly like `agent-default-model`: the session chooses.
      if (this.#agentPreset) meta.agentPreset = this.#agentPreset
      if (Object.keys(meta).length > 0) opts.meta = meta
      if (this.#agentOptions) opts.agentOptions = this.#agentOptions
      // The tools this session would otherwise not have; see #composeTools.
      opts.setup = this.#toolsSetup()
      return opts
    }

    // `create` builds a FRESH agent and session under one identity.
    let createError = null
    if (typeof agents.create === 'function') {
      try {
        const created = unwrap(await agents.create(createOptions(actualId)))
        if (created) {
          this.#log('info', `created a new agent for session ${actualId} (cwd=${this.#cwd ?? '(none)'})`)
          return created
        }
        createError = new Error('create() did not yield an agent with followup()')
      } catch (err) {
        createError = err
      }
    } else {
      createError = new Error('ctx.agents.create is unavailable')
    }

    // The session already exists in durable storage, so `create` will always refuse it. `resume` is
    // the documented counterpart — "loads a persisted session and rebuilds the agent on it", which
    // is exactly what continuing a conversation across a restart requires.
    //
    // ⚠️ Its option is **`resumeSessionId`**, NOT `sessionId` — see `ResumeAgentOptions` in
    // @deepseek-ai/dsh-agent. Passing `sessionId` left `resumeSessionId` undefined and the call died
    // with `Cannot read properties of undefined (reading 'length')`. The field name was the entire
    // bug, and it took several restarts to see because that TypeError names neither the option nor
    // the misspelling.
    if (typeof agents.resume === 'function') {
      try {
        /** @type {any} */
        const resumeOptions = { resumeSessionId: actualId }
        if (this.#agentOptions) resumeOptions.agentOptions = this.#agentOptions
        // `resume` takes `setup` too, so an existing conversation gains the tools without needing a new
        // session id — the one creation-metadata change that does NOT cost the conversation.
        resumeOptions.setup = this.#toolsSetup()
        const resumed = unwrap(await agents.resume(resumeOptions))
        if (resumed) {
          this.#log('info', `resumed the persisted session ${actualId}`)
          return resumed
        }
      } catch (err) {
        this.#log('warn', `resume() failed for ${actualId}: ${describe(err)}`)
      }
    }

    // ── Last resort: open the conversation under a derived id ────────────────────────
    //
    // Neither door above can reopen a persisted session from here. Rather than leave the channel
    // dead (every message failing forever), create the conversation under an id that cannot
    // collide, and remember it so every later message reuses one session.
    //
    // ⚠️ The cost is explicit: this conversation will NOT continue after a DSH restart. Fixing
    // that means wiring `resume` with the loaded session log. This path is logged, never silent.
    if (typeof agents.create === 'function' && actualId === sessionId) {
      const derived = `${sessionId}--${this.#nonce}`
      try {
        const created = unwrap(await agents.create(createOptions(derived)))
        if (created) {
          this.#actualIds.set(sessionId, derived)
          this.#log(
            'warn',
            `the persisted session could not be reopened, so a fresh conversation was opened as ` +
              `${derived}. Messages will work, but this conversation will not continue after a ` +
              `DSH restart. (create said: ${describe(createError)})`,
          )
          return created
        }
      } catch (err) {
        this.#log('error', `the derived-id fallback also failed: ${describe(err)}`)
      }
    }

    throw new Error(
      `could not obtain an agent for session ${sessionId}. create() said: ${describe(createError)}`,
    )
  }
}

/**
 * Collect every plausible session identifier from a dispatched event.
 *
 * ⚠️ These field names are not guessable from the outside. A live load test showed the object
 * handed to the handler exposing an internal `session-<uuid>` id, while the id this plugin chose
 * lives elsewhere — the `header` is the most likely carrier. Rather than betting on one field,
 * every candidate is collected and the caller matches them **by value** against the sessions it
 * is actually waiting on, which cannot silently mis-assign.
 *
 * @param {any} session
 * @param {any} event
 * @returns {string[]}
 */
function collectSessionIdCandidates(session, event) {
  /** @type {string[]} */
  const out = []
  /** @param {unknown} v */
  const push = (v) => {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v)
  }
  push(typeof session === 'string' ? session : undefined)
  push(session?.sessionId)
  push(session?.id)
  push(session?.header?.sessionId)
  push(session?.header?.id)
  push(event?.sessionId)
  push(event?.session?.sessionId)
  push(event?.session?.id)
  return out
}

/** @param {any} receipt */
function describeReceipt(receipt) {
  if (receipt === null || receipt === undefined) return 'none'
  if (typeof receipt === 'string') return `str(${receipt.length})`
  if (typeof receipt === 'object') {
    for (const key of ['id', 'receiptId', 'messageId', 'seq']) {
      const v = receipt[key]
      if (typeof v === 'string' || typeof v === 'number') return `${key}=${v}`
    }
  }
  return typeof receipt
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function describe(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

/**
 * A short, safe description of a value's shape, for diagnostics. Never throws and never
 * serialises a whole object, because these values are live agent state.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeShape(value) {
  try {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    const t = typeof value
    if (t !== 'object') return `${t}:${String(value).slice(0, 60)}`
    const keys = Object.keys(value)
    const id = /** @type {any} */ (value).id ?? /** @type {any} */ (value).sessionId
    return `object(keys=${keys.slice(0, 8).join('|')}${keys.length > 8 ? '|…' : ''}` +
      `${typeof id === 'string' ? ` id=${id.slice(0, 40)}` : ''})`
  } catch {
    return '(unreadable)'
  }
}

/**
 * A bounded preview of an event payload, for diagnostics.
 *
 * Recurses into nested objects and errors, because the reason a turn ended lives at
 * `turn/end.data.reason.error` — summarising nested objects as "object(keys=…)" hid exactly the
 * message this instrumentation exists to reveal. Never throws.
 *
 * @param {unknown} data
 * @param {number} [depth]
 * @returns {string}
 */
function previewData(data, depth = 0) {
  try {
    if (data === null || data === undefined) return String(data)
    // `Error.message` is a non-enumerable own property, so a plain object walk shows nothing.
    if (data instanceof Error) {
      const code = /** @type {any} */ (data).code
      return `${data.name}: ${data.message}${code ? ` (code=${String(code)})` : ''}`
    }
    if (typeof data !== 'object') return typeof data === 'string' ? data.slice(0, 300) : String(data)
    if (Array.isArray(data)) {
      const head = depth < 2 && data.length > 0 ? `:${previewData(data[0], depth + 1)}` : ''
      return `array(${data.length})${head}`
    }

    /** @type {Record<string, unknown>} */
    const picked = {}
    for (const [k, v] of Object.entries(/** @type {any} */ (data))) {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') picked[k] = v
      else if (typeof v === 'string') picked[k] = v.slice(0, 300)
      else if (Array.isArray(v)) picked[k] = `array(${v.length})`
      else if (v instanceof Error) picked[k] = previewData(v, depth + 1)
      else if (typeof v === 'object') {
        picked[k] =
          depth < 3
            ? previewData(v, depth + 1)
            : `object(keys=${Object.keys(/** @type {any} */ (v)).slice(0, 8).join('|')})`
      } else picked[k] = String(v)
    }
    return JSON.stringify(picked)
  } catch {
    return '(unreadable)'
  }
}

/**
 * @param {AgentPortOptions} opts
 * @returns {DshAgentPort}
 */
export function createAgentPort(opts) {
  return new DshAgentPort(opts)
}
