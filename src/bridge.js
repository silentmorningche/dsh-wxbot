// @ts-check
/**
 * Message orchestration between a WeChat ClawBot (iLink) peer and a DSH session.
 *
 * This module deliberately depends on **two narrow ports** instead of on concrete
 * implementations, so the uncertain parts (the exact DSH session API, and the exported
 * shape of `ilink-client.js`) stay isolated in adapters:
 *
 *   - `AgentPort`   — runs one prompt against one DSH session and returns the reply text.
 *   - `ChannelPort` — sends text back to WeChat and drives the typing indicator.
 *
 * Everything here is therefore pure orchestration and can be reasoned about without a
 * running DSH.
 *
 * ── Protocol rules enforced here (each is a documented requirement) ────────────────
 *
 * [P1] A reply must carry the `context_token` of the **inbound message being answered**.
 *      Source: docs/protocol.md, "sendMessage" / integration guidance:
 *      "pass back the inbound `context_token` when replying to that conversation".
 * [P2] A `context_token` must never be reused across accounts or across peers.
 *      Handled by keying on (botId, peerId) — see `store.js`.
 * [P3] Only the newest valid token per (account, peer) is kept, for proactive sends.
 * [P4] Group chat is NOT supported by the official plugin: it pins the inbound ChatType
 *      to `direct` and has no group branch in the send path. Messages carrying `group_id`
 *      must therefore be recorded and refused rather than answered privately to the
 *      sender. Source: docs/protocol.md "Message model" (`group_id`) plus the
 *      third-party analysis section 2.8.
 * [P5] `item_list` type semantics: `1` text, `2` image, `3` voice, `4` file, `5` video,
 *      `11` tool_call_start, `12` tool_call_result. Unknown types must NOT be read as
 *      text. Source: docs/protocol.md "MessageItem".
 * [P6] A `voice_item` may carry a transcript in its own `text` field; when present it is
 *      usable as the prompt. Source: docs/protocol.md "Media fields used by the client".
 * [P7] `message_type`: 1 = user, 2 = bot. Bot messages are our own echoes and must be
 *      ignored, otherwise the bot talks to itself.
 * [P8] `message_id` is a uint64 on the wire. The official client rewrites it to a JSON
 *      string to avoid precision loss, so it is treated as an opaque string here and is
 *      never used in arithmetic.
 *
 * ── Availability discipline (the reason for every `try` in this file) ──────────────
 *
 * The DSH contract is that a detached asynchronous work item producing an **unhandled
 * rejection outside the plugin's own `apply()` promise disposes the whole application
 * and exits non-zero**. Source: @deepseek-ai/dsh-app-boot README, "Startup and reload
 * failures". A channel plugin runs a long-lived polling loop, which is exactly the shape
 * that trips this rule. Consequently **no method here may ever reject**: every public
 * entry point catches everything and reports through the optional `onError` callback.
 */

/** Hard cap on remembered inbound message ids, to bound memory over a long run. */
const DEDUPE_LIMIT = 512

/**
 * Conservative reply splitter. The protocol does not document a maximum text length, so
 * this is a **defensive guess** (⚠️ unverified) rather than a documented limit: very long
 * replies are split on paragraph boundaries and sent as separate `sendmessage` calls,
 * each with its own unique `client_id` (per [P1] a media caption and its media are already
 * sent as separate requests).
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function splitReply(text, maxChars) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (!s) return []
  if (maxChars <= 0 || s.length <= maxChars) return [s]

  /** @type {string[]} */
  const chunks = []
  let rest = s
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    // Prefer a paragraph break, then a line break, then a sentence end, then a space.
    let cut = window.lastIndexOf('\n\n')
    if (cut < maxChars * 0.5) cut = window.lastIndexOf('\n')
    if (cut < maxChars * 0.5) cut = Math.max(
      window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
    )
    if (cut < maxChars * 0.5) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = maxChars
    else cut += 1 // keep the delimiter with the preceding chunk
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * The minimal view of a DSH session that the orchestration needs.
 *
 * @typedef {object} AgentPort
 * @property {(sessionId: string, text: string) => Promise<string>} runPrompt
 *   Submit `text` to `sessionId`, wait for the agent to fall idle, and resolve with the
 *   assistant's reply text. Implementations MUST reject on failure; the bridge catches.
 *   An empty string means "the agent produced no text" and is handled as such.
 */

