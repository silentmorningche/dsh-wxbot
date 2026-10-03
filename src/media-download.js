// @ts-check
/**
 * Inbound media: resolve the CDN reference, download it, decrypt it, and name it.
 *
 * Scope note: this module is deliberately **pure with respect to the protocol client**. It takes a
 * `CDNMedia`-shaped container and a base URL and does the rest, so it neither reaches into
 * `ilink-client.js`'s internals nor duplicates the parts that file already owns — the CDN base
 * constant, the `CDNMedia` typedef, and the media flow notes all live there, and were written from
 * the same protocol section this implements.
 *
 * The rules, all from the protocol document:
 *
 *   - Download URL: prefer the server-supplied `full_url`; otherwise
 *     `<cdnBase>/download?encrypted_query_param=<urlencoded encrypt_query_param>`.
 *   - Key: for an image, `image_item.aeskey` (bare 32-char hex) outranks `media.aes_key`; for every
 *     other kind, `media.aes_key` is the only source, and the official downloader **skips** keyless
 *     voice, file and video items rather than guessing.
 *   - `aes_key` itself accepts two encodings; see `media-crypto.js`.
 *   - Inbound media is capped at 100 MiB by the official client. A cap is not optional here: the
 *     size is attacker-influenced, and so is the decrypted size.
 *
 * Only `node:` builtins are imported. `downloadMedia` takes its `fetch` implementation as a
 * parameter, so the decision logic is unit-testable without a network.
 */

import { AES_KEY_BYTES, decryptMediaPayload } from './media-crypto.js'

/** Item types from `item_list[].type`. */
export const ITEM_TEXT = 1
export const ITEM_IMAGE = 2
export const ITEM_VOICE = 3
export const ITEM_FILE = 4
export const ITEM_VIDEO = 5

/**
 * Official inbound ceiling. Enforced before and after decryption: a small ciphertext can expand into
 * a large plaintext, and the padding rule means the difference is at most one block, but the input
 * cap is what actually bounds memory.
 */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024

/** Default network budget for one media download. */
export const MEDIA_TIMEOUT_MS = 60_000

/** Human labels, used in the text handed to the agent. */
const KIND_LABEL = {
  [ITEM_IMAGE]: '图片',
  [ITEM_VOICE]: '语音',
  [ITEM_FILE]: '文件',
  [ITEM_VIDEO]: '视频',
}

/**
 * @param {number} itemType
 * @returns {string}
 */
export function kindLabel(itemType) {
  return KIND_LABEL[itemType] ?? `未知类型 ${itemType}`
}

/**
 * Find the first media item in an inbound message.
 *
 * Lives here rather than in `bridge.js` so the bridge needs no knowledge of `item_list` numbering —
 * the same reason `extractText` is injected. Images are preferred over other kinds when a message
 * carries several, because an image is the case the agent can act on most directly.
 *
 * @param {any} msg
 * @returns {{ item: any, itemType: number, index: number }|null}
 */
export function firstMediaItem(msg) {
  const list = Array.isArray(msg?.item_list) ? msg.item_list : null
  if (!list) return null

  /** @type {{ item: any, itemType: number, index: number }|null} */
  let fallback = null
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    const type = Number(item?.type)
    if (!containerFieldFor(type)) continue
    const found = { item, itemType: type, index: i }
    if (type === ITEM_IMAGE) return found
    if (!fallback) fallback = found
  }
  return fallback
}

/**
 * The container field that holds the media reference for an item type.
 *
 * @param {number} itemType
 * @returns {string|null}
 */
export function containerFieldFor(itemType) {
  switch (itemType) {
    case ITEM_IMAGE:
      return 'image_item'
    case ITEM_VOICE:
      return 'voice_item'
    case ITEM_FILE:
      return 'file_item'
    case ITEM_VIDEO:
      return 'video_item'
    default:
      return null
  }
}

/**
 * Build the download URL for a media reference.
 *
 * `full_url` wins when present, because the server may point at a host the client's configured CDN
 * base does not cover.
 *
 * @param {any} container a `CDNMedia`-shaped object
 * @param {string} cdnBaseUrl
 * @returns {string|null}
 */
export function mediaUrlFrom(container, cdnBaseUrl) {
  if (!container || typeof container !== 'object') return null

  const full = typeof container.full_url === 'string' ? container.full_url.trim() : ''
  if (full) return full

  const param = typeof container.encrypt_query_param === 'string' ? container.encrypt_query_param.trim() : ''
  if (!param) return null

  const base = String(cdnBaseUrl ?? '').replace(/\/+$/, '')
  if (!base) return null
  return `${base}/download?encrypted_query_param=${encodeURIComponent(param)}`
}

/**
 * Choose the key for a media item, applying the image precedence rule.
 *
 * @param {any} item one `item_list[]` entry
 * @param {number} itemType
 * @returns {{ raw: string|null, source: string, decodable: boolean }}
 */
export function pickMediaKey(item, itemType) {
  const containerField = containerFieldFor(itemType)
  const container = containerField ? item?.[containerField] : null
  const media = container?.media ?? null

  if (itemType === ITEM_IMAGE) {
    const imageKey = typeof container?.aeskey === 'string' ? container.aeskey.trim() : ''
    if (imageKey) return { raw: imageKey, source: 'image_item.aeskey', decodable: isDecodableKey(imageKey) }
  }

  const mediaKey = typeof media?.aes_key === 'string' ? media.aes_key.trim() : ''
  if (mediaKey) return { raw: mediaKey, source: 'media.aes_key', decodable: isDecodableKey(mediaKey) }

  return { raw: null, source: 'none', decodable: false }
}

