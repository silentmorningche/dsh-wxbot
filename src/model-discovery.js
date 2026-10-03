// @ts-check
/**
 * Work out which model to create agents with — without asking anyone to configure it.
 *
 * Why this exists: `@deepseek-ai/dsh-agent`'s `create()` does **not** consult the profile's
 * `agent-default-model` row, so a programmatically created session has no model. The system prompt
 * then fails to assemble —
 *
 *     prompt variable "{{model}}" has no value for this assembly
 *
 * — and the turn ends **before any model call**, which from the outside looks exactly like an agent
 * that had nothing to say. The obvious fix is to configure the model, and that is what this plugin
 * did at first. It is the wrong fix: it makes every install depend on the user hand-copying three
 * values out of their own profile, and getting one wrong reproduces the silent failure.
 *
 * So the values are discovered instead, in descending order of authority:
 *
 *   1. explicit configuration — an override always wins, field by field;
 *   2. **`ctx.agentDefaultModel.currentSelection()`** — the service that owns the process-level
 *      default and whose documented job is answering exactly this question;
 *   3. the profile's own `cordis.patch.yml` / `cordis.yml`, read for the `agent-default-model` row,
 *      for a host where that service is not mounted;
 *   4. the built-in defaults, with a warning — never silently.
 *
 * Every result carries its `source`, so the plugin can record where the model came from. That
 * matters: "which model am I actually using, and who decided?" is the first question to ask when a
 * turn comes back empty.
 *
 * The module imports only `node:` builtins and has no side effects, so it is directly unit-testable.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Field names that carry a model selection, in the order they are reported. */
export const MODEL_FIELDS = ['provider', 'model', 'reasoningEffort']

/**
 * Last-resort model. These mirror the shipped `desktop` profile; they exist so the plugin still
 * works on a machine whose default cannot be read, and the caller is expected to warn when they win.
 */
export const FALLBACK_MODEL = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'high',
})

/** Profile-relative files that may carry the default-model row, in the order they are tried. */
export const MODEL_CONFIG_FILES = ['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml', 'cordis.yaml']

/**
 * Ask the service that owns the process-level default model.
 *
 * `@deepseek-ai/dsh-agent-default-model` states its contract plainly: it "answers one question — which
 * model should a new agent use? — so entry points that create agents query it instead of
 * reimplementing the defaults". `currentSelection()` returns a detached
 * `{ provider, model, reasoningEffort? }` synchronously.
 *
 * ⚠️ An earlier version of this module read the model off **another conversation's live agent**
 * (`agent.options`) instead. It never touched conversation content — only the model route — but it was
 * still the wrong source: that value belongs to the profile, not to that session, so a per-session
 * override would have been inherited as though it were the machine default, and the read only worked
 * while some unrelated agent happened to be live. Querying the owning service removes the guesswork.
 *
 * @param {any} service `ctx.agentDefaultModel`, or null
 * @returns {{provider?: string, model?: string, reasoningEffort?: string}|null}
 */
export function parseModelFromService(service) {
  if (!service || typeof service.currentSelection !== 'function') return null

  /** @type {any} */
  let selection
  try {
    selection = service.currentSelection()
  } catch {
    return null
  }
  if (!selection || typeof selection !== 'object') return null
  if (typeof selection.model !== 'string' || selection.model.length === 0) return null

  /** @type {{provider?: string, model?: string, reasoningEffort?: string}} */
  const picked = { model: selection.model }
  if (typeof selection.provider === 'string' && selection.provider) picked.provider = selection.provider
  if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort) {
    picked.reasoningEffort = selection.reasoningEffort
  }
  return picked
}