/**
 * The minimal view of the WeChat channel that the orchestration needs.
 *
 * @typedef {object} ChannelPort
 * @property {(args: { peerId: string, text: string, contextToken: string }) => Promise<{ ok: boolean, ret?: number, errcode?: number, errmsg?: string }>} sendText
 *   Send one text message. Resolves with the three-layer success verdict described in
 *   the protocol doc (network + HTTP + business `ret`/`errcode`). Implementations MUST
 *   NOT throw for a business-level failure; they report it in the result.
 * @property {(peerId: string, contextToken: string) => Promise<void>} startTyping
 *   Best effort. Never throws; a failure here must not block the reply.
 * @property {(peerId: string) => Promise<void>} stopTyping
 *   Best effort. Called from `finally` so the "typing" state is cleared even when the
 *   agent or the send fails. Source: third-party analysis section 2.6.3.
 */

/**
 * @typedef {object} BridgeOptions
 * @property {ChannelPort} channel
 * @property {AgentPort} agent
 * @property {(msg: any) => string} extractText
 *   Extract the prompt text from one inbound message; return `''` when nothing usable is
 *   present. **Injected on purpose**: `ilink-client.js` already exports
 *   `extractTextFromMessage()`, which is the protocol's own reader of `item_list`
 *   (text items type 1, plus the `voice_item.text` transcript). Keeping a second copy of
 *   that semantic here would let the two drift apart, so the client's function is passed
 *   in and remains the single source of truth.
 * @property {(msg: any, peerId: string) => Promise<{ text: string }|{ content: any[] }|{ text: null, reason: string }>} [describeMedia]
 *   Called **only** when `extractText` found nothing. Fetches, decrypts and saves the message's
 *   first media item and returns the prompt text to hand the agent, or a reason it could not.
 *   **Injected for the same reason as `extractText`**: this file must stay ignorant of `item_list`
 *   numbering, CDN references and AES keys. Absent on a host that cannot fetch media, in which case
 *   media messages keep being refused exactly as before.
 * @property {(msg: string, detail?: unknown) => void} [log]
 * @property {(err: unknown, context: string) => void} [onError]
 * @property {number} [maxReplyChars]  Defaults to 2000 (a defensive guess, see splitReply).
 * @property {boolean} [typingIndicator] Defaults to true.
 */

export class WeixinBridge {
  /** @type {ChannelPort} */
  #channel
  /** @type {AgentPort} */
  #agent
  /** @type {(msg: string, detail?: unknown) => void} */
  #log
  /** @type {(err: unknown, context: string) => void} */
  #onError
  /** @type {number} */
  #maxReplyChars
  /** @type {boolean} */
  #typing
  /** @type {(msg: any) => string} */
  #extractText
  /** @type {((msg: any, peerId: string) => Promise<{ text: string }|{ text: null, reason: string }>)|null} */
  #describeMedia = null

  /** Bounded FIFO of recently handled message ids, for duplicate suppression. */
  /** @type {Set<string>} */
  #seen = new Set()
  /** @type {string[]} */
  #seenOrder = []

  /** Per-session serialisation chains, so two quick messages do not run the agent twice at once. */
  /** @type {Map<string, Promise<void>>} */
  #chains = new Map()

  /**
   * Answers folded into a running turn instead of being queued.
   *
   * ⚠️ Deliberately *not* in `#chains`: that map means "a job waiting for its turn", and a steered answer
   * has no turn of its own. But it must still be waited for on shutdown, or `drain()` would return while
   * a reply was mid-send — the exact silent drop `dispose()` exists to prevent.
   *
   * @type {Set<Promise<void>>}
   */
  #detached = new Set()

  /**
   * How many messages have been steered into each session's current turn.
   *
   * ⚠️ Recorded because repeated steering extends one turn, and `runPrompt` has a hard reply timeout.
   * When that fires the user sees exactly what a genuine stall looks like, so the count is carried into
   * the failure notice — where it distinguishes "still working on the third interjection" from "stopped".
   *
   * @type {Map<string, number>}
   */
  #steers = new Map()

  /** Set once the plugin is disposed, so in-flight work stops promptly. */
  #disposed = false

  /** @param {BridgeOptions} opts */
  constructor(opts) {
    if (!opts?.channel) throw new Error('WeixinBridge: `channel` port is required')
    if (!opts?.agent) throw new Error('WeixinBridge: `agent` port is required')
    if (typeof opts?.extractText !== 'function') {
      throw new Error('WeixinBridge: `extractText` is required (pass ilink-client’s extractTextFromMessage)')
    }
    this.#channel = opts.channel
    this.#agent = opts.agent
    this.#extractText = opts.extractText
    this.#describeMedia = typeof opts.describeMedia === 'function' ? opts.describeMedia : null
    this.#log = opts.log ?? (() => {})
    this.#onError = opts.onError ?? ((err, ctx) => this.#log(`error in ${ctx}`, err))
    this.#maxReplyChars = opts.maxReplyChars ?? 2000
    this.#typing = opts.typingIndicator ?? true
  }

