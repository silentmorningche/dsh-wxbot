// @ts-check
/**
 * A status file for the channel plugin.
 *
 * Why this exists: a channel plugin that fails to load, or that loads and then fails during
 * login, produces **exactly the same visible result** — nothing. On the machine this was
 * developed on there was no shell, no readable application log, and no way to attach a
 * debugger, so "did it load, and how far did it get?" had no answer. This file is that
 * answer, and it is a reasonable thing for a channel plugin to keep anyway.
 *
 * Design rules, all of which matter because a diagnostic must never become the fault:
 *
 *   - **Synchronous and fully wrapped.** Every write is inside a `try`/`catch`; the first
 *     failure disables the writer permanently and silently. No promise is created, so this
 *     module cannot contribute an unhandled rejection — which DSH treats as fatal.
 *   - **Never throws into the caller.** `set()` always returns.
 *   - **Small and bounded.** Only the last few phases are kept, so a long-running poll loop
 *     cannot grow the file without limit.
 *   - **No secrets, with one stated exception.** Callers pass only non-sensitive fields, and this
 *     module refuses to serialise anything that looks like a credential key. `note()` mirrors raw
 *     log lines, and the login flow deliberately logs the QR link — a short-lived credential that
 *     is already stored on purpose under `qr:materialized.link`. The file sits beside the bot token
 *     and is exactly as sensitive as it.
 *
 * The file lives at `<storageDir>/status.json`, next to the account state, so it is removed
 * along with the account when the user deletes that directory.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Phases kept in the trail. Older entries are dropped. */
// Raised from 30: the agent adapter logs up to a dozen events per prompt, which evicted the
// lifecycle entries that matter most (login, account restore, create/resume) within a few messages.
const TRAIL_LIMIT = 100

/**
 * Mirrored log lines kept. Deliberately separate from the trail: the trail is a curated lifecycle
 * narrative, while this is the raw logger, and mixing the two would let chatty code evict the
 * narrative — which is exactly what happened before `TRAIL_LIMIT` was raised.
 */
const LOG_TAIL_LIMIT = 60

/** Keys whose values are never written, matched case-insensitively as substrings. */
const FORBIDDEN_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'aeskey',
  'aes_key',
  'qrcode',
  'typing_ticket',
  'context_token',
  'authorization',
]

/**
 * @typedef {object} StatusWriter
 * @property {string} file absolute path of the status file
 * @property {(phase: string, detail?: Record<string, unknown>) => void} set
 * @property {(level: string, message: string) => void} note mirror one log line into the file
 */

/**
 * @param {string} dir directory to write `status.json` into (the plugin's storageDir)
 * @returns {StatusWriter}
 */
export function createStatusWriter(dir) {
  const file = join(dir, 'status.json')
  /**
   * @type {{
   *   plugin: string,
   *   startedAt: string,
   *   updatedAt: string,
   *   phase: string,
   *   detail: Record<string, unknown>,
   *   trail: Array<{at: string, phase: string, detail: Record<string, unknown>}>,
   *   logTail: Array<{at: string, level: string, message: string}>,
   * }}
   */
  const state = {
    plugin: 'dsh-wxbot',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: 'created',
    detail: {},
    trail: [],
    logTail: [],
  }
  let disabled = false

  /** Coalesces log-driven writes, so a burst of `note()` calls costs one write instead of N. */
  let flushScheduled = false

  /** @param {unknown} value @returns {unknown} */
  const sanitise = (value) => {
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.slice(0, 10).map(sanitise)
    if (typeof value === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {}
      for (const [k, v] of Object.entries(/** @type {any} */ (value))) {
        const lower = k.toLowerCase()
        out[k] = FORBIDDEN_KEY_PARTS.some((part) => lower.includes(part)) ? '<redacted>' : sanitise(v)
      }
      return out
    }
    return String(value)
  }

  /** Write the document. Write-then-rename, so a reader never sees a half-written file. */
  const write = () => {
    if (disabled) return
    try {
      state.updatedAt = new Date().toISOString()
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch {
      // A status file is a convenience. Losing it must never disturb the channel.
      disabled = true
    }
  }

  /** Defer a write to the end of the current tick, at most one per tick. */
  const scheduleWrite = () => {
    if (disabled || flushScheduled) return
    flushScheduled = true
    // A microtask, not a timer: it cannot be dropped and it cannot outlive disposal. `write` never
    // throws, so this cannot become the unhandled rejection that DSH turns into a process exit.
    queueMicrotask(() => {
      flushScheduled = false
      write()
    })
  }

  return {
    file,
    set(phase, detail) {
      if (disabled) return
      try {
        const now = new Date().toISOString()
        state.phase = String(phase)
        state.detail = /** @type {Record<string, unknown>} */ (sanitise(detail ?? {})) ?? {}
        state.trail.push({ at: now, phase: state.phase, detail: state.detail })
        while (state.trail.length > TRAIL_LIMIT) state.trail.shift()
      } catch {
        disabled = true
        return
      }
      write()
    },

    /**
     * Mirror one log line into the file.
     *
     * ⚠️ This exists so that **no future code can be invisible**. Three separate debugging dead ends
     * in this plugin came from diagnostics that never reached a readable channel: a probe that
     * prevented the plugin from loading at all, an event-payload printer that hid the very error it
     * was added to reveal, and a failure list that was declared but never passed to the function
     * that filled it. Each of those relied on the author remembering to mirror the new code by hand
     * — which is precisely the process that failed. Piping the logger through here removes the
     * possibility instead of asking for more care.
     *
     * @param {string} level
     * @param {string} message
     */
    note(level, message) {
      if (disabled) return
      try {
        state.logTail.push({
          at: new Date().toISOString(),
          level: String(level),
          message: String(message).slice(0, 400),
        })
        while (state.logTail.length > LOG_TAIL_LIMIT) state.logTail.shift()
      } catch {
        disabled = true
        return
      }
      scheduleWrite()
    },
  }
}
