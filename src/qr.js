// @ts-check
/**
 * QR-code materialisation for the iLink login flow.
 *
 * Protocol facts (verified):
 *   - `POST /ilink/bot/get_bot_qrcode?bot_type=3` returns
 *       { qrcode, qrcode_img_content }
 *     where `qrcode` is the opaque, short-lived identifier used for status polling and
 *     `qrcode_img_content` is "a url or content to display as a QR code".
 *     Source: https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/docs/protocol.md
 *   - In practice `qrcode_img_content` is usually an HTTPS link such as
 *     `https://liteapp.weixin.qq.com/q/...`, NOT base64 image data. Observed variants
 *     also include `data:image/...;base64,...`, raw `<svg`, and bare base64.
 *     Source: https://raw.githubusercontent.com/SiverKing/weixin-ClawBot-API/main/weixin-openclaw-api-py-docs.md
 *     (pitfall #1), and the legacy example in the same document.
 *
 * There is no bundled QR encoder here on purpose: this plugin may not import third-party
 * packages, and the server already hands us a ready-made image or a scannable link. We
 * persist whatever it gives us next to the state file and report both the local path and
 * the link.
 *
 * Dependency-free: `node:fs/promises`, `node:path`, global `fetch`.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @typedef {object} QrMaterialisation
 * @property {'data-url'|'remote-url'|'svg'|'base64'|'unknown'} kind
 * @property {string|null} savedPath   Local file to open, when we could write one.
 * @property {string|null} link        A URL the user can open on the phone, when known.
 * @property {number} bytes            Size of the written file, 0 when nothing was written.
 * @property {string|null} note        Set when materialisation degraded; safe to show.
 */

/**
 * Turn `qrcode_img_content` into something a human can act on.
 *
 * Failure policy, decided per branch:
 *   - When a scannable `link` exists (the remote-URL branch), a download or disk failure
 *     degrades to link-only, because the user can still complete login that way. A path is
 *     published **only after the write actually succeeded**, so a caller never receives a
 *     path that does not exist.
 *   - When there is no link (data URL, inline SVG, bare base64), a disk failure rejects:
 *     nothing usable would remain, so the caller must see the failure and retry.
 * Never throws for a merely unrecognised payload: that degrades to a `note` describing what
 * arrived, without echoing content that may carry credentials.
 *
 * @param {string} qrcodeImgContent the value from `get_bot_qrcode`
 * @param {object} opts
 * @param {string} opts.dir        directory to write into (usually the store dir)
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<QrMaterialisation>}
 */
export async function materializeQrImage(qrcodeImgContent, opts) {
  const { dir, fetchImpl = fetch, signal } = opts
  const content = typeof qrcodeImgContent === 'string' ? qrcodeImgContent.trim() : ''

  if (!content) {
    return { kind: 'unknown', savedPath: null, link: null, bytes: 0, note: '二维码内容为空' }
  }

  await mkdir(dir, { recursive: true })

  // `data:image/<subtype>;base64,<payload>`
  if (content.startsWith('data:image/')) {
    const comma = content.indexOf(',')
    if (comma === -1) {
      return { kind: 'unknown', savedPath: null, link: null, bytes: 0, note: 'data URL 缺少逗号分隔符' }
    }
    const header = content.slice(0, comma)
    const subtype = /data:image\/([a-zA-Z0-9.+-]+)/.exec(header)?.[1] ?? 'png'
    const payload = content.slice(comma + 1)
    const bytes = decodeBase64(payload)
    if (!bytes) {
      return { kind: 'unknown', savedPath: null, link: null, bytes: 0, note: 'data URL 的 base64 无法解码' }
    }
    const savedPath = join(dir, `qrcode.${extFor(subtype)}`)
    await writeFile(savedPath, bytes)
    return { kind: 'data-url', savedPath, link: null, bytes: bytes.byteLength, note: null }
  }

  // Raw inline SVG.
  if (content.startsWith('<svg') || content.startsWith('<?xml')) {
    const savedPath = join(dir, 'qrcode.svg')
    await writeFile(savedPath, content, 'utf8')
    return {
      kind: 'svg',
      savedPath,
      link: null,
      bytes: Buffer.byteLength(content, 'utf8'),
      note: '服务端返回的是 SVG，用浏览器打开即可',
    }
  }

  // An http(s) link: keep the link for the user, and try to also fetch the image so a
  // local file exists even when the phone cannot open the link directly.
  //
  // `link` is always available in this branch, so every failure here degrades to
  // link-only, and `savedPath` is assigned only once `writeFile` has actually succeeded.
  if (/^https?:\/\//i.test(content)) {
    /** @type {string|null} */
    let savedPath = null
    /** @type {string|null} */
    let note = null
    let bytes = 0
    try {
      const res = await fetchImpl(content, { signal, redirect: 'follow' })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        // Guard against fetching an HTML landing page instead of an image.
        const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
        if (buf.byteLength > 0 && (ctype.startsWith('image/') || looksLikeImage(buf))) {
          const candidate = join(dir, `qrcode.${extFor(subtypeFromContentType(ctype))}`)
          try {
            await writeFile(candidate, buf)
            // Publish the path only now, so it always names a file that exists.
            savedPath = candidate
            bytes = buf.byteLength
          } catch (writeErr) {
            note = `二维码图片写入失败（${errorName(writeErr)}），已保留链接供手机打开`
          }
        } else {
          note = '服务端给的是链接但不是图片，已保留链接供手机打开'
        }
      } else {
        note = `下载二维码图片失败（HTTP ${res.status}），已保留链接供手机打开`
      }
    } catch (err) {
      note = `下载二维码图片失败（${errorName(err)}），已保留链接供手机打开`
    }
    return { kind: 'remote-url', savedPath, link: content, bytes, note }
  }

  // Last resort: the legacy client treated anything else as bare base64.
  //
  // The decoded bytes are checked against known image signatures first. Arbitrary
  // alphanumeric text — an HTML error body, the plain word "notfound" — decodes as valid
  // base64, and without this check it would be written to disk and reported to the user as
  // a saved QR image.
  const bytes = decodeBase64(content)
  if (bytes && looksLikeImage(bytes)) {
    const savedPath = join(dir, 'qrcode.png')
    await writeFile(savedPath, bytes)
    return {
      kind: 'base64',
      savedPath,
      link: null,
      bytes: bytes.byteLength,
      note: '按原始 base64 处理，若打不开请检查服务端返回格式',
    }
  }

  return {
    kind: 'unknown',
    savedPath: null,
    link: null,
    bytes: 0,
    note: '无法识别的二维码内容格式，已丢弃（内容可能含凭据，不写入日志）',
  }
}