/**
 * Whether a key spelling decodes to exactly one AES-128 key.
 *
 * Kept local and cheap so the download path can decide *before* fetching whether a payload is
 * encrypted, without importing the decoder's whole surface.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isDecodableKey(raw) {
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return true
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length === AES_KEY_BYTES) return true
  return /^[0-9a-fA-F]{32}$/.test(decoded.toString('utf8'))
}

/** Magic-byte signatures worth naming, because the agent is told what it received. */
const SIGNATURES = [
  { ext: 'png', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'webp', mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { ext: 'pdf', mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: 'zip', mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { ext: 'mp4', mime: 'video/mp4', bytes: [0x00, 0x00, 0x00] },
  { ext: 'amr', mime: 'audio/amr', bytes: [0x23, 0x21, 0x41, 0x4d] },
]

/** Fallback extension per item type when the bytes match nothing known. */
const TYPE_FALLBACK = {
  [ITEM_IMAGE]: { ext: 'bin', mime: 'application/octet-stream' },
  [ITEM_VOICE]: { ext: 'silk', mime: 'audio/silk' },
  [ITEM_FILE]: { ext: 'bin', mime: 'application/octet-stream' },
  [ITEM_VIDEO]: { ext: 'mp4', mime: 'video/mp4' },
}

/**
 * Name the payload from its first bytes, falling back to the item type.
 *
 * @param {Buffer} bytes
 * @param {number} itemType
 * @returns {{ ext: string, mime: string }}
 */
export function sniffMediaType(bytes, itemType) {
  if (Buffer.isBuffer(bytes) && bytes.length >= 4) {
    for (const sig of SIGNATURES) {
      if (sig.bytes.every((b, i) => bytes[i] === b)) {
        // `webp` shares RIFF with other containers; require the WEBP tag at offset 8.
        if (sig.ext === 'webp' && bytes.length >= 12 && bytes.subarray(8, 12).toString('ascii') !== 'WEBP') continue
        // `mp4` is a box format: bytes 4..8 must read `ftyp` to be worth the name.
        if (sig.ext === 'mp4' && bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') !== 'ftyp') continue
        return { ext: sig.ext, mime: sig.mime }
      }
    }
  }
  return TYPE_FALLBACK[itemType] ?? { ext: 'bin', mime: 'application/octet-stream' }
}

/**
 * Download one media item and decrypt it.
 *
 * Never throws: every failure is returned as `{ ok: false, reason }`, because a media message that
 * cannot be fetched must still leave the text channel working, and an exception here would surface as
 * a silent drop of the whole message.
 *
 * @param {object} options
 * @param {any} options.item one `item_list[]` entry
 * @param {number} options.itemType
 * @param {string} options.cdnBaseUrl
 * @param {typeof fetch} options.fetchImpl
 * @param {number} [options.maxBytes]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: true, bytes: Buffer, encrypted: boolean, padding: string|null, mime: string, ext: string, url: string, keySource: string, note?: string}|{ok: false, reason: string}>}
 */
export async function downloadMedia(options) {
  const { item, itemType, cdnBaseUrl, fetchImpl } = options ?? {}
  const maxBytes = options?.maxBytes ?? MAX_MEDIA_BYTES
  const timeoutMs = options?.timeoutMs ?? MEDIA_TIMEOUT_MS

  const containerField = containerFieldFor(itemType)
  if (!containerField) return { ok: false, reason: `item type ${itemType} carries no media` }
  const container = item?.[containerField]?.media ?? null
  if (!container) return { ok: false, reason: `${containerField} has no media reference` }

  const url = mediaUrlFrom(container, cdnBaseUrl)
  if (!url) return { ok: false, reason: 'media reference has neither full_url nor encrypt_query_param' }

  const key = pickMediaKey(item, itemType)
  if (!key.raw && itemType !== ITEM_IMAGE) {
    // Matches the official downloader: keyless voice, file and video are skipped, not guessed.
    return { ok: false, reason: `${containerField} has no aes_key (official client skips these)` }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(url, { signal: controller.signal })
  } catch (err) {
    return { ok: false, reason: `download failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) return { ok: false, reason: `download HTTP ${response.status}` }

  const lengthHeader = Number(response.headers?.get?.('content-length') ?? '')
  if (Number.isFinite(lengthHeader) && lengthHeader > maxBytes) {
    return { ok: false, reason: `media is ${lengthHeader} bytes, over the ${maxBytes} byte cap` }
  }

  let ciphertext
  try {
    ciphertext = Buffer.from(await response.arrayBuffer())
  } catch (err) {
    return { ok: false, reason: `reading the body failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (ciphertext.length > maxBytes) {
    return { ok: false, reason: `media is ${ciphertext.length} bytes, over the ${maxBytes} byte cap` }
  }

  const result = decryptMediaPayload(ciphertext, key.raw)
  if (result.encrypted && result.plaintext.length === 0 && ciphertext.length > 0) {
    return { ok: false, reason: `decryption produced nothing (${result.note ?? 'unknown reason'})` }
  }

  const sniffed = sniffMediaType(result.plaintext, itemType)
  /** @type {any} */
  const out = {
    ok: true,
    bytes: result.plaintext,
    encrypted: result.encrypted,
    padding: result.padding,
    mime: sniffed.mime,
    ext: sniffed.ext,
    url,
    keySource: key.source,
  }
  if (result.note) out.note = result.note
  return out
}
