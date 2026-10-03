// @ts-check
/**
 * Outbound media: encrypt, obtain an upload target, upload, and build the message item.
 *
 * This is the mirror of `media-download.js`, and it follows the same shape for the same reason: the
 * `fetch` implementation **and** the "obtain an upload URL" call are both injected, so every decision
 * this module makes — URL selection, the protocol's three-layer success rule, failure classification,
 * the exact item shape — is unit-testable without a network or a live login. Only the single real
 * upload remains unverifiable locally.
 *
 * The protocol steps, taken from the notes already recorded in `ilink-client.js`:
 *
 *   E1. `POST /ilink/bot/getuploadurl` with `filekey`, `media_type`, `to_user_id`, `rawsize`,
 *       `rawfilemd5`, `filesize`, `no_need_thumb`, `aeskey`. The response is preferred as
 *       `upload_full_url`.
 *   E2. Encrypt AES-128-ECB + PKCS#7; the ciphertext length is `ceil((rawsize + 1) / 16) * 16`.
 *   E3. Upload the ciphertext. **HTTP 200 alone is not success**: the response must also carry a
 *       non-empty `x-encrypted-param` header, which is the download parameter the later `sendmessage`
 *       references.
 *   E4. Build the item and send it. Text and media travel as **separate** `sendmessage` requests.
 *
 * ⚠️ One deliberate refusal: when `upload_full_url` is absent, the notes say the URL is assembled from
 * `upload_param` + `filekey` but never record the path template, and that template is not something to
 * guess. The module reports the gap instead of inventing an endpoint, because a wrong endpoint would
 * surface as a server-side error that no local test can distinguish from a malformed request.
 */

import { createHash, randomBytes } from 'node:crypto'
import { AES_KEY_BYTES, aesKeyToCdnKey, encryptAesEcb, paddedLength } from './media-crypto.js'

/** `media_type` values, shared with the inbound item numbering only by coincidence of the protocol. */
export const UPLOAD_MEDIA_TYPE = Object.freeze({ IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 })

/** The item type each upload media type becomes in `msg.item_list`. */
const ITEM_TYPE_FOR_MEDIA = Object.freeze({
  [UPLOAD_MEDIA_TYPE.IMAGE]: 2,
  [UPLOAD_MEDIA_TYPE.VIDEO]: 5,
  [UPLOAD_MEDIA_TYPE.FILE]: 4,
  [UPLOAD_MEDIA_TYPE.VOICE]: 3,
})

/** Default network budget for the upload POST. */
export const UPLOAD_TIMEOUT_MS = 120_000

/**
 * Choose the upload target from a `getuploadurl` response.
 *
 * @param {any} response
 * @returns {{url: string}|{url: null, reason: string}}
 */
export function uploadUrlFrom(response) {
  if (!response || typeof response !== 'object') {
    return { url: null, reason: 'getuploadurl returned nothing usable' }
  }
  const full = typeof response.upload_full_url === 'string' ? response.upload_full_url.trim() : ''
  if (full) return { url: full }
  const param = typeof response.upload_param === 'string' ? response.upload_param.trim() : ''
  return {
    url: null,
    reason:
      param
        ? 'getuploadurl returned upload_param without upload_full_url, and the fallback URL template ' +
          'is not recorded in the protocol notes — refusing rather than guessing an endpoint'
        : 'getuploadurl returned neither upload_full_url nor upload_param',
  }
}

/**
 * Build the `msg.item_list` entry that references an uploaded object.
 *
 * @param {object} options
 * @param {number} options.mediaType
 * @param {string} options.encryptQueryParam the upload response's `x-encrypted-param`
 * @param {string} options.aesKeyB64 `base64(hex key)`, the encoding the protocol's senders use
 * @param {number} options.fileSize ciphertext length
 * @param {string} [options.fileName] required for files
 * @param {number} [options.rawSize] plaintext length, required for files
 * @returns {{type: number, [k: string]: any}}
 */
export function buildMediaItem(options) {
  const { mediaType, encryptQueryParam, aesKeyB64, fileSize } = options ?? {}
  const type = ITEM_TYPE_FOR_MEDIA[mediaType]
  if (!type) throw new Error(`buildMediaItem: unsupported media_type ${mediaType}`)
  if (typeof encryptQueryParam !== 'string' || !encryptQueryParam) {
    throw new Error('buildMediaItem: an encrypt_query_param is required')
  }

  const media = { encrypt_query_param: encryptQueryParam, aes_key: aesKeyB64, encrypt_type: 1 }

  if (mediaType === UPLOAD_MEDIA_TYPE.IMAGE) {
    return { type, image_item: { media, mid_size: fileSize } }
  }
  if (mediaType === UPLOAD_MEDIA_TYPE.VIDEO) {
    return { type, video_item: { media, video_size: fileSize } }
  }
  if (mediaType === UPLOAD_MEDIA_TYPE.FILE) {
    if (typeof options.fileName !== 'string' || !options.fileName) {
      throw new Error('buildMediaItem: a file_name is required for media_type 3')
    }
    return {
      type,
      file_item: { media, file_name: options.fileName, len: String(options.rawSize ?? 0) },
    }
  }
  // Voice outbound is out of scope: the official client only ever downloads and transcodes voice, and
  // the protocol notes say an independent client must treat sending it as a separate integration.
  throw new Error('buildMediaItem: voice outbound is deliberately not implemented')
}