/**
 * Ready-to-show instructions. Contains no secrets: the `qrcode` identifier is never
 * included, only the scannable link or a local file path.
 *
 * @param {QrMaterialisation} qr
 * @param {{ stateFilePath?: string, expiresInSeconds?: number }} [opts]
 * @returns {string}
 */
export function describeQrForUser(qr, opts = {}) {
  const lines = ['微信 ClawBot 登录：请用手机微信扫描二维码。']
  if (qr.savedPath) lines.push(`二维码图片已保存：${qr.savedPath}`)
  if (qr.link) lines.push(`二维码链接（可发到「文件传输助手」后在手机上打开）：${qr.link}`)
  if (!qr.savedPath && !qr.link) lines.push('未能取得可用的二维码，请重试登录。')
  if (qr.note) lines.push(`说明：${qr.note}`)
  if (opts.expiresInSeconds) {
    // The client-side QR session TTL is an official client policy, not a server constant.
    lines.push(`请在约 ${Math.round(opts.expiresInSeconds / 60)} 分钟内完成扫码。`)
  }
  lines.push('若手机提示输入数字配对码，请把该数字告诉我，我代为提交。')
  return lines.join('\n')
}

/**
 * @param {string} s
 * @returns {Buffer|null}
 */
function decodeBase64(s) {
  const cleaned = s.replace(/\s+/g, '')
  if (!cleaned || !/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) return null
  try {
    const buf = Buffer.from(cleaned, 'base64')
    return buf.byteLength > 0 ? buf : null
  } catch {
    return null
  }
}

/**
 * Error name for a user-facing diagnostic note. Names only; never a message, because a
 * fetch failure message can echo the URL, which carries the short-lived QR credential.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorName(err) {
  if (err instanceof Error && typeof err.name === 'string' && err.name) return err.name
  return 'error'
}

/** @param {string} subtype */
function extFor(subtype) {
  const s = subtype.toLowerCase()
  if (s === 'jpeg' || s === 'jpg') return 'jpg'
  if (s === 'svg+xml' || s === 'svg') return 'svg'
  if (s === 'webp') return 'webp'
  if (s === 'gif') return 'gif'
  return 'png'
}

/** @param {string} ctype */
function subtypeFromContentType(ctype) {
  const m = /^image\/([a-zA-Z0-9.+-]+)/.exec(ctype)
  return m?.[1] ?? 'png'
}

/** @param {Buffer} buf */
function looksLikeImage(buf) {
  if (buf.byteLength < 4) return false
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true
  // WEBP ("RIFF"...."WEBP")
  if (buf.byteLength >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return true
  }
  return false
}