  /**
   * Stop accepting new work. In-flight work is allowed to finish so that a reply is not
   * silently dropped mid-send; the caller should await `drain()` afterwards.
   */
  dispose() {
    this.#disposed = true
  }

  /**
   * Wait for every per-session chain *and* every steered answer to settle. Never rejects.
   * @returns {Promise<void>}
   */
  async drain() {
    try {
      await Promise.allSettled([...this.#chains.values(), ...this.#detached])
    } catch (err) {
      this.#onError(err, 'drain')
    }
  }

  /**
   * Handle one inbound message. **Never rejects** — this is a loop entry point.
   *
   * @param {any} msg              one element of the `msgs` array from `getUpdates`
   * @param {{ botId: string }} ctx
   * @returns {Promise<void>}
   */
  async handleInbound(msg, ctx) {
    try {
      if (this.#disposed) return
      const decision = await this.#classify(msg)
      if (!decision.accept) {
        this.#log(`skipping inbound message: ${decision.reason}`)
        return
      }
      const { peerId, text, contextToken, messageId } = decision

      if (messageId && this.#alreadySeen(messageId)) {
        this.#log('skipping duplicate inbound message', { messageId })
        return
      }

      const sessionId = this.sessionIdFor(ctx.botId, peerId)
      // ⚠️ Unconditional arrival record, and it exists because every other diagnostic on this path sits
      // *inside* the new branch. That makes "no log line" mean two different things at once — "the new
      // code is not loaded" and "the code ran and declined to steer" — which is exactly the ambiguity
      // that stalled the last two test rounds. Logging the state on arrival separates them.
      //
      // It also answers a question the earlier tests could not: whether the two messages ever actually
      // overlapped. If the first turn had already ended, steering has nothing to steer and the run
      // proves nothing either way — it would look like queueing while being two ordinary turns.
      this.#log('inbound arrival', { sessionId, inFlight: this.#chains.has(sessionId) })
      // ── A message that arrives mid-turn should join that turn, not wait behind it ────────────────
      //
      // ⚠️ This gate is why the first version of steering did nothing at all. `#answer` decides whether
      // to steer by reading `agent.status`, but going through `#enqueue` guarantees the previous turn has
      // already ended by the time this one runs — so the condition was unreachable *by construction*, and
      // every message queued exactly as before. The decision lives downstream; this only stops the queue
      // from making that decision impossible.
      //
      // `#chains` holds an entry for the whole duration of a job, so its presence is the "a turn is in
      // flight" signal — the same map that implements queueing.
      // ── A message arriving mid-turn replaces that turn instead of waiting behind it ───────────────
      //
      // The gate has to be open for the port to see a running turn at all: going through `#enqueue`
      // guarantees the previous turn has already ended, which would make any in-flight logic unreachable by
      // construction. That mistake was made once already and cost several rounds.
      if (this.#chains.has(sessionId)) {
        this.#steers.set(sessionId, (this.#steers.get(sessionId) ?? 0) + 1)
        this.#log('turn in flight; handing this message to it instead of queueing', {
          sessionId,
          steers: this.#steers.get(sessionId),
        })
        const steering = this.#answer({ botId: ctx.botId, peerId, sessionId, text, contextToken })
        // Tracked so `drain()` waits for it; released on either outcome, and a rejection is routed to
        // `#onError` rather than left floating (a detached rejection is fatal in this host).
        this.#detached.add(steering)
        void steering.then(
          () => this.#detached.delete(steering),
          (err) => {
            this.#detached.delete(steering)
            this.#onError(err, `steer peer ${peerId}`)
          },
        )
        return
      }
      // A new turn is starting, so any steering count left from the previous one is stale.
      this.#steers.delete(sessionId)
      await this.#enqueue(sessionId, () =>
        this.#answer({ botId: ctx.botId, peerId, sessionId, text, contextToken }),
      )
    } catch (err) {
      // Defence in depth: #answer already catches, but this entry point must not reject
      // even if classification itself surprises us.
      this.#onError(err, 'handleInbound')
    }
  }

