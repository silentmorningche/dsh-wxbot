// @ts-check
/**
 * The reply convention that lets the agent send media back, without a tool.
 *
 * Why a convention instead of a tool: giving the agent a real tool requires the preset machinery to
 * mount it, and a plugin cannot bind a preset in this composition (measured: `ctx.agentPresets` is
 * unreachable, and appending the selection event alone does not mount anything — the registry's own
 * `append` is the *record* of a mount it performs, not the trigger). The agent can already emit text,
 * so the one capability it always has is a way to ask.
 *
 * So the agent is told: to send a file, put a line of exactly this shape in your reply, and the plugin
 * will strip it out and upload the file:
 *
 *     [wechat-send: D:\\path\\to\\file.pdf]
 *
 * Design rules, each of which is a real failure mode rather than a preference:
 *
 *   - **Own line only.** A marker embedded in prose would let ordinary text that happens to contain
 *     brackets delete itself from the reply. The agent is told to put it on its own line, and only
 *     such a line is consumed.
 *   - **Everything up to the last `]` is the path.** Windows paths contain spaces, and Chinese file
 *     names are common here; a naive split on whitespace or a first-bracket match would truncate both.
 *   - **Malformed markers stay in the reply.** If the closing bracket is missing, the line is left
 *     alone: silently swallowing a line the agent wrote is worse than showing it.
 *   - **Never throws.** This runs on the reply path; a parse failure must not cost the user the reply.
 */

/** The marker keyword. Kept in one place: the prompt text and the parser must agree. */
export const SEND_MARKER = 'wechat-send'

// (A retired `sendConventionHint()` lived here, and the reason it is gone is worth one line: its job —
// telling the model about the file convention — moved to `channelBriefing()` in ./channel-briefing.js,
// which carries the channel context the hint never had. Its three-version history is *not* lost: it is
// finding 9 in docs/FIELD-FINDINGS.md, which is the better home for it, because the lesson there is about
// prompt wording rather than about this file.)

/**
 * Split a reply into the text to send and the files it asked to send.
 *
 * @param {unknown} reply the agent's reply text
 * @param {number} [maxRequests] bound on how many files one reply may request
 * @returns {{text: string, requests: Array<{path: string}>, malformed: string[]}}
 */
export function extractMediaRequests(reply, maxRequests = 3) {
  const source = typeof reply === 'string' ? reply : ''
  if (source.length === 0) return { text: '', requests: [], malformed: [] }

  const limit = Number.isFinite(maxRequests) && maxRequests > 0 ? Math.floor(maxRequests) : 3
  const lines = source.split(/\r?\n/)
  const kept = []
  /** @type {Array<{path: string}>} */
  const requests = []
  /** @type {string[]} */
  const malformed = []

  // `[wechat-send:` … `]`, with the path being everything up to the LAST `]` on the line so that a
  // path containing `]` still survives where possible.
  const open = new RegExp(`^\\s*\\[\\s*${SEND_MARKER}\\s*:\\s*(.*)$`, 'i')

  for (const line of lines) {
    const match = open.exec(line)
    if (!match) {
      kept.push(line)
      continue
    }
    const rest = match[1]
    const close = rest.lastIndexOf(']')
    if (close < 0) {
      // No closing bracket: the agent wrote something we do not understand. Show it rather than eat it.
      malformed.push(line)
      kept.push(line)
      continue
    }
    const path = rest.slice(0, close).trim()
    const trailing = rest.slice(close + 1).trim()
    if (path.length === 0) {
      malformed.push(line)
      kept.push(line)
      continue
    }
    // Anything after the closing bracket is not part of the convention; keep it in the visible reply
    // rather than dropping words the agent wrote.
    if (trailing.length > 0) kept.push(trailing)
    if (requests.length < limit) requests.push({ path })
    else malformed.push(line)
  }

  return {
    text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    requests,
    malformed,
  }
}