/**
 * Pull a model selection out of the text of a Cordis patch or config file.
 *
 * ⚠️ Deliberately a line scan, not a YAML parse. The plugin may not import third-party modules, and
 * the shape being read is one known row whose `config` is a flat map of scalars:
 *
 *     - id: agent-default-model
 *       name: '@deepseek-ai/dsh-agent-default-model'
 *       config:
 *         provider: deepseek-official
 *         model: deepseek-flash
 *         reasoningEffort: high
 *
 * A general parser would be more capable and much more code to get wrong. The scan stops at the next
 * list item so a later, unrelated block is never mistaken for this one.
 *
 * @param {unknown} text
 * @returns {{provider?: string, model?: string, reasoningEffort?: string}|null} null when no row, or
 *   a row with neither `model` nor `provider`, was found
 */
export function parseDefaultModelConfig(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const lines = text.split(/\r?\n/)

  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    // Matches both the row id and the package name, so either spelling of the row is found.
    if (/agent-default-model/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return null

  /** @type {Record<string, string>} */
  const found = {}
  const end = Math.min(lines.length, start + 30)
  for (let i = start; i < end; i += 1) {
    const line = lines[i]
    // A new list item ends this row. `start` itself is the row's own first line.
    if (i > start && /^\s*-\s/.test(line)) break

    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*['"]?([^'"#\r\n]+?)['"]?\s*(?:#.*)?$/.exec(line)
    if (!match) continue
    const key = match[1]
    if (!MODEL_FIELDS.includes(key)) continue
    const value = match[2].trim()
    if (value) found[key] = value
  }

  if (!found.model && !found.provider) return null
  return found
}

/**
 * Read a model selection from the profile's own config files.
 *
 * @param {string} profileDir
 * @returns {{provider?: string, model?: string, reasoningEffort?: string}|null}
 */
export function parseModelFromProfile(profileDir) {
  if (typeof profileDir !== 'string' || profileDir.length === 0) return null
  for (const name of MODEL_CONFIG_FILES) {
    try {
      const parsed = parseDefaultModelConfig(readFileSync(join(profileDir, name), 'utf8'))
      if (parsed) return parsed
    } catch {
      /* missing or unreadable: try the next candidate */
    }
  }
  return null
}

/**
 * Discover the model, preferring the most authoritative source that yields a value.
 *
 * Configured fields always win, field by field, so a partial override is possible: set only `model`
 * and the provider and effort still come from discovery.
 *
 * @param {object} options
 * @param {{provider?: string, model?: string, reasoningEffort?: string}} options.configured
 * @param {any} [options.defaultModelService] `ctx.agentDefaultModel`, the owning service
 * @param {string} [options.profileDir]
 * @returns {{provider: string, model: string, reasoningEffort: string, source: string, detail: Record<string, unknown>}}
 */
export function discoverModel(options) {
  const configured = options?.configured ?? {}
  /** @type {Record<string, string>} */
  const override = {}
  for (const field of MODEL_FIELDS) {
    const value = /** @type {any} */ (configured)[field]
    if (typeof value === 'string' && value.length > 0) override[field] = value
  }
  const configuredCount = Object.keys(override).length

  // 1. Fully configured: nothing to discover.
  if (configuredCount === MODEL_FIELDS.length) {
    return { ...FALLBACK_MODEL, ...override, source: 'config', detail: {} }
  }

  // 2. The service that owns the process-level default.
  const fromService = parseModelFromService(options?.defaultModelService)

  // 3. The profile's own config files, when that service is not available.
  const fromProfile = fromService ? null : parseModelFromProfile(String(options?.profileDir ?? ''))

  const discovered = fromService ?? fromProfile ?? null
  if (discovered) {
    const source = fromService ? 'default-model-service' : 'profile-config'
    const merged = { ...FALLBACK_MODEL, ...discovered, ...override }
    return {
      ...merged,
      source: configuredCount > 0 ? `${source}+config` : source,
      detail: { discoveredFrom: source, discovered, configured: override },
    }
  }

  // 4. Nothing worked: use the built-in defaults, and say so. The caller reports this as a warning,
  //    because a wrong model is invisible until a turn comes back empty.
  return {
    ...FALLBACK_MODEL,
    ...override,
    source: 'fallback',
    detail: { configured: override, profileDir: String(options?.profileDir ?? '') },
  }
}