/**
 * Encrypt one payload and upload it.
 *
 * Never throws: every failure is returned as `{ ok: false, reason }`, because a media send that cannot
 * complete must leave the text reply path working.
 *
 * @param {object} options
 * @param {Buffer} options.bytes plaintext
 * @param {number} options.mediaType
 * @param {string} options.toUserId the peer the message is addressed to
 * @param {(req: Record<string, unknown>) => Promise<any>} options.requestUploadUrl
 * @param {typeof fetch} options.fetchImpl
 * @param {Buffer} [options.aesKey] injectable for tests; random by default
 * @param {string} [options.filekey] injectable for tests; random by default
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: true, item: any, rawSize: number, fileSize: number, rawMd5: string, filekey: string, aesKeyB64: string, encryptQueryParam: string}|{ok: false, reason: string}>}
 */
export async function uploadMedia(options) {
  const { bytes, mediaType, toUserId, requestUploadUrl, fetchImpl } = options ?? {}
  const timeoutMs = options?.timeoutMs ?? UPLOAD_TIMEOUT_MS

  if (!Buffer.isBuffer(bytes)) return { ok: false, reason: 'uploadMedia expects a Buffer' }
  if (!ITEM_TYPE_FOR_MEDIA[mediaType]) return { ok: false, reason: `unsupported media_type ${mediaType}` }
  if (typeof requestUploadUrl !== 'function') return { ok: false, reason: 'no requestUploadUrl implementation' }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no fetch implementation' }

  const aesKey = Buffer.isBuffer(options?.aesKey) ? options.aesKey : randomBytes(AES_KEY_BYTES)
  if (aesKey.length !== AES_KEY_BYTES) return { ok: false, reason: 'the AES key must be 16 bytes' }
  const filekey = typeof options?.filekey === 'string' && options.filekey ? options.filekey : randomBytes(16).toString('hex')

  const rawSize = bytes.length
  const rawMd5 = createHash('md5').update(bytes).digest('hex')
  const ciphertext = encryptAesEcb(bytes, aesKey)
  const fileSize = ciphertext.length

  // The declared size is sent before the bytes are, so a disagreement here is an error only the server
  // would ever see. `paddedLength` is the protocol's own formula; check it rather than trust it.
  if (fileSize !== paddedLength(rawSize)) {
    return { ok: false, reason: `internal: ciphertext is ${fileSize} bytes but paddedLength says ${paddedLength(rawSize)}` }
  }

  let response
  try {
    response = await requestUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: fileSize,
      no_need_thumb: true,
      aeskey: aesKey.toString('hex'),
    })
  } catch (err) {
    return { ok: false, reason: `getuploadurl failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const target = uploadUrlFrom(response)
  if (!target.url) return { ok: false, reason: target.reason }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let upload
  try {
    upload = await fetchImpl(target.url, {
      method: 'POST',
      body: ciphertext,
      headers: { 'content-type': 'application/octet-stream' },
      signal: controller.signal,
    })
  } catch (err) {
    return { ok: false, reason: `upload failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    clearTimeout(timer)
  }

  // E3: HTTP 200 is necessary but NOT sufficient — the parameter that the later sendmessage must
  // reference travels in a header, and a 200 without it is a failure that looks like a success.
  if (!upload || !upload.ok) {
    return { ok: false, reason: `upload HTTP ${upload ? upload.status : 'no response'}` }
  }
  const encryptQueryParam = upload.headers?.get?.('x-encrypted-param') ?? ''
  if (!encryptQueryParam.trim()) {
    return { ok: false, reason: 'upload returned HTTP 200 but no x-encrypted-param header, which E3 calls a failure' }
  }

  const aesKeyB64 = aesKeyToCdnKey(aesKey)
  const item = buildMediaItem({
    mediaType,
    encryptQueryParam: encryptQueryParam.trim(),
    aesKeyB64,
    fileSize,
    fileName: options?.fileName,
    rawSize,
  })

  return {
    ok: true,
    item,
    rawSize,
    fileSize,
    rawMd5,
    filekey,
    aesKeyB64,
    encryptQueryParam: encryptQueryParam.trim(),
  }
}