  /**
   * Deterministic DSH session id for one WeChat peer on one bot account.
   *
   * Session ids must be stable across restarts, must isolate peers from each other
   * ([P2] implies the same isolation for conversation context), and must not collide with
   * ids a human might type. WeChat ids look like `o9cq80xxx@im.wechat`, so the `@` and any
   * other non-portable characters are replaced.
   *
   * @param {string} botId
   * @param {string} peerId
   * @returns {string}
   */
  sessionIdFor(botId, peerId) {
    const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
    // ⚠️ The `v1` segment is a **reset**, not a first version, and the distinction matters because every
    // earlier segment in this file was a migration. `v2`…`v6` each repaired creation metadata that could
    // not be supplied afterwards (`meta.cwd`, the preset's presence, its value, and finally a coverage
    // gap), and each bump retired the conversation under the old id. Those sessions have all since been
    // deleted, so the version history carries no remaining meaning and starts over here.
    //
    // `v1` therefore means "the first of the current line". If a future change needs another bump, read
    // this note first: the original reasoning for each earlier bump is in FIELD-FINDINGS 4 and 7, and the
    // cost of a bump is always the same — the conversation under the old id is lost.
    return `weixin:v1:${safe(botId) || 'bot'}:${safe(peerId) || 'peer'}`
  }

  /**
   * Decide whether an inbound message is answerable, and extract what is needed.
   *
   * @param {any} msg
   * @returns {{ accept: true, peerId: string, text: string, contextToken: string, messageId: string }
   *          | { accept: false, reason: string }}
   */
  async #classify(msg) {
    if (!msg || typeof msg !== 'object') return { accept: false, reason: 'not an object' }

    // [P7] Ignore our own messages.
    if (Number(msg.message_type) !== 1) {
      return { accept: false, reason: `message_type=${msg.message_type} is not a user message` }
    }

    // [P4] Direct chat only.
    if (msg.group_id) {
      return { accept: false, reason: `group message refused (group_id present, direct-only channel)` }
    }

    const peerId = typeof msg.from_user_id === 'string' ? msg.from_user_id : ''
    if (!peerId) return { accept: false, reason: 'missing from_user_id' }

    let text = this.#extractText(msg)
    if (typeof text !== 'string' || text.length === 0) {
      // No text item and no voice transcript. Before refusing, offer the message to the injected
      // media handler: a photo or a file is a perfectly good prompt once it has been fetched,
      // decrypted, and saved somewhere the agent can read it.
      if (!this.#describeMedia) {
        return { accept: false, reason: 'unsupported item_list (no text and no voice transcript)' }
      }
      const described = await this.#describeMedia(msg, peerId)
      if (described && Array.isArray(described.content)) {
        // The handler built content parts, which is how an image reaches the model at all. `text`
        // carries them onward; the field keeps its name so nothing downstream changes.
        return {
          accept: true,
          peerId,
          text: described.content,
          contextToken: typeof msg.context_token === 'string' ? msg.context_token : '',
          messageId:
            msg.message_id === undefined || msg.message_id === null ? '' : String(msg.message_id),
        }
      }
      if (!described || described.text === null) {
        return {
          accept: false,
          reason: described?.reason ?? 'unsupported item_list (no text and no voice transcript)',
        }
      }
      text = described.text
    }

