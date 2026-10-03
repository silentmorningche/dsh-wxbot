// @ts-check
/**
 * Media cryptography for the iLink protocol.
 *
 * Every media message on this protocol is transported as AES-128-ECB ciphertext with PKCS#7 padding,
 * over a CDN that knows nothing about the contents. The protocol document is explicit that the **key
 * arrives in one of two encodings in the same field**, which is the single most likely place to lose
 * half a user's photos:
 *
 *   - `base64(16-byte raw key)`
 *   - `base64(32-character hex string)` — that is, base64 of the *text* of the key
 *
 * and images add a third: `image_item.aeskey` carries the key as a **bare 32-character hex string**,
 * and takes precedence over `media.aes_key`.
 *
 * So this module's job is to accept any of those three spellings and produce 16 raw bytes — or to
 * report that there is no key at all, which for an image is a legitimate state meaning "the
 * downloaded bytes are already the image".
 *
 * Outbound is a separate concern and lives in `aesKeyToCdnKey`: the senders base64-encode the *hex
 * text*, so encoding is not the inverse spelling of the most permissive decode.
 *
 * Only `node:` builtins are used, and nothing here has side effects, so it is directly unit-testable.
 */

import { createCipheriv, createDecipheriv } from 'node:crypto'

/** AES-128: 16-byte key, 16-byte block. */
export const AES_KEY_BYTES = 16

/** A 32-character hexadecimal string spells a 16-byte key. */
const HEX_KEY = /^[0-9a-fA-F]{32}$/

/**
 * Decode a media key from any of the spellings this protocol actually uses.
 *
 * Tried in order: bare hex, then base64 of a raw key, then base64 of a hex string. Order matters
 * only for a value that is ambiguous, and a 32-character base64 string decodes to 24 bytes, so the
 * three cases are in practice disjoint.
 *
 * @param {unknown} raw the key as it appeared in the message
 * @returns {Buffer|null} 16 raw bytes, or null when the value carries no usable key
 */
export function decodeAesKey(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value.length === 0) return null

  // (a) A bare hex key: `image_item.aeskey`, 32 characters.
  if (HEX_KEY.test(value)) return Buffer.from(value, 'hex')

  // (b) base64 of a raw 16-byte key, or (c) base64 of the 32-character hex string.
  // `Buffer.from(..., 'base64')` never throws: it silently skips characters outside the alphabet, so
  // the decoded length and content are what decide, not the absence of an exception.
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === AES_KEY_BYTES) return decoded
  if (decoded.length > 0) {
    const text = decoded.toString('utf8')
    if (HEX_KEY.test(text)) return Buffer.from(text, 'hex')
  }
  return null
}

/**
 * Encode a 16-byte key the way the protocol's senders do: base64 of the **hex text**.
 *
 * Not the inverse of the most permissive branch of {@link decodeAesKey}, deliberately: the document
 * records that images, video and files all base64 the hex string when sending, and that the wider
 * acceptance on download is a compatibility range rather than a choice of encoding.
 *
 * @param {Buffer} key 16 raw bytes
 * @returns {string}
 */
export function aesKeyToCdnKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    throw new Error(`aesKeyToCdnKey expects a ${AES_KEY_BYTES}-byte key, got ${Buffer.isBuffer(key) ? key.length : typeof key}`)
  }
  return Buffer.from(key.toString('hex'), 'utf8').toString('base64')
}

/**
 * The ciphertext length PKCS#7 padding produces for a given plaintext size.
 *
 * The protocol notes state this directly — `ceil((rawsize + 1) / 16) * 16` — and the upload request
 * needs it as `filesize` **before** the bytes are sent, so it is worth being one tested function
 * rather than an expression written out at the call site.
 *
 * @param {number} rawSize
 * @returns {number}
 */
export function paddedLength(rawSize) {
  const size = Number(rawSize)
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`paddedLength expects a non-negative size, got ${rawSize}`)
  }
  return Math.ceil((size + 1) / AES_KEY_BYTES) * AES_KEY_BYTES
}

/**
 * Encrypt AES-128-ECB + PKCS#7 — the transport form for outbound media.
 *
 * PKCS#7 always appends between 1 and 16 bytes, including when the plaintext is already block-aligned,
 * so the output is always strictly longer than the input. `paddedLength` is the same arithmetic done
 * ahead of time and the two must agree: the upload request declares `filesize`, and a mismatch would be
 * a protocol error the server sees rather than one we can catch locally.
 *
 * @param {Buffer} plaintext
 * @param {Buffer} key 16 raw bytes
 * @returns {Buffer}
 */
export function encryptAesEcb(plaintext, key) {
  if (!Buffer.isBuffer(plaintext)) throw new Error('encryptAesEcb expects a Buffer')
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    throw new Error(`encryptAesEcb expects a ${AES_KEY_BYTES}-byte key`)
  }
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * Decrypt AES-128-ECB + PKCS#7.
 *
 * Falls back to no-unpadding when PKCS#7 removal fails. The protocol says the sender pads, so a
 * failure means the sender did not — and returning the bytes with their trailing block intact is far
 * better than discarding an otherwise perfectly good image. The caller logs which path was taken.
 *
 * @param {Buffer} ciphertext
 * @param {Buffer} key 16 raw bytes
 * @returns {{ plaintext: Buffer, padding: 'pkcs7'|'none', note?: string }}
 */
export function decryptAesEcb(ciphertext, key) {
  if (!Buffer.isBuffer(ciphertext)) throw new Error('decryptAesEcb expects a Buffer')
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    throw new Error(`decryptAesEcb expects a ${AES_KEY_BYTES}-byte key`)
  }
  if (ciphertext.length === 0) return { plaintext: Buffer.alloc(0), padding: 'pkcs7' }
  if (ciphertext.length % AES_KEY_BYTES !== 0) {
    // ECB cannot decrypt a partial block. Decrypting whole blocks and keeping the remainder is a
    // guess the protocol does not sanction, so say so and return nothing.
    return {
      plaintext: Buffer.alloc(0),
      padding: 'none',
      note: `ciphertext length ${ciphertext.length} is not a multiple of ${AES_KEY_BYTES}`,
    }
  }

  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(true)
    return { plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]), padding: 'pkcs7' }
  } catch (err) {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(false)
    return {
      plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      padding: 'none',
      note: `PKCS#7 removal failed (${err instanceof Error ? err.message : String(err)}); kept the padding block`,
    }
  }
}

/**
 * Decrypt a downloaded media payload, given whatever form the key arrived in.
 *
 * This is the function the download path calls: it owns the decision that "no key" means "the bytes
 * are already plaintext" — correct for images, and the same rule the official downloader applies
 * when it skips keyless voice, file and video items, which the caller reports rather than hides.
 *
 * @param {Buffer} ciphertext
 * @param {unknown} rawKey
 * @returns {{ plaintext: Buffer, encrypted: boolean, padding: 'pkcs7'|'none'|null, note?: string }}
 */
export function decryptMediaPayload(ciphertext, rawKey) {
  const key = decodeAesKey(rawKey)
  if (!key) {
    return {
      plaintext: ciphertext,
      encrypted: false,
      padding: null,
      note: typeof rawKey === 'string' && rawKey.length > 0 ? 'key present but not decodable' : 'no key supplied',
    }
  }
  const result = decryptAesEcb(ciphertext, key)
  return { plaintext: result.plaintext, encrypted: true, padding: result.padding, note: result.note }
}
