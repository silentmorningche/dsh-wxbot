// @ts-check
/**
 * The channel briefing: what the model needs to know about *where it is*, appended to inbound prompts.
 *
 * Why this exists at all: the natural home for a standing instruction is the system prompt, and the
 * system prompt belongs to the preset — which a plugin cannot bind (measured: `ctx.agentPresets` is
 * unreachable, and appending the selection event only records a choice, it does not mount). So a
 * session created by this plugin runs with a persona written for a desktop coding surface and no idea
 * that it is answering someone on a phone. That produced headings, bullet lists, and paragraphs of
 * internal plumbing narrated to a person who asked one short question.
 *
 * So the briefing carries what the preset would have carried, in the smallest space that works. Three
 * rules governed the wording, each learned the hard way:
 *
 *   1. **The mechanism is stated, never explained.** An earlier hint said "the plugin removes this line";
 *      the agent relayed that sentence to the user verbatim. Telling a model how something works reads
 *      as an invitation to describe how it works.
 *   2. **No list of what it cannot do.** Saying "you have no file tools" produced a paragraph explaining
 *      that limitation and listing reasons a send might fail. An agent told what it lacks will report it.
 *   3. **Compression is not cosmetic.** This text rides on the prompt, so every clause is charged on
 *      every turn it is sent. It earns its length or it goes.
 *
 * Appended on the first prompt of a session and then every `briefingInterval` prompts: frequent enough
 * to survive context compaction, sparse enough that the cost is amortised.
 */

import { SEND_MARKER } from './reply-media.js'

/**
 * The briefing text. Keep it short; see the module note on why length is charged.
 *
 * @returns {string}
 */
export function channelBriefing() {
  return [
    '[微信通道]',
    '- 用户用微信和你对话且只能看到纯文本',
    `- 需要把文件发给用户时在回复末尾单独占一行写：[${SEND_MARKER}: 文件绝对路径]`,
    '- 用户发来的图片你可以直接看到',
  ].join('\n')
}

/**
 * Whether the briefing is due on a given prompt of a session.
 *
 * The first prompt always gets it, so a fresh conversation is never briefed late. Afterwards it is due
 * every `interval` prompts, which bounds the cost while keeping it inside the window that context
 * compaction has not yet summarised away.
 *
 * @param {number} promptIndex 1-based count of prompts seen for this peer
 * @param {number} interval every how many prompts to repeat; 0 or less means "first only"
 * @returns {boolean}
 */
export function briefingDue(promptIndex, interval) {
  const index = Number(promptIndex)
  if (!Number.isFinite(index) || index <= 0) return false
  if (index === 1) return true
  const every = Number(interval)
  if (!Number.isFinite(every) || every <= 1) return false
  return index % Math.floor(every) === 0
}