    return {
      accept: true,
      peerId,
      text,
      contextToken: typeof msg.context_token === 'string' ? msg.context_token : '',
      messageId: msg.message_id === undefined || msg.message_id === null ? '' : String(msg.message_id),
    }
  }

  /**
   * @param {string} messageId
   * @returns {boolean}
   */
  #alreadySeen(messageId) {
    if (this.#seen.has(messageId)) return true
    this.#seen.add(messageId)
    this.#seenOrder.push(messageId)
    while (this.#seenOrder.length > DEDUPE_LIMIT) {
      const oldest = this.#seenOrder.shift()
      if (oldest !== undefined) this.#seen.delete(oldest)
    }
    return false
  }

  /**
   * Run `job` after every previously queued job for the same session, so a fast pair of
   * messages does not drive the agent concurrently. Never rejects.
   *
   * @param {string} sessionId
   * @param {() => Promise<void>} job
   * @returns {Promise<void>}
   */
  async #enqueue(sessionId, job) {
    const previous = this.#chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(
      () => job(),
      () => job(), // a failed predecessor must not skip this one
    )
    // Store the *swallowed* continuation so one failure never poisons the chain.
    const guarded = next.catch((err) => this.#onError(err, `session ${sessionId}`))
    this.#chains.set(sessionId, guarded)
    await guarded
    // Release the slot once this is the tail, keeping the map bounded.
    if (this.#chains.get(sessionId) === guarded) this.#chains.delete(sessionId)
  }

  /**
   * Tell the peer, in one short line, that a run ended without producing a reply.
   *
   * ⚠️ Why this exists: from the user's side, silence is indistinguishable from "still working". The run
   * has already ended — the agent produced nothing, or it threw, or the wait timed out — and the only
   * record was a log line the user cannot read. A channel that stops without a word is worse than one
   * that reports a failure in five characters.
   *
   * Best effort and never throwing: this runs on the failure path, so a failure to report a failure must
   * not become a second one. `#onError` has already recorded the detail where a human can find it.
   *
   * @param {string} peerId
   * @param {string} contextToken
   * @param {string} what short reason, already user-facing
   * @returns {Promise<void>}
   */
  async #notifyFailure(peerId, contextToken, what) {
    try {
      await this.#channel.sendText({ peerId, text: `（${what}）`, contextToken })
    } catch (err) {
      this.#log('could not report a failure to the peer', err)
    }
  }

  /**
   * The per-message pipeline. Never rejects.
   *
   * @param {{ botId: string, peerId: string, sessionId: string, text: string, contextToken: string }} args
   * @returns {Promise<void>}
   */
  async #answer({ peerId, sessionId, text, contextToken }) {
    let typingTicketRequested = false
    try {
      if (this.#typing) {
        typingTicketRequested = true
        await this.#channel.startTyping(peerId, contextToken)
      }

      this.#log('submitting inbound text to session', { sessionId, chars: text.length })
      const reply = await this.#agent.runPrompt(sessionId, text)

      if (this.#disposed) {
        this.#log('disposed while awaiting agent reply; dropping reply', { sessionId })
        return
      }

      // A steered message joins the turn that is already running and produces no reply of its own. That
      // silence is deliberate, so it must not be reported as a failure — and this check has to come
      // *before* the emptiness check below, which reports exactly that. See the steer branch in
      // dsh-agent-port.js for why the signal is an object rather than a string.
      // An interrupted turn is silent on purpose: a newer message cancelled it, and the replacement turn
      // answers the same question with the first message already in its history. Reporting that
      // cancellation as "no reply was produced" would be false, and it is exactly what the user saw before
      // this check existed.
      if (reply && typeof reply === 'object' && /** @type {any} */ (reply).interrupted === true) {
        this.#log('turn was interrupted by a newer message; the replacement answers it', { sessionId })
        return
      }

      if (reply && typeof reply === 'object' && /** @type {any} */ (reply).steered === true) {
        this.#log('steered into the running turn; no separate reply is expected', { sessionId })
        return
      }

      const body = typeof reply === 'string' ? reply.trim() : ''
      if (!body) {
        // ⚠️ The silent path. The run is over and nothing was produced, so say so: without this the user
        // cannot tell "stopped" from "still running", which is exactly the complaint that added this.
        // Carry the steering count: a turn that was repeatedly interjected and then hit the reply timeout
        // looks identical to a genuine stall, and this is the one clue that separates them.
        const steered = this.#steers.get(sessionId) ?? 0
        this.#log('agent produced no text; reporting it to the peer', { sessionId, steered })
        await this.#notifyFailure(
          peerId,
          contextToken,
          steered > 0 ? `没有产生回复内容（这一轮里被插话 ${steered} 次）` : '没有产生回复内容',
        )
        return
      }

      const chunks = splitReply(body, this.#maxReplyChars)
      for (const [index, chunk] of chunks.entries()) {
        // A unique client_id per send is required by the protocol.
        const result = await this.#channel.sendText({ peerId, text: chunk, contextToken })
        if (!result?.ok) {
          // [P1] HTTP 200 alone never proves delivery: report the business verdict.
          this.#log('sendText reported failure', {
            part: `${index + 1}/${chunks.length}`,
            ret: result?.ret,
            errcode: result?.errcode,
            errmsg: result?.errmsg,
          })
          break // do not keep sending the tail of a reply that is being refused
        }
      }
    } catch (err) {
      this.#onError(err, `answer peer ${peerId}`)
      await this.#notifyFailure(peerId, contextToken, '处理失败')
    } finally {
      if (typingTicketRequested) {
        try {
          await this.#channel.stopTyping(peerId)
        } catch (err) {
          // Cancelling the typing state is best effort and must never mask the real error.
          this.#log('stopTyping failed', err)
        }
      }
    }
  }
}

// Text extraction lives in `ilink-client.js` as `extractTextFromMessage()` and is
// injected into `WeixinBridge` through the `extractText` option, so the protocol's own
// reader of `item_list` stays the single source of truth. Do not reintroduce a second
// copy here: the two would drift, and a drifted reader silently turns media into text
// (or text into nothing), which is far harder to notice than a crash.

