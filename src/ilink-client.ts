/**
 * ilink-client.ts — 腾讯微信官方 ClawBot（iLink Bot）HTTP 协议独立客户端
 * =============================================================================
 *
 * 目标：不安装 `@tencent-weixin/openclaw-weixin`、不依赖 OpenClaw 宿主，
 *      仅用 Node 内置能力（`node:crypto` / 全局 `fetch` / `AbortController` /
 *      `node:fs/promises`）实现一份可直接集成的 iLink Bot HTTP 客户端。
 *
 * 权威来源（凡是"照抄文档"的字段/端点/超时，注释里都标了来源 URL）：
 *   [P]  官方协议文档（权威）
 *        https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
 *        raw: https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/docs/protocol.md
 *   [T]  官方类型定义（字段名的最终依据）
 *        https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/src/api/types.ts
 *   [A]  官方 HTTP 实现（超时/请求头/错误分类行为）
 *        https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/src/api/api.ts
 *   [L]  官方扫码登录状态机（8 个状态的准确语义）
 *        https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/src/auth/login-qr.ts
 *   [M]  官方长轮询主循环（退避 / -14 / longpolling_timeout_ms）
 *        https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/src/monitor/monitor.ts
 *   [R]  第三方深度协议分析（实测踩坑，含 Python 参考实现）
 *        https://raw.githubusercontent.com/SiverKing/weixin-ClawBot-API/main/weixin-openclaw-api-py-docs.md
 *
 * ── 官方 vs 第三方的分歧记录（一律以官方 [P]/[T]/[A] 为准）────────────────────
 *  D1. `WeixinMessage.message_id` / `SendMessageResp.message_id` / `RefMessage.svr_id`
 *      [P] 的表格写 `number`，但 [T] 明确注释 "uint64 on the wire; parsed losslessly
 *      as a string"，且 [A] 的 `parseWeixinApiJson()` 会把这些字段从 JSON 数字
 *      重写成 JSON 字符串（避免 JS number 精度丢失）。→ 本文件取 **[T]，用 `string`**。
 *  D2. 长轮询客户端超时后的处置：[A] 把客户端超时**伪造成 `{ret:0, msgs:[]}`**
 *      成功响应返回，[M] 于是**不 sleep、立刻重发**下一轮（服务端 hold 35s，
 *      实际不会热循环）。任务要求"普通失败先等 2 秒"，本文件采用**任务策略**：
 *      超时按普通失败计入退避（2s / 连败 3 次后 30s），并显式暴露 `timedOut`
 *      标志而不是伪造 ret=0 —— 语义更干净，也不会在没有服务端 hold 时打成热循环。
 *  D3. 退避语义：[M] 的"连续失败"只统计 **业务错误/网络错误**；每轮成功
 *      （哪怕 msgs 为空）都 `consecutiveFailures = 0`。[R] 的表述相同。
 *      本文件遵循此语义；注意"空 msgs 的成功响应"不算失败。
 *  D4. `typing_ticket` 缓存策略：[R] 说官方"按用户在未来 24 小时内随机安排刷新，
 *      失败后 2s 指数退避最长 1 小时"（见 config-cache.ts），[P] 未描述缓存细节。
 *      本文件实现**最小可用缓存 + TTL**，不实现随机刷新调度。
 *  D5. 生命周期通知 / sendtyping 的业务返回码：[P] 明确说官方 sendTyping 包装器
 *      "does not parse the response body or check its business return code"，
 *      notifyStart/Stop 只告警不阻断。→ 本文件同样**只告警**，但把原始 resp 交给
 *      调用方（`strict:false`），需要严格模式时可自行校验。
 *  D6. `-14` 处置：[M] 是"暂停该账号全部请求 1 小时"；[R] 建议"独立客户端可立即停止
 *      业务请求 + 受控重登"。任务要求受控重登 → 本文件实现 `-14` 回调 +
 *      `relogin()`，并在重登期间硬性拒绝轮询（`staleTokenPaused`），绝不打热循环。
 *
 * ── 第一阶段范围 ─────────────────────────────────────────────────────────────
 *  已实现：扫码登录状态机、长轮询主循环、getconfig/sendtyping、文本 sendmessage、
 *          notifystart/notifystop、-14 受控重登、状态持久化（原子写）。
 *  **未实现：媒体（图片/语音/文件/视频）与外发语音。**
 *
 *  ── 媒体扩展点（留给第二阶段）────────────────────────────────────────────────
 *  协议细节出处：见上文 [P] 的 "CDN media flow" / "Media fields used by the client"
 *  两节，以及 [R] 的 2.9 节。要点（照抄文档，未在本文件实现）：
 *    E1. `POST /ilink/bot/getuploadurl`（[P] "getUploadUrl"；超时 15s）。
 *        请求字段见 `GetUploadUrlReq`：filekey / media_type / to_user_id /
 *        rawsize / rawfilemd5 / filesize / thumb_rawsize / thumb_rawfilemd5 /
 *        thumb_filesize / no_need_thumb / aeskey（+ base_info）。
 *        `media_type`：1 图片 / 2 视频 / 3 文件 / 4 语音（[T] `UploadMediaType`）。
 *        响应优先用 `upload_full_url`；缺失时由 `upload_param` + `filekey` 拼。
 *    E2. 加密：AES-128-ECB + PKCS#7 padding。密文长度 = ceil((rawsize + 1) / 16) * 16
 *        （[R] 2.9.1）。**AES 需要 `node:crypto` 的 `createCipheriv('aes-128-ecb', ...)`**，
 *        本文件只用到 `randomBytes` / `createHash`，未触碰 cipher。
 *    E3. 上传：`POST` 密文到 upload URL，`Content-Type: application/octet-stream`，
 *        HTTP 200 且响应头 `x-encrypted-param` 非空才算成功（[P] "Upload" 节）；
 *        4xx 立即放弃，其他失败最多共 3 次。
 *    E4. 下载：优先 `CDNMedia.full_url`；否则
 *        `<cdn_base_url>/download?encrypted_query_param=<urlencoded>`。
 *        `aes_key` 两种实际编码都要兼容：base64(16 字节裸 key) 或 base64(32 字符 hex)
 *        （[P] "CDN media reference" 末段、[R] 2.9.2）。图片优先用
 *        `image_item.aeskey`（32 位 hex），其次 `image_item.media.aes_key`。
 *    E5. 出站 item 最小形态（[P]/[R]）：type=2 `image_item{media:{encrypt_query_param,
 *        aes_key:base64(32 位 hex key), encrypt_type:1}, mid_size}`；
 *        type=5 `video_item{media, video_size}`；type=4 `file_item{media, file_name,
 *        len:"<明文十进制字符串>"}`。**文字说明与媒体必须分成两个 sendmessage**，
 *        各自独立的 `client_id`。
 *    E6. 语音：`voice_item.encode_type` 枚举 1=pcm 2=adpcm 3=feature 4=speex 5=amr
 *        6=silk 7=mp3 8=ogg-speex（[T]）；常见 SILK，转码需外部能力。
 *        入站媒体官方上限 100 MiB（[R] 2.9.2）。
 *
 * ── 最容易踩的坑（写进代码注释里，见各处 ⚠️）──────────────────────────────────
 *  1) 绝对不要手动设置 `Content-Length`（[R] 2.4.2：Node 24/undici 直接拒绝），
 *     交给 fetch 自动计算。
 *  2) HTTP 200 ≠ 投递成功。三层校验：网络成功 + 2xx + JSON 可解析且
 *     `ret`/`errcode` 为 0 或缺省。早期实现"HTTP 200 就打印已回复"导致
 *     "只有第一条能收到回复"（[R] 踩坑 3）。
 *  3) 回复必须原样带上**当前入站消息**的 `context_token`；`client_id` 每次唯一。
 *  4) GET 的二维码状态轮询**只发公共应用头**，不发 Authorization / AuthorizationType /
 *     X-WECHAT-UIN（[P] "Request headers" 的 Client behavior 段）。
 *  5) `qrcode_img_content` 通常是 **URL**（`https://liteapp.weixin.qq.com/q/...`），
 *     不是 base64 图片（[R] 踩坑 1）。不要无条件 base64 解码写 .png。
 *  6) 服务端 JSON 的 Content-Type 可能是 `application/octet-stream`，必须
 *     手动 `text()` 再 `JSON.parse()`，不要依赖 `res.json()` 的 Content-Type 校验
 *     （[R] 踩坑 2；这一点在 JS 的 `Response.json()` 上同样成立）。
 */

import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

// =============================================================================
// 1. 常量与协议枚举
// =============================================================================

/** [P] "Scope and transport"：默认 API base。 */
export const DEFAULT_API_BASE_URL = "https://ilinkai.weixin.qq.com";
/** [P] "Scope and transport"：默认 CDN base（第一阶段未用到，保留给媒体扩展）。 */
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
/** [L] `FIXED_BASE_URL`：二维码流程固定从该入口开始，即使已登录其它节点。 */
export const FIXED_QR_BASE_URL = "https://ilinkai.weixin.qq.com";
/** [L] `DEFAULT_ILINK_BOT_TYPE`。 */
export const DEFAULT_ILINK_BOT_TYPE = "3";
/** [P] 请求头 `iLink-App-Id`，当前值 `bot`。 */
export const ILINK_APP_ID = "bot";

// 超时（[P] 未给数值；数值全部来自 [A] 的常量与 [R] 2.7.2 的表格，两者一致）
/** [A] `DEFAULT_LONG_POLL_TIMEOUT_MS`：getupdates 长轮询，服务端建议 35s。 */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** [A] `DEFAULT_API_TIMEOUT_MS`：sendmessage / getuploadurl。 */
export const DEFAULT_API_TIMEOUT_MS = 15_000;
/** [A] `DEFAULT_CONFIG_TIMEOUT_MS`：getconfig / sendtyping / 生命周期通知。 */
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
/** [L] `QR_LONG_POLL_TIMEOUT_MS`：单次二维码状态轮询。 */
export const QR_LONG_POLL_TIMEOUT_MS = 35_000;
/** [L] `ACTIVE_LOGIN_TTL_MS`：二维码会话本地 TTL。 */
export const QR_SESSION_TTL_MS = 5 * 60_000;
/** [L] `MAX_QR_REFRESH_COUNT`：expired / verify_code_blocked 的重刷上限。 */
export const MAX_QR_REFRESH_COUNT = 3;

// 退避（[M] 常量 + [R] 2.7.4 表述一致）
/** 普通失败后的等待。 */
export const RETRY_DELAY_MS = 2_000;
/** 连续失败达上限后的等待。 */
export const BACKOFF_DELAY_MS = 30_000;
/** 连续失败计数上限。 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** [A]/[M] `STALE_TOKEN_ERRCODE`：bot token 已失效（不是瞬时网络错误）。 */
export const STALE_TOKEN_ERRCODE = -14;

/** [T] `MessageType`。 */
export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

/** [T] `MessageState`。 */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

/** [T] `MessageItemType`；[R] 5.4 的枚举表与之一致。 */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

/** [T] `UploadMediaType`（第一阶段未实现，仅类型完整性）。 */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

/** [T] `TypingStatus`。 */
export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

// =============================================================================
// 2. 协议类型定义（忠实照抄 [T] `src/api/types.ts`）
// =============================================================================

/** [T] `BaseInfo`：每个业务 POST 请求体都要带。 */
export interface BaseInfo {
  channel_version?: string;
  /**
   * [T]/[P]：自我声明的 bot 身份，类比 HTTP User-Agent；**仅用于日志/监控聚合，
   * 不参与鉴权或路由**。格式：空格分隔的 `Name/Version` token，可跟 `(comment)`；
   * 仅 ASCII，净化后总长 ≤ 256 字节；非法 token 丢弃，全空则回退 `OpenClaw`。
   */
  bot_agent?: string;
}

/** [T] `TextItem`。 */
export interface TextItem {
  text?: string;
}

/** [T] `CDNMedia`；`aes_key` 在 JSON 里是 base64 字符串。第一阶段只读不用。 */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 加密类型：0=只加密 fileid，1=打包缩略图/中图等信息。 */
  encrypt_type?: number;
  /** 服务端直接给出的完整下载 URL，优先于客户端拼接。 */
  full_url?: string;
}

/** [T] `ImageItem`（第一阶段仅类型，见文件头 E1–E5）。 */
export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  /** 原始 AES-128 key 的 hex（16 字节）；入站解密时优先于 `media.aes_key`。 */
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

/** [T] `VoiceItem`。 */
export interface VoiceItem {
  media?: CDNMedia;
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex。 */
  encode_type?: number;
  bits_per_sample?: number;
  /** 采样率 (Hz)。 */
  sample_rate?: number;
  /** 语音长度 (毫秒)。 */
  playtime?: number;
  /** 语音转文字内容。 */
  text?: string;
}

/** [T] `FileItem`；注意 `len` 是**十进制字符串**（明文字节数）。 */
export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

/** [T] `VideoItem`。 */
export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

/** [T] `ToolCallStartItem`（[R] 2.8：agent 工具进度，普通聊天可忽略）。 */
export interface ToolCallStartItem {
  tool_name?: string;
  tool_call_id?: string;
}

/** [T] `ToolCallResultItem`。 */
export interface ToolCallResultItem {
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
}

/** [T] `PartialText`：引用消息中被选中的子串元信息。 */
export interface PartialText {
  start: string;
  end: string;
  startindex: number;
  endindex: number;
  quotemd5: string;
}

/** [T] `RefMessage`：引用消息。 */
export interface RefMessage {
  message_item?: MessageItem;
  /** 摘要。 */
  title?: string;
  /** 新版客户端省略引用正文时使用的服务端消息 ID。 */
  svr_id?: string;
  partial_text?: PartialText;
}

/**
 * [T] `MessageItem`：`type` 决定哪个容器字段有值。
 * ⚠️ 解析入站 item_list 时**必须按 type 分派**，未知 type 跳过或记录，
 *    不能默认去读 `text_item.text`（[R] 2.8 明确警告）。
 */
export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  tool_call_start_item?: ToolCallStartItem;
  tool_call_result_item?: ToolCallResultItem;
}

/**
 * [T] `WeixinMessage`：入站与出站共用的消息信封。
 * ⚠️ D1：`message_id` 在线上是 uint64；[T] 注释 "parsed losslessly as a string"，
 *    [P] 表格虽写 number，本文件以 [T] 为准用 `string`。持久化/日志时不要做算术。
 * ⚠️ 解析器必须容忍未知字段与缺省可选字段（[R] 5.1），不要严格反序列化。
 */
export interface WeixinMessage {
  seq?: number;
  /** uint64 on the wire; parsed losslessly as a string. */
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  /** ⚠️ [R] 2.8：出现 `group_id` 不代表官方支持群聊发送，识别到应单独记录/拒绝。 */
  group_id?: string;
  /** [T] `MessageType`：0=NONE 1=USER 2=BOT。 */
  message_type?: number;
  /** [T] `MessageState`：0=NEW 1=GENERATING 2=FINISH。 */
  message_state?: number;
  item_list?: MessageItem[];
  /** 回复上下文；**必须**按"账号 + 用户"隔离持久化。 */
  context_token?: string;
  run_id?: string;
}

/** [T] `GetUpdatesReq`。 */
export interface GetUpdatesReq {
  /** @deprecated 仅为兼容保留，官方请求构造器已不再发送。 */
  sync_buf?: string;
  /** 本地缓存的完整游标；首次或重置后发 ""。 */
  get_updates_buf?: string;
}

/** [T] `GetUpdatesResp`。 */
export interface GetUpdatesResp {
  ret?: number;
  /** 服务端业务错误码；**-14 = bot token 已失效**。 */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** @deprecated 兼容字段；[P] 明确 monitor **不使用**它作为回退。 */
  sync_buf?: string;
  /** 下次请求原样回传的游标；**仅在本次成功且非空时**才覆盖本地。 */
  get_updates_buf?: string;
  /** 服务端建议的下一次长轮询客户端超时（ms）；正数才采用。 */
  longpolling_timeout_ms?: number;
}

/** [T] `GetUploadUrlReq`（第一阶段不实现，见文件头 E1）。 */
export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

/** [T] `GetUploadUrlResp`。 */
export interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

/** [T] `SendMessageReq`：包一条消息。 */
export interface SendMessageReq {
  msg?: WeixinMessage;
}

/** [T] `SendMessageResp`。 */
export interface SendMessageResp {
  /** uint64 on the wire; parsed losslessly as a string. */
  message_id?: string;
  ret?: number;
  errmsg?: string;
}

/** [T] `SendTypingReq`。 */
export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  /** 1=typing（默认），2=取消 typing。 */
  status?: number;
}

/** [T] `SendTypingResp`。 */
export interface SendTypingResp {
  ret?: number;
  errmsg?: string;
}

/** [T] `GetConfigResp`：含 base64 的 `typing_ticket`。 */
export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

/** [T] `NotifyStartReq` / [T] `NotifyStopReq`（结构相同）。 */
export interface NotifyStartReq {
  base_info?: BaseInfo;
}
export interface NotifyStopReq {
  base_info?: BaseInfo;
}

/** [T] `NotifyStartResp` / [T] `NotifyStopResp`（结构相同）。 */
export interface NotifyStartResp {
  ret?: number;
  errmsg?: string;
}
export interface NotifyStopResp {
  ret?: number;
  errmsg?: string;
}

// ---- 扫码登录相关类型（[P] "QR-code login" / [L] `StatusResponse`）----------

/** [L] `QRCodeResponse`。⚠️ `qrcode_img_content` 通常是 URL，不是 base64 图片。 */
export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

/**
 * [P] 表格 + [L] `StatusResponse`：客户端需要处理的 8 个状态。
 *  - `wait`               等待扫码或状态变化
 *  - `scaned`             已扫码，手机端继续验证
 *  - `confirmed`          登录成功，可保存凭据
 *  - `expired`            二维码过期，可刷新
 *  - `need_verifycode`    需要用户输入手机端显示的数字配对码
 *  - `verify_code_blocked` 配对码错误次数过多，需刷新或终止
 *  - `scaned_but_redirect` 后续状态轮询改到 `redirect_host`
 *  - `binded_redirect`    该 bot 已绑定到本实例
 */
export type QRStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "need_verifycode"
  | "verify_code_blocked"
  | "scaned_but_redirect"
  | "binded_redirect";

/** [L] `StatusResponse`。 */
export interface QRStatusResponse {
  status: QRStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** 扫码者（用户）ID。 */
  ilink_user_id?: string;
  /** `scaned_but_redirect` 时给出的新轮询主机（不含 scheme）。 */
  redirect_host?: string;
}

// ---- 网络错误分类（[A] `classifyFetchError` / [R] 2.7.4）-------------------

export type NetworkErrorType = "dns" | "tcp" | "tls" | "timeout" | "unknown";

export interface ClassifiedNetworkError {
  type: NetworkErrorType;
  description: string;
  code?: string;
}

// ---- 持久化状态 -------------------------------------------------------------

/** 按账号持久化的账号信息（[R] 2.7.5）。 */
export interface PersistedAccount {
  /** ⚠️ 敏感：绝不要写日志。 */
  bot_token: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  updated_at_ms: number;
}

/** 按账号持久化的长轮询游标（[R] 2.7.5）。 */
export interface PersistedSyncBuf {
  get_updates_buf: string;
  updated_at_ms: number;
}

/** 按"账号 + 用户"持久化的会话上下文（[R] 2.7.5）。 */
export interface PersistedConversation {
  context_token: string;
  updated_at_ms: number;
}

// =============================================================================
// 3. 依赖注入选项
// =============================================================================

/** 一次 HTTP 调用的诊断记录（供日志/指标使用）。 */
export interface RequestTrace {
  label: string;
  method: "GET" | "POST";
  /** 已剥离 query 的 URL（query 里可能含 qrcode / 签名）。 */
  redactedUrl: string;
  status?: number;
  ret?: number;
  errcode?: number;
  errmsg?: string;
  durationMs: number;
  networkError?: ClassifiedNetworkError;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ILinkClientOptions {
  /** 状态目录；账号/游标/会话上下文都保存在这里。必填（任务要求由构造参数传入）。 */
  stateDir: string;
  /** 业务 API base；登录后会被 `confirmed` 返回的 `baseurl` 覆盖。 */
  baseUrl?: string;
  /** CDN base（第一阶段未使用，保留给媒体扩展）。 */
  cdnBaseUrl?: string;
  /** `base_info.channel_version`，默认 "2.4.8"（[P] 的示例版本）。 */
  channelVersion?: string;
  /**
   * `base_info.bot_agent`。默认 "OpenClaw"（[T] `DEFAULT_BOT_AGENT`）。
   * 会被 `sanitizeBotAgent()` 按官方 grammar 净化。
   */
  botAgent?: string;
  /** 可选 `SKRouteTag` 路由/调试头（[P] 标注为部署配置，普通客户端不应伪造）。 */
  routeTag?: string;
  /** 覆盖各请求超时。 */
  timeouts?: {
    longPollMs?: number;
    apiMs?: number;
    configMs?: number;
    qrPollMs?: number;
  };
  /** 退避参数覆盖（默认 2s / 30s / 3 次）。 */
  backoff?: {
    retryDelayMs?: number;
    backoffDelayMs?: number;
    maxConsecutiveFailures?: number;
  };
  /** 日志回调；默认静默。所有输出均已脱敏。 */
  log?: (level: LogLevel, message: string) => void;
  /** 每次请求后的诊断回调。 */
  onTrace?: (trace: RequestTrace) => void;
  /**
   * 收到 `ret`/`errcode` = -14（bot token 失效）时触发。
   * 用于通知上层"需要重新扫码"。客户端自身也会进入拒绝轮询状态。
   */
  onStaleToken?: (info: { accountId: string; message: string }) => void;
}

// =============================================================================
// 4. 工具函数：脱敏
// =============================================================================

/** [R] 2.7.1 / [A] `redactToken`：只保留前若干字符 + 总长度。 */
export function redactToken(value: string | undefined, prefixLen = 6): string {
  if (!value) return "(none)";
  if (value.length <= prefixLen) return `****(len=${value.length})`;
  return `${value.slice(0, prefixLen)}…(len=${value.length})`;
}

/** 日志中必须脱敏的字段名（[R] 2.7.1 的清单 + qrcode / aeskey）。 */
const SENSITIVE_KEYS = [
  "bot_token",
  "token",
  "authorization",
  "context_token",
  "typing_ticket",
  "qrcode",
  "qrcode_img_content",
  "verify_code",
  "aeskey",
  "aes_key",
  "upload_param",
  "thumb_upload_param",
  "encrypt_query_param",
  "password",
  "secret",
];

const SENSITIVE_KEY_RE = new RegExp(
  `"(${SENSITIVE_KEYS.join("|")})"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`,
  "gi",
);

/**
 * 脱敏 JSON 文本：命中敏感 key 的值替换为 `<redacted>`，同时把疑似凭据的
 * 长串（≥32 字符的 base64/hex 连续串）一并折叠。
 * ⚠️ 这是**双保险**，代码里还会尽量避免把敏感值拼进日志。
 */
export function redactBody(body: string | undefined, maxLen = 300): string {
  if (!body) return "(empty)";
  let out = body.replace(SENSITIVE_KEY_RE, (_m, key: string) => `"${key}":"<redacted>"`);
  // 兜底：折叠长度 ≥ 32 的 base64/hex 连续串（token/ticket 的典型形态）。
  out = out.replace(/[A-Za-z0-9+/=_-]{32,}/g, (m) => `<redacted:${m.length}>`);
  if (out.length <= maxLen) return out;
  return `${out.slice(0, maxLen)}…(truncated,totalLen=${out.length})`;
}

/** 剥离 query（可能含 qrcode / 签名），只留 origin + pathname。 */
export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return u.search ? `${u.origin}${u.pathname}?<redacted>` : `${u.origin}${u.pathname}`;
  } catch {
    return `<unparsable-url:${rawUrl.length}>`;
  }
}

// =============================================================================
// 5. 工具函数：网络错误分类 & 请求头 & bot_agent 净化
// =============================================================================

/**
 * [A] `classifyFetchError` 的等价实现（[R] 2.7.4 的分类表）。
 * 只覆盖 fetch 级错误，不覆盖 HTTP 4xx/5xx。
 */
export function classifyFetchError(err: unknown): ClassifiedNetworkError {
  if (err instanceof Error && err.name === "AbortError") {
    return { type: "timeout", description: "request timeout" };
  }
  const e = err as { code?: string; cause?: unknown; message?: string };
  const cause = e?.cause as { code?: string } | undefined;
  const causeCode = cause?.code ?? "";
  const ownCode = typeof e?.code === "string" ? e.code : "";
  const matchedCode = causeCode || ownCode;
  const blob = `${String(cause ?? "")} ${causeCode} ${ownCode} ${e?.message ?? String(err ?? "")}`;

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(blob)) {
    return {
      type: "dns",
      description: "DNS resolution failed, check DNS configuration",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/ECONNREFUSED/i.test(blob)) {
    return {
      type: "tcp",
      description: "TCP connection refused",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(blob)) {
    return {
      type: "tcp",
      description: "TCP connection timeout or unreachable",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(blob)) {
    return {
      type: "tls",
      description: "TLS handshake error",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  return { type: "unknown", description: "network request failed" };
}

/** [A] `randomWechatUin()`：随机 uint32 → 十进制字符串 → base64。每次 POST 重新生成。 */
export function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/**
 * [A] `buildClientVersion()`：`(major << 16) | (minor << 8) | patch`。
 * [P] 写作 `0x00MMNNPP`，[R] 给出 2.4.6 → `132102`（本文件默认值即来自此）。
 */
export function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] : 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** [T]/[P] `bot_agent` 长度上限。 */
export const BOT_AGENT_MAX_LEN = 256;
const DEFAULT_BOT_AGENT = "OpenClaw";

/**
 * [A] `sanitizeBotAgent()`：把用户提供的 `botAgent` 按官方 UA-style grammar 净化。
 * grammar：`product *( SP product )`，`product = name "/" version [ SP "(" comment ")" ]`。
 * 非法 token 静默丢弃；结果为空或超限则回退/截断。
 */
export function sanitizeBotAgent(raw: string | undefined): string {
  if (!raw || typeof raw !== "string") return DEFAULT_BOT_AGENT;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BOT_AGENT;

  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/;

  // 先按空白切分，再把以 "(" 开头的多词注释重新粘回前一个 product。
  const rawTokens = trimmed.split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i];
    if (tok.startsWith("(") && !tok.endsWith(")")) {
      let acc = tok;
      while (i + 1 < rawTokens.length && !acc.endsWith(")")) {
        i += 1;
        acc += ` ${rawTokens[i]}`;
      }
      tokens.push(acc);
    } else {
      tokens.push(tok);
    }
  }

  const accepted: string[] = [];
  let pendingProduct: string | null = null;
  for (const tok of tokens) {
    if (tok.startsWith("(") && tok.endsWith(")")) {
      const inner = tok.slice(1, -1);
      if (pendingProduct && commentCharRe.test(inner)) {
        accepted.push(`${pendingProduct} (${inner})`);
        pendingProduct = null;
      } else {
        if (pendingProduct) {
          accepted.push(pendingProduct);
          pendingProduct = null;
        }
      }
      continue;
    }
    if (pendingProduct) {
      accepted.push(pendingProduct);
      pendingProduct = null;
    }
    if (productRe.test(tok)) pendingProduct = tok;
  }
  if (pendingProduct) accepted.push(pendingProduct);

  if (accepted.length === 0) return DEFAULT_BOT_AGENT;

  const joined = accepted.join(" ");
  if (Buffer.byteLength(joined, "utf-8") <= BOT_AGENT_MAX_LEN) return joined;

  const truncated: string[] = [];
  let len = 0;
  for (const t of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(t, "utf-8");
    if (len + add > BOT_AGENT_MAX_LEN) break;
    truncated.push(t);
    len += add;
  }
  return truncated.length > 0 ? truncated.join(" ") : DEFAULT_BOT_AGENT;
}

// =============================================================================
// 6. 错误类型
// =============================================================================

/** 三层校验里"网络层"失败的封装。 */
export class ILinkNetworkError extends Error {
  readonly classified: ClassifiedNetworkError;
  readonly label: string;
  readonly timedOut: boolean;
  constructor(label: string, err: unknown) {
    const classified = classifyFetchError(err);
    super(
      `${label}: network error type=${classified.type} description=${classified.description}` +
        (classified.code ? ` code=${classified.code}` : ""),
    );
    this.name = "ILinkNetworkError";
    this.label = label;
    this.classified = classified;
    this.timedOut = classified.type === "timeout";
  }
}

/** 三层校验里"HTTP 层"失败的封装。 */
export class ILinkHttpError extends Error {
  readonly label: string;
  readonly status: number;
  constructor(label: string, status: number, bodySnippet: string) {
    super(`${label}: HTTP ${status} body=${bodySnippet}`);
    this.name = "ILinkHttpError";
    this.label = label;
    this.status = status;
  }
}

/** 三层校验里"业务层"失败的封装（`ret`/`errcode` 非 0）。 */
export class ILinkBusinessError extends Error {
  readonly label: string;
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  constructor(label: string, ret: number | undefined, errcode: number | undefined, errmsg?: string) {
    super(`${label}: ret=${ret ?? "-"} errcode=${errcode ?? "-"} errmsg=${errmsg ?? "(none)"}`);
    this.name = "ILinkBusinessError";
    this.label = label;
    this.ret = ret;
    this.errcode = errcode;
    this.errmsg = errmsg;
  }
  /** [A]/[M]：-14 表示 bot token 已失效，不是瞬时网络错误。 */
  get isStaleToken(): boolean {
    return this.ret === STALE_TOKEN_ERRCODE || this.errcode === STALE_TOKEN_ERRCODE;
  }
}

/** JSON 解析失败（[R] 2.7.1 第二层；服务端可能返回 octet-stream）。 */
export class ILinkParseError extends Error {
  constructor(label: string, snippet: string) {
    super(`${label}: response is not valid JSON body=${snippet}`);
    this.name = "ILinkParseError";
  }
}

/** 登录/账号状态错误。 */
export class ILinkAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ILinkAuthError";
    this.code = code;
  }
}

// =============================================================================
// 7. 内部工具
// =============================================================================

/** 可被外部 abort 打断的 sleep（[M] `sleep`）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** URL encode helper（二维码 qrcode / verify_code 都要编码）。 */
function enc(v: string): string {
  return encodeURIComponent(v);
}

/** 文件名安全化的账号 ID（[T] 里账号形如 `xxx@im.bot`，不能直接当文件名）。 */
export function safeAccountFileName(accountId: string): string {
  return accountId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * 把 JSON 文本里的 uint64 ID 字段等价地包成字符串（[A] `parseWeixinApiJson`）。
 * ⚠️ D1：`message_id` 等字段线上是 uint64；JS `JSON.parse` 会丢精度，
 *    因此在 parse 前把它们从裸数字改写成字符串。
 * 该扫描器只改写真正的对象属性名，不会碰到字符串**内部**的同名文本。
 */
export function parseWeixinApiJson<T>(rawText: string): T {
  const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }
    const stringStart = index;
    index += 1;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? "")) cursor += 1;
    if (rawText[cursor] !== ":") continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor += 1;
    while (/\s/.test(rawText[cursor] ?? "")) {
      output += rawText[cursor++];
    }
    const numberStart = cursor;
    if (rawText[cursor] === "-") cursor += 1;
    while (/\d/.test(rawText[cursor] ?? "")) cursor += 1;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === "-")) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as T;
}

/** 从 item_list 里尽力抽出纯文本（多 item 用换行拼接）。 */
export function extractTextFromMessage(msg: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    switch (item.type) {
      case MessageItemType.TEXT:
        if (item.text_item?.text) parts.push(item.text_item.text);
        break;
      case MessageItemType.VOICE:
        // [T]/[P]：voice_item.text 是语音转写文本，可直接用。
        if (item.voice_item?.text) parts.push(item.voice_item.text);
        break;
      default:
        // ⚠️ 图片/文件/视频/工具进度等：第一阶段不处理，交由调用方按 type 分派。
        break;
    }
  }
  return parts.join("\n");
}

/** 生成唯一 client_id（[R] 2.6.4：`openclaw-weixin-<唯一 ID>`，每次发送都新生成）。 */
function newClientId(): string {
  return `ilink-client-${randomBytes(8).toString("hex")}`;
}

/** 计算分页安全的掩码（用于调试：确认拿到的是同一条 context_token 而不泄露内容）。 */
export function tokenFingerprint(value: string | undefined): string {
  if (!value) return "(none)";
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// =============================================================================
// 8. ILinkClient
// =============================================================================

/** 长轮询一次的结果（把"客户端超时"与"服务端成功空响应"显式区分开；见 D2）。 */
export type PollOutcome =
  | { kind: "messages"; msgs: WeixinMessage[]; timeoutMs: number }
  | { kind: "empty"; timeoutMs: number }
  /** 客户端超时：属长轮询正常控制流，游标保留，但要计入退避（D2）。 */
  | { kind: "timeout"; timeoutMs: number }
  /** 非 -14 的业务错误。 */
  | { kind: "error"; ret?: number; errcode?: number; errmsg?: string }
  /** -14：token 失效，循环必须退出而不是重试。 */
  | { kind: "stale_token"; message: string };

/** 轮询循环的运行句柄。 */
export interface PollLoopHandle {
  /** 请求停止；返回的 Promise 在循环真正退出后 resolve。 */
  stop(): Promise<void>;
  /** 循环自然结束/异常结束的时间点 Promise。 */
  done: Promise<void>;
}

/** 扫码登录会话（由 `startQrLogin` 返回，交给 `waitForLogin` 驱动）。 */
export interface QrLoginSession {
  /** ⚠️ 敏感：不要写日志。 */
  qrcode: string;
  /** 通常是 URL（`https://liteapp.weixin.qq.com/...`），也可能是 svg / data URI。 */
  qrcodeImgContent: string;
  startedAt: number;
  /** 当前生效的轮询 base（`scaned_but_redirect` 会改写它）。 */
  currentBaseUrl: string;
  /** 待提交的配对码；用户输入后暂存，下次轮询携带。 */
  pendingVerifyCode?: string;
  /** 已刷新次数（从 1 起算，最多 MAX_QR_REFRESH_COUNT）。 */
  refreshCount: number;
}

/** `waitForLogin` 的结果。 */
export interface QrLoginResult {
  /** 是否拿到了可用凭据（`confirmed`，或 `binded_redirect` 且本地确有有效 token）。 */
  connected: boolean;
  /** `binded_redirect` 且未重新签发凭据：语义上"早就绑好了"。 */
  alreadyConnected?: boolean;
  account?: PersistedAccount;
  message: string;
  /** 结束时（含失败）的最新状态，便于上层展示。 */
  lastStatus?: QRStatus;
}

export class ILinkClient {
  readonly stateDir: string;
  private readonly opts: Required<
    Pick<ILinkClientOptions, "stateDir" | "channelVersion" | "botAgent">
  > &
    ILinkClientOptions;

  private baseUrl: string;
  private readonly cdnBaseUrl: string;
  private readonly routeTag?: string;
  private readonly timeouts: {
    longPollMs: number;
    apiMs: number;
    configMs: number;
    qrPollMs: number;
  };
  private readonly backoff: {
    retryDelayMs: number;
    backoffDelayMs: number;
    maxConsecutiveFailures: number;
  };

  private readonly logFn: (level: LogLevel, message: string) => void;
  private readonly onTrace?: (trace: RequestTrace) => void;
  private readonly onStaleToken?: ILinkClientOptions["onStaleToken"];

  // ---- 账号 / 凭据（内存态，可持久化）----
  private account: PersistedAccount | null = null;

  // ---- 按账号 + 用户的内存缓存（[R] 2.6.2：切 token/账号后必须清空）----
  private readonly typingTicketCache = new Map<string, string>();
  private readonly contextTokenCache = new Map<string, string>();

  // ---- 长轮询 ----
  private getUpdatesBuf = "";
  private nextLongPollTimeoutMs: number;
  private loopAbort: AbortController | null = null;
  private loopRunning = false;

  /**
   * [M]/[R] -14 之后禁止紧密轮询：置位期间 `pollOnce`/`runPollLoop` 直接拒绝。
   * 由 `relogin()` 成功或 `setAccount()` 显式清除。
   */
  private staleTokenPaused = false;

  constructor(options: ILinkClientOptions) {
    if (!options?.stateDir) throw new Error("ILinkClient: stateDir is required");
    this.opts = {
      ...options,
      channelVersion: options.channelVersion ?? "2.4.8",
      botAgent: sanitizeBotAgent(options.botAgent),
    };
    this.stateDir = options.stateDir;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.cdnBaseUrl = (options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL).replace(/\/+$/, "");
    this.routeTag = options.routeTag;
    this.timeouts = {
      longPollMs: options.timeouts?.longPollMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
      apiMs: options.timeouts?.apiMs ?? DEFAULT_API_TIMEOUT_MS,
      configMs: options.timeouts?.configMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
      qrPollMs: options.timeouts?.qrPollMs ?? QR_LONG_POLL_TIMEOUT_MS,
    };
    this.backoff = {
      retryDelayMs: options.backoff?.retryDelayMs ?? RETRY_DELAY_MS,
      backoffDelayMs: options.backoff?.backoffDelayMs ?? BACKOFF_DELAY_MS,
      maxConsecutiveFailures:
        options.backoff?.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES,
    };
    this.nextLongPollTimeoutMs = this.timeouts.longPollMs;
    this.logFn = options.log ?? (() => {});
    this.onTrace = options.onTrace;
    this.onStaleToken = options.onStaleToken;
  }

  // ---------------------------------------------------------------------------
  // 8.1 日志
  // ---------------------------------------------------------------------------

  private log(level: LogLevel, message: string): void {
    try {
      this.logFn(level, message);
    } catch {
      // 日志回调本身抛错不能影响协议流程。
    }
  }

  // ---------------------------------------------------------------------------
  // 8.2 请求头
  // ---------------------------------------------------------------------------

  /** [A] `buildCommonHeaders()`：GET 与 POST 共用的公共应用头。 */
  private buildCommonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(buildClientVersion(this.opts.channelVersion)),
    };
    if (this.routeTag) headers.SKRouteTag = this.routeTag;
    return headers;
  }

  /**
   * [A] `buildHeaders()`：业务 POST 的请求头。
   * ⚠️ 绝不设置 `Content-Length`（[R] 2.4.2：Node 24/undici 拒绝调用方预设该字段）。
   * ⚠️ `X-WECHAT-UIN` 每次 POST 重新生成。
   */
  private buildPostHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      ...this.buildCommonHeaders(),
    };
    const t = token ?? this.account?.bot_token;
    if (t?.trim()) headers.Authorization = `Bearer ${t.trim()}`;
    this.log(
      "debug",
      `requestHeaders ${JSON.stringify({
        ...headers,
        Authorization: headers.Authorization ? "Bearer <redacted>" : undefined,
        "X-WECHAT-UIN": "<redacted>",
      })}`,
    );
    return headers;
  }

  /** [P]：二维码状态轮询**只发公共应用头**。 */
  private buildGetHeaders(): Record<string, string> {
    return this.buildCommonHeaders();
  }

  /** [T]/[A] `buildBaseInfo()`：每个业务 POST body 都带。 */
  private buildBaseInfo(): BaseInfo {
    return {
      channel_version: this.opts.channelVersion,
      bot_agent: this.opts.botAgent,
    };
  }

  // ---------------------------------------------------------------------------
  // 8.3 传输层：三层校验的第 1、2 层
  // ---------------------------------------------------------------------------

  /**
   * JSON POST（[A] `apiPostFetch` 等价实现）。
   * - 超时用 `AbortController`；同时把外部 `externalSignal` 合并进来（优雅停止）。
   * - 手动 `text()` + `parseWeixinApiJson()`，**不依赖** res.json() 的 Content-Type
   *   校验（[R] 踩坑 2：服务端可能返回 application/octet-stream）。
   * - 抛 `ILinkNetworkError` / `ILinkHttpError` / `ILinkParseError`。
   */
  private async postJson<T>(params: {
    baseUrl?: string;
    endpoint: string;
    body: unknown;
    token?: string;
    timeoutMs: number;
    label: string;
    externalSignal?: AbortSignal;
    traceUrl: string;
  }): Promise<T> {
    const base = `${(params.baseUrl ?? this.baseUrl).replace(/\/+$/, "")}/`;
    const url = new URL(params.endpoint, base);
    const bodyText = JSON.stringify(params.body);
    const headers = this.buildPostHeaders(params.token);

    // 注意：body 已脱敏后打印；绝不打印原始 body。
    this.log(
      "debug",
      `POST ${redactUrl(url.toString())} body=${redactBody(bodyText)} timeoutMs=${params.timeoutMs}`,
    );

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    const external = params.externalSignal;
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: bodyText,
        signal: controller.signal,
      });
      const rawText = await res.text();
      const durationMs = Date.now() - started;
      this.log(
        "debug",
        `${params.label} status=${res.status} raw=${redactBody(rawText)} durationMs=${durationMs}`,
      );

      if (!res.ok) {
        this.emitTrace({
          label: params.label,
          method: "POST",
          redactedUrl: params.traceUrl,
          status: res.status,
          durationMs,
        });
        throw new ILinkHttpError(params.label, res.status, redactBody(rawText, 200));
      }

      let parsed: T;
      try {
        parsed = parseWeixinApiJson<T>(rawText);
      } catch {
        this.emitTrace({
          label: params.label,
          method: "POST",
          redactedUrl: params.traceUrl,
          status: res.status,
          durationMs,
        });
        throw new ILinkParseError(params.label, redactBody(rawText, 200));
      }

      const biz = parsed as { ret?: number; errcode?: number; errmsg?: string };
      this.emitTrace({
        label: params.label,
        method: "POST",
        redactedUrl: params.traceUrl,
        status: res.status,
        ret: biz?.ret,
        errcode: biz?.errcode,
        errmsg: biz?.errmsg,
        durationMs,
      });
      return parsed;
    } catch (err) {
      if (
        err instanceof ILinkHttpError ||
        err instanceof ILinkParseError ||
        err instanceof ILinkBusinessError
      ) {
        throw err;
      }
      // 请求被外部 abort（优雅停止）：仍按网络层错误处理，但语义上是取消。
      if (external?.aborted) {
        const cancelled = new ILinkNetworkError(params.label, err);
        this.log("debug", `${params.label}: cancelled by external abort signal`);
        throw cancelled;
      }
      const netErr = new ILinkNetworkError(params.label, err);
      this.emitTrace({
        label: params.label,
        method: "POST",
        redactedUrl: params.traceUrl,
        durationMs: Date.now() - started,
        networkError: netErr.classified,
      });
      this.log(
        "error",
        `${params.label} failed url=${params.traceUrl} timeoutMs=${params.timeoutMs} ` +
          `type=${netErr.classified.type} description=${netErr.classified.description}` +
          (netErr.classified.code ? ` code=${netErr.classified.code}` : ""),
      );
      throw netErr;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * JSON GET（[A] `apiGetFetch` 等价实现）。
   * ⚠️ 仅公共应用头：不发 AuthorizationType / Authorization / X-WECHAT-UIN（[P]）。
   */
  private async getJson<T>(params: {
    baseUrl?: string;
    endpoint: string;
    timeoutMs: number;
    label: string;
    traceUrl: string;
  }): Promise<T> {
    const base = `${(params.baseUrl ?? this.baseUrl).replace(/\/+$/, "")}/`;
    const url = new URL(params.endpoint, base);
    const headers = this.buildGetHeaders();
    this.log(
      "debug",
      `GET ${redactUrl(url.toString())} timeoutMs=${params.timeoutMs} headers=${JSON.stringify(headers)}`,
    );

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const rawText = await res.text();
      const durationMs = Date.now() - started;
      this.log(
        "debug",
        `${params.label} status=${res.status} raw=${redactBody(rawText)} durationMs=${durationMs}`,
      );
      if (!res.ok) {
        this.emitTrace({
          label: params.label,
          method: "GET",
          redactedUrl: params.traceUrl,
          status: res.status,
          durationMs,
        });
        throw new ILinkHttpError(params.label, res.status, redactBody(rawText, 200));
      }
      let parsed: T;
      try {
        parsed = parseWeixinApiJson<T>(rawText);
      } catch {
        this.emitTrace({
          label: params.label,
          method: "GET",
          redactedUrl: params.traceUrl,
          status: res.status,
          durationMs,
        });
        throw new ILinkParseError(params.label, redactBody(rawText, 200));
      }
      const biz = parsed as { ret?: number; errcode?: number; errmsg?: string };
      this.emitTrace({
        label: params.label,
        method: "GET",
        redactedUrl: params.traceUrl,
        status: res.status,
        ret: biz?.ret,
        errcode: biz?.errcode,
        errmsg: biz?.errmsg,
        durationMs,
      });
      return parsed;
    } catch (err) {
      if (err instanceof ILinkHttpError || err instanceof ILinkParseError) throw err;
      const netErr = new ILinkNetworkError(params.label, err);
      this.emitTrace({
        label: params.label,
        method: "GET",
        redactedUrl: params.traceUrl,
        durationMs: Date.now() - started,
        networkError: netErr.classified,
      });
      this.log(
        "error",
        `${params.label} failed url=${params.traceUrl} type=${netErr.classified.type}` +
          (netErr.classified.code ? ` code=${netErr.classified.code}` : ""),
      );
      throw netErr;
    } finally {
      clearTimeout(timer);
    }
  }

  private emitTrace(trace: RequestTrace): void {
    try {
      this.onTrace?.(trace);
    } catch {
      // 诊断回调不应影响流程。
    }
  }

  /**
   * 三层校验的第 3 层：[A]/[M] `isApiError`。
   * `ret`/`errcode` 为 0 或**缺省**都算成功；非 0 抛 `ILinkBusinessError`。
   * 注意：官方用 `!== undefined && !== 0`，本文件保持一致。
   */
  private assertBusinessOk(label: string, resp: { ret?: number; errcode?: number; errmsg?: string }): void {
    const badRet = resp.ret !== undefined && resp.ret !== 0;
    const badErr = resp.errcode !== undefined && resp.errcode !== 0;
    if (badRet || badErr) {
      throw new ILinkBusinessError(label, resp.ret, resp.errcode, resp.errmsg);
    }
  }

  /**
   * 统一的业务错误入口：命中 -14 则置位 `staleTokenPaused` 并回调 `onStaleToken`。
   * ⚠️ 关键：-14 之后**必须停止紧密轮询**（[M] 暂停 1h / [R] 受控重登）。
   */
  private handleBusinessError(err: unknown, label: string): never {
    if (err instanceof ILinkBusinessError && err.isStaleToken) {
      const accountId = this.account?.ilink_bot_id ?? "(unknown)";
      this.staleTokenPaused = true;
      this.typingTicketCache.clear();
      this.log(
        "error",
        `${label}: ret/errcode=${STALE_TOKEN_ERRCODE} bot token is STALE, ` +
          `pause polling and require re-login (accountId=${accountId})`,
      );
      try {
        this.onStaleToken?.({ accountId, message: err.message });
      } catch {
        // 忽略回调异常
      }
    }
    throw err;
  }

  // ---------------------------------------------------------------------------
  // 8.4 状态持久化（原子写：临时文件 → rename）
  // ---------------------------------------------------------------------------

  private accountsDir(): string {
    return join(this.stateDir, "accounts");
  }

  private conversationsDir(): string {
    return join(this.stateDir, "conversations");
  }

  private accountPath(accountId: string): string {
    return join(this.accountsDir(), `${safeAccountFileName(accountId)}.account.json`);
  }

  private syncBufPath(accountId: string): string {
    return join(this.accountsDir(), `${safeAccountFileName(accountId)}.sync.json`);
  }

  private conversationPath(accountId: string, userId: string): string {
    return join(
      this.conversationsDir(),
      `${safeAccountFileName(accountId)}__${safeAccountFileName(userId)}.json`,
    );
  }

  /**
   * 原子写 JSON：先写 `<file>.<pid>.<rand>.tmp` 再 `rename`（[R] 2.7.5：
   * "持久化文件应采用临时文件写入后原子替换"）。同目录 rename 在 POSIX/NTFS 上都原子。
   */
  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data), "utf-8");
      await rename(tmp, filePath);
    } catch (err) {
      // 失败时清理临时文件，避免脏文件堆积。
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  private async readJson<T>(filePath: string): Promise<T | undefined> {
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  // ---- 账号 ----

  /** 载入本地账号（`bot_token` 等）。找不到返回 `undefined`。 */
  async loadAccount(accountId: string): Promise<PersistedAccount | undefined> {
    return this.readJson<PersistedAccount>(this.accountPath(accountId));
  }

  /** 列出本地已保存账号 ID。 */
  async listLocalAccountIds(): Promise<string[]> {
    const dir = this.accountsDir();
    try {
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(dir);
      return names
        .filter((n) => n.endsWith(".account.json"))
        .map((n) => n.slice(0, -".account.json".length));
    } catch {
      return [];
    }
  }

  /**
   * [L] `getLocalBotTokenList()`：取最近 N 个本地 token 填进 `local_token_list`。
   * 官方取最新 10 个（按注册顺序倒序）。本文件按文件修改时间倒序近似。
   */
  private async collectLocalTokenList(limit = 10): Promise<string[]> {
    const { readdir, stat } = await import("node:fs/promises");
    const dir = this.accountsDir();
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".account.json"));
    } catch {
      return [];
    }
    const withTime = await Promise.all(
      names.map(async (n) => {
        try {
          const st = await stat(join(dir, n));
          return { n, mtime: st.mtimeMs };
        } catch {
          return { n, mtime: 0 };
        }
      }),
    );
    withTime.sort((a, b) => b.mtime - a.mtime);
    const tokens: string[] = [];
    for (const { n } of withTime) {
      if (tokens.length >= limit) break;
      const acc = await this.readJson<PersistedAccount>(join(dir, n));
      const t = acc?.bot_token?.trim();
      if (t) tokens.push(t);
    }
    return tokens;
  }

  /**
   * 切换到某个账号：载入 token/baseurl/游标/上下文缓存，**清空 typing 缓存**。
   * ⚠️ [R] 2.7.5：切换账号时不得沿用另一个账号的游标和 context_token。
   */
  async setAccount(account: PersistedAccount): Promise<void> {
    this.account = { ...account };
    this.baseUrl = (account.baseurl ?? this.baseUrl).replace(/\/+$/, "");
    this.typingTicketCache.clear();
    this.contextTokenCache.clear();
    this.staleTokenPaused = false;
    this.getUpdatesBuf = (await this.loadSyncBuf(account.ilink_bot_id ?? "")) ?? "";
    this.log(
      "info",
      `setAccount accountId=${account.ilink_bot_id ?? "(none)"} baseUrl=${this.baseUrl} ` +
        `token=${redactToken(account.bot_token)}`,
    );
  }

  /** 从磁盘按 accountId 载入并切换。 */
  async setAccountById(accountId: string): Promise<PersistedAccount | undefined> {
    const acc = await this.loadAccount(accountId);
    if (!acc) return undefined;
    if (!acc.ilink_bot_id) acc.ilink_bot_id = accountId;
    await this.setAccount(acc);
    return this.account ?? undefined;
  }

  /** 当前账号（可能是 `null`）。 */
  getAccount(): PersistedAccount | null {
    return this.account ? { ...this.account } : null;
  }

  /** 当前业务 base URL。 */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** 是否处于 -14 后的"拒绝轮询"状态。 */
  isStaleTokenPaused(): boolean {
    return this.staleTokenPaused;
  }

  /** 显式解除 -14 暂停（一般由 `relogin()` 内部调用，也可手工用于测试）。 */
  clearStaleTokenPause(): void {
    this.staleTokenPaused = false;
  }

  // ---- 游标 ----

  /** [R] 2.7.5：按账号持久化的 `get_updates_buf`。 */
  async loadSyncBuf(accountId: string): Promise<string | undefined> {
    const data = await this.readJson<PersistedSyncBuf>(this.syncBufPath(accountId));
    return typeof data?.get_updates_buf === "string" ? data.get_updates_buf : undefined;
  }

  /** 原子保存游标（只在成功且非空时由调用方触发）。 */
  async saveSyncBuf(accountId: string, buf: string): Promise<void> {
    await this.writeJsonAtomic(this.syncBufPath(accountId), {
      get_updates_buf: buf,
      updated_at_ms: Date.now(),
    } satisfies PersistedSyncBuf);
  }

  /** 当前内存游标。 */
  getGetUpdatesBuf(): string {
    return this.getUpdatesBuf;
  }

  // ---- 会话上下文 ----

  /** 载入"账号 + 用户"的 `context_token`。 */
  async loadConversation(accountId: string, userId: string): Promise<string | undefined> {
    const data = await this.readJson<PersistedConversation>(
      this.conversationPath(accountId, userId),
    );
    return typeof data?.context_token === "string" ? data.context_token : undefined;
  }

  /** [R] 2.7.5：按"账号 + 用户"原子保存 `context_token`。 */
  async saveConversation(accountId: string, userId: string, contextToken: string): Promise<void> {
    await this.writeJsonAtomic(this.conversationPath(accountId, userId), {
      context_token: contextToken,
      updated_at_ms: Date.now(),
    } satisfies PersistedConversation);
  }

  /** 内存里取上下文（必要时回落磁盘）。 */
  async resolveContextToken(userId: string, inboundContextToken?: string): Promise<string | undefined> {
    const accountId = this.account?.ilink_bot_id ?? "";
    // 入站消息的 token 优先，并顺手落盘（按账号 + 用户隔离）。
    if (inboundContextToken) {
      this.contextTokenCache.set(userId, inboundContextToken);
      if (accountId) await this.saveConversation(accountId, userId, inboundContextToken);
      return inboundContextToken;
    }
    const cached = this.contextTokenCache.get(userId);
    if (cached) return cached;
    if (!accountId) return undefined;
    const fromDisk = await this.loadConversation(accountId, userId);
    if (fromDisk) this.contextTokenCache.set(userId, fromDisk);
    return fromDisk;
  }

  // ---------------------------------------------------------------------------
  // 8.5 二维码登录状态机
  // ---------------------------------------------------------------------------

  /**
   * [P] `POST /ilink/bot/get_bot_qrcode?bot_type=3`
   * body: `{ "local_token_list": [...] }`（最多最近 10 个）。
   *
   * ⚠️ 该 POST 用**完整 JSON POST 头**（含 AuthorizationType / X-WECHAT-UIN），
   *    但**不带 Authorization**，body 也**不带 `base_info`**（[P] "Request headers"
   *    的 Client behavior 段明确说明）。
   */
  async fetchQrCode(botType: string = DEFAULT_ILINK_BOT_TYPE): Promise<QRCodeResponse> {
    const localTokenList = await this.collectLocalTokenList(10);
    const endpoint = `ilink/bot/get_bot_qrcode?bot_type=${enc(botType)}`;
    this.log("info", `fetchQrCode bot_type=${botType} local_token_list_count=${localTokenList.length}`);
    const resp = await this.postJson<QRCodeResponse>({
      baseUrl: FIXED_QR_BASE_URL,
      endpoint,
      body: { local_token_list: localTokenList },
      timeoutMs: this.timeouts.configMs,
      label: "fetchQrCode",
      traceUrl: `${FIXED_QR_BASE_URL}/ilink/bot/get_bot_qrcode`,
    });
    if (!resp?.qrcode) {
      throw new ILinkParseError("fetchQrCode", "response missing qrcode field");
    }
    this.log(
      "info",
      `fetchQrCode ok qrcode=${redactToken(resp.qrcode)} imgContent=${redactToken(resp.qrcode_img_content, 24)}`,
    );
    return resp;
  }

  /** 启动一个登录会话（获取二维码并初始化轮询 base = 固定入口）。 */
  async startQrLogin(botType: string = DEFAULT_ILINK_BOT_TYPE): Promise<QrLoginSession> {
    const qr = await this.fetchQrCode(botType);
    return {
      qrcode: qr.qrcode,
      qrcodeImgContent: qr.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: FIXED_QR_BASE_URL,
      refreshCount: 1,
    };
  }

  /**
   * 单次状态轮询。
   * `GET /ilink/bot/get_qrcode_status?qrcode=<encoded>[&verify_code=<encoded>]`（[P]）。
   * ⚠️ 网络超时 / 网关 524 等按 `wait` 处理，继续轮询（[L] `pollQRStatus`）。
   */
  async pollQrStatus(session: QrLoginSession): Promise<QRStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${enc(session.qrcode)}`;
    if (session.pendingVerifyCode) {
      endpoint += `&verify_code=${enc(session.pendingVerifyCode)}`;
    }
    try {
      const resp = await this.getJson<QRStatusResponse>({
        baseUrl: session.currentBaseUrl,
        endpoint,
        timeoutMs: this.timeouts.qrPollMs,
        label: "pollQrStatus",
        traceUrl: `${session.currentBaseUrl}/ilink/bot/get_qrcode_status`,
      });
      return resp?.status ? resp : { status: "wait" };
    } catch (err) {
      if (err instanceof ILinkNetworkError && err.timedOut) {
        this.log("debug", `pollQrStatus: client-side timeout, treat as wait`);
        return { status: "wait" };
      }
      // 网关超时/其他网络错误也按 wait 继续（[L]）。
      this.log("warn", `pollQrStatus: transient error, treat as wait: ${String(err)}`);
      return { status: "wait" };
    }
  }

  /**
   * 驱动登录状态机直到出结果。
   *
   * 8 个状态全部处理（语义照抄 [L] `waitForWeixinLogin` + [P] 状态表）：
   *  - `wait`                 继续轮询
   *  - `scaned`              已扫码；若带过配对码说明配对码被接受，清除暂存
   *  - `need_verifycode`     调用 `onNeedVerifyCode` 取数字配对码，暂存后立即再轮询
   *  - `verify_code_blocked` 清配对码 + 刷新二维码，超过上限终止
   *  - `expired`             刷新二维码，超过上限终止
   *  - `scaned_but_redirect` 切到 `https://<redirect_host>` 继续轮询
   *  - `confirmed`           必须拿到 `ilink_bot_id`，否则视为失败
   *  - `binded_redirect`     ⚠️ **只有本地确实还有有效 token 时才算成功**
   *
   * @param onNeedVerifyCode 需要配对码时的交互回调；返回用户输入。
   *        未提供时视为无法完成验证，返回失败。
   */
  async waitForLogin(
    session: QrLoginSession,
    options: {
      timeoutMs?: number;
      onNeedVerifyCode?: (prompt: string, isRetry: boolean) => Promise<string>;
      onQrRefreshed?: (session: QrLoginSession) => void;
      onStatus?: (status: QRStatus) => void;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<QrLoginResult> {
    const timeoutMs = Math.max(options.timeoutMs ?? 480_000, 1_000);
    const deadline = Date.now() + timeoutMs;
    let lastStatus: QRStatus | undefined;

    while (Date.now() < deadline) {
      if (options.abortSignal?.aborted) {
        return { connected: false, message: "登录已取消。", lastStatus };
      }
      // 本地 TTL 保护（[L] `ACTIVE_LOGIN_TTL_MS`）。
      if (Date.now() - session.startedAt > QR_SESSION_TTL_MS * 12) {
        return { connected: false, message: "二维码会话已过期，请重新生成。", lastStatus };
      }

      const resp = await this.pollQrStatus(session);
      lastStatus = resp.status;
      options.onStatus?.(resp.status);
      this.log(
        "debug",
        `pollQrStatus status=${resp.status} hasBotToken=${Boolean(resp.bot_token)} ` +
          `hasBotId=${Boolean(resp.ilink_bot_id)} host=${session.currentBaseUrl}`,
      );

      switch (resp.status) {
        case "wait":
          break;

        case "scaned":
          // 若上次携带了配对码而服务端返回 scaned，说明配对码正确（[L]）。
          if (session.pendingVerifyCode) {
            this.log("info", "verify code accepted, resuming polling");
            session.pendingVerifyCode = undefined;
          }
          break;

        case "need_verifycode": {
          if (!options.onNeedVerifyCode) {
            return {
              connected: false,
              message: "需要输入配对码，但未提供 onNeedVerifyCode 回调。",
              lastStatus,
            };
          }
          const isRetry = Boolean(session.pendingVerifyCode);
          const code = await options.onNeedVerifyCode(
            isRetry ? "配对码不匹配，请重新输入：" : "请输入手机微信显示的数字配对码：",
            isRetry,
          );
          session.pendingVerifyCode = code?.trim() || undefined;
          // 立即进入下一次轮询，不 sleep（[L] 用 `continue` 实现）。
          continue;
        }

        case "expired": {
          session.refreshCount += 1;
          if (session.refreshCount > MAX_QR_REFRESH_COUNT) {
            return {
              connected: false,
              message: "二维码多次失效，连接流程已停止，请稍后再试。",
              lastStatus,
            };
          }
          const ok = await this.refreshSessionQr(session);
          if (!ok) {
            return { connected: false, message: "刷新二维码失败。", lastStatus };
          }
          options.onQrRefreshed?.(session);
          break;
        }

        case "verify_code_blocked": {
          this.log("warn", `verify_code_blocked refreshCount=${session.refreshCount}`);
          session.pendingVerifyCode = undefined;
          session.refreshCount += 1;
          if (session.refreshCount > MAX_QR_REFRESH_COUNT) {
            return {
              connected: false,
              message: "配对码多次错误，连接流程已停止，请稍后再试。",
              lastStatus,
            };
          }
          const ok = await this.refreshSessionQr(session);
          if (!ok) {
            return { connected: false, message: "刷新二维码失败。", lastStatus };
          }
          options.onQrRefreshed?.(session);
          break;
        }

        case "scaned_but_redirect": {
          if (resp.redirect_host) {
            // [L]：新 base 为 `https://${redirect_host}`（redirect_host 不含 scheme）。
            session.currentBaseUrl = `https://${resp.redirect_host}`;
            this.log("info", `IDC redirect, switching polling host to ${resp.redirect_host}`);
          } else {
            this.log(
              "warn",
              "scaned_but_redirect without redirect_host, keep current polling host",
            );
          }
          break;
        }

        case "binded_redirect": {
          // ⚠️ 关键实现点（任务要求 + [R] 2.5.2）：
          //    该状态本身**不携带新凭据**，语义是"扫码的 bot 早已绑定到本客户端"。
          //    只有本地确实还留有可用 token 时才能算成功；否则必须报错并让上层重登，
          //    绝不能凭这个状态凭空构造 token。
          //    （[L] 官方实现直接返回 alreadyConnected=true / connected=false，
          //      因为宿主侧另有 token 存储；本独立客户端必须自己确认本地 token。）
          const myAccountId = this.account?.ilink_bot_id;
          const effectiveAccount =
            myAccountId ??
            (await this.findAnyLocalAccountWithToken());
          if (effectiveAccount) {
            this.log(
              "info",
              `binded_redirect: reuse local credentials accountId=${effectiveAccount.accountId} ` +
                `token=${redactToken(effectiveAccount.account.bot_token)}`,
            );
            await this.setAccount({
              ...effectiveAccount.account,
              ilink_bot_id: effectiveAccount.account.ilink_bot_id ?? effectiveAccount.accountId,
            });
            return {
              connected: true,
              alreadyConnected: true,
              account: this.getAccount() ?? undefined,
              message: "该 bot 已绑定到本客户端，直接复用本地凭据。",
              lastStatus,
            };
          }
          this.log(
            "error",
            "binded_redirect but no valid local token found; cannot treat as success",
          );
          return {
            connected: false,
            message:
              "服务端表示该 bot 已绑定，但本地没有可用凭据，无法复用；请清理服务端绑定或换个微信号重试。",
            lastStatus,
          };
        }

        case "confirmed": {
          // [L]：`confirmed` 必须至少能拿到 `ilink_bot_id`，否则视为失败。
          if (!resp.ilink_bot_id) {
            return {
              connected: false,
              message: "登录失败：服务端 confirmed 但未返回 ilink_bot_id。",
              lastStatus,
            };
          }
          if (!resp.bot_token) {
            return {
              connected: false,
              message: "登录失败：服务端 confirmed 但未返回 bot_token。",
              lastStatus,
            };
          }
          const account: PersistedAccount = {
            bot_token: resp.bot_token,
            baseurl: resp.baseurl,
            ilink_bot_id: resp.ilink_bot_id,
            ilink_user_id: resp.ilink_user_id,
            updated_at_ms: Date.now(),
          };
          // 落盘账号信息（token 属于敏感数据，调用方应确保 stateDir 权限收敛）。
          await this.writeJsonAtomic(this.accountPath(resp.ilink_bot_id), account);
          await this.setAccount(account);
          this.log(
            "info",
            `login confirmed ilink_bot_id=${resp.ilink_bot_id} ` +
              `ilink_user_id=${redactToken(resp.ilink_user_id)} baseurl=${resp.baseurl ?? "(default)"}`,
          );
          return {
            connected: true,
            account,
            message: "已将此客户端连接到微信。",
            lastStatus,
          };
        }

        default: {
          // 未知状态：记录并继续，不要因协议增量而崩掉整个登录流程。
          this.log("warn", `pollQrStatus unknown status=${String((resp as { status?: unknown }).status)}`);
          break;
        }
      }

      // 轮询间隔 1s（[L]）。用可中断 sleep 以免 stop 时卡住。
      try {
        await sleep(1_000, options.abortSignal);
      } catch {
        return { connected: false, message: "登录已取消。", lastStatus };
      }
    }

    return { connected: false, message: "登录超时，请重试。", lastStatus };
  }

  /** 刷新二维码（`expired` / `verify_code_blocked` 共用），就地更新会话。 */
  private async refreshSessionQr(session: QrLoginSession): Promise<boolean> {
    this.log("info", `refreshing QR code (${session.refreshCount}/${MAX_QR_REFRESH_COUNT})`);
    try {
      const qr = await this.fetchQrCode();
      session.qrcode = qr.qrcode;
      session.qrcodeImgContent = qr.qrcode_img_content;
      session.startedAt = Date.now();
      session.pendingVerifyCode = undefined;
      session.currentBaseUrl = FIXED_QR_BASE_URL;
      return true;
    } catch (err) {
      this.log("error", `refresh QR code failed: ${String(err)}`);
      return false;
    }
  }

  /** 找一个本地存在且含 token 的账号（用于 `binded_redirect` 复用判定）。 */
  private async findAnyLocalAccountWithToken(): Promise<
    { accountId: string; account: PersistedAccount } | undefined
  > {
    const ids = await this.listLocalAccountIds();
    for (const id of ids) {
      const acc = await this.loadAccount(id);
      if (acc?.bot_token?.trim()) return { accountId: id, account: acc };
    }
    return undefined;
  }

  /**
   * 便捷组合：取二维码 → 等扫码 → 返回结果。
   * `qrHandler` 用来把 `qrcodeImgContent` 交给终端/UI（**注意它通常是 URL**）。
   */
  async login(options: {
    botType?: string;
    timeoutMs?: number;
    onQrCode?: (session: QrLoginSession) => void | Promise<void>;
    onNeedVerifyCode?: (prompt: string, isRetry: boolean) => Promise<string>;
    onStatus?: (status: QRStatus) => void;
    abortSignal?: AbortSignal;
  } = {}): Promise<QrLoginResult> {
    const session = await this.startQrLogin(options.botType);
    await options.onQrCode?.(session);
    return this.waitForLogin(session, {
      timeoutMs: options.timeoutMs,
      onNeedVerifyCode: options.onNeedVerifyCode,
      onStatus: options.onStatus,
      abortSignal: options.abortSignal,
      onQrRefreshed: (s) => {
        void options.onQrCode?.(s);
      },
    });
  }

  /**
   * `-14` 之后的受控重登：暂停期间的业务请求应在此处被上层"重新扫码"取代。
   * 本方法只负责：清空暂停位 + 清 typing 缓存 + 走一次完整登录，
   * **不做自动无限重试**（[R] 2.7.3：不能无限重试）。
   */
  async relogin(options: Parameters<ILinkClient["login"]>[0] = {}): Promise<QrLoginResult> {
    this.log("warn", "relogin: starting controlled re-login after stale token");
    this.staleTokenPaused = false;
    this.typingTicketCache.clear();
    return this.login(options);
  }

  // ---------------------------------------------------------------------------
  // 8.6 业务 API
  // ---------------------------------------------------------------------------

  /** 每次业务请求前检查是否可以发（-14 暂停期间一律拒绝）。 */
  private assertReady(label: string): void {
    if (this.staleTokenPaused) {
      throw new ILinkAuthError(
        "stale_token",
        `${label}: bot token is stale (-14); call relogin() before resuming requests`,
      );
    }
    if (!this.account?.bot_token) {
      throw new ILinkAuthError("not_logged_in", `${label}: no bot_token, login first`);
    }
  }

  /**
   * [P] `POST /ilink/bot/msg/notifystart`（[R] 2.6.5：最佳努力，失败只告警）。
   */
  async notifyStart(): Promise<NotifyStartResp | undefined> {
    if (!this.account?.bot_token) {
      this.log("warn", "notifyStart skipped: no bot_token");
      return undefined;
    }
    try {
      const resp = await this.postJson<NotifyStartResp>({
        endpoint: "ilink/bot/msg/notifystart",
        body: { base_info: this.buildBaseInfo() },
        timeoutMs: this.timeouts.configMs,
        label: "notifyStart",
        traceUrl: `${this.baseUrl}/ilink/bot/msg/notifystart`,
      });
      // [P] D5：官方不阻断，只告警。
      if (resp.ret !== undefined && resp.ret !== 0) {
        this.log("warn", `notifyStart non-zero ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
      }
      return resp;
    } catch (err) {
      this.log("warn", `notifyStart failed (ignored): ${String(err)}`);
      return undefined;
    }
  }

  /**
   * [P] `POST /ilink/bot/msg/notifystop`（[R] 2.6.5 / [R] 2.7.6：
   * **独立短超时**、最佳努力，不能被长轮询的取消信号一起取消）。
   *
   * 实现要点：这里**不传** `externalSignal`，并用独立的 AbortController，
   * 因此即使调用方刚 abort 了长轮询，本请求仍能完成。
   */
  async notifyStop(timeoutMs = this.timeouts.configMs): Promise<NotifyStopResp | undefined> {
    if (!this.account?.bot_token) {
      this.log("warn", "notifyStop skipped: no bot_token");
      return undefined;
    }
    try {
      const resp = await this.postJson<NotifyStopResp>({
        endpoint: "ilink/bot/msg/notifystop",
        body: { base_info: this.buildBaseInfo() },
        timeoutMs,
        label: "notifyStop",
        traceUrl: `${this.baseUrl}/ilink/bot/msg/notifystop`,
      });
      if (resp.ret !== undefined && resp.ret !== 0) {
        this.log("warn", `notifyStop non-zero ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
      }
      return resp;
    } catch (err) {
      this.log("warn", `notifyStop failed (ignored): ${String(err)}`);
      return undefined;
    }
  }

  /**
   * [P] `GET/…` 无——`getConfig` 是 `POST /ilink/bot/getconfig`。
   * 取 `typing_ticket`（按"账号 + 用户"缓存）。[R] 2.6.2：仅用于输入状态，
   * **不是 `sendmessage` 的鉴权前置**。
   *
   * @param force 绕过缓存强制刷新。
   */
  async getConfig(params: {
    ilinkUserId: string;
    contextToken?: string;
    force?: boolean;
  }): Promise<GetConfigResp> {
    this.assertReady("getConfig");
    const key = this.typingTicketKey(params.ilinkUserId);
    if (!params.force) {
      const cached = this.typingTicketCache.get(key);
      if (cached) return { ret: 0, typing_ticket: cached };
    }
    try {
      const resp = await this.postJson<GetConfigResp>({
        endpoint: "ilink/bot/getconfig",
        body: {
          ilink_user_id: params.ilinkUserId,
          context_token: params.contextToken,
          base_info: this.buildBaseInfo(),
        },
        timeoutMs: this.timeouts.configMs,
        label: "getConfig",
        traceUrl: `${this.baseUrl}/ilink/bot/getconfig`,
      });
      // [P]：cache 层只在 ret === 0 时接受配置。
      if (resp.ret === 0 && resp.typing_ticket) {
        this.typingTicketCache.set(key, resp.typing_ticket);
        this.log(
          "debug",
          `getConfig cached typing_ticket user=${params.ilinkUserId} ticket=${redactToken(resp.typing_ticket)}`,
        );
      } else if (resp.ret !== undefined && resp.ret !== 0) {
        this.log("warn", `getConfig ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
      }
      return resp;
    } catch (err) {
      this.handleBusinessError(err, "getConfig");
    }
  }

  /** 缓存键：账号 + 用户（[R] 2.6.2）。 */
  private typingTicketKey(userId: string): string {
    return `${this.account?.ilink_bot_id ?? "-"}::${userId}`;
  }

  /** 清空 typing/context 内存缓存（切 token/账号后调用）。 */
  clearCaches(): void {
    this.typingTicketCache.clear();
    this.contextTokenCache.clear();
    this.log("info", "caches cleared (typing_ticket / context_token)");
  }

  /**
   * [P] `POST /ilink/bot/sendtyping`。`status=1` 正在输入，`2` 取消。
   * 传 `ticket` 则直接用；否则自动 `getConfig` 取（并缓存）。
   * [P] D5：官方包装器不解析响应体，本方法**只告警**，不抛业务错误。
   */
  async sendTyping(params: {
    ilinkUserId: string;
    status: number;
    typingTicket?: string;
    contextToken?: string;
  }): Promise<SendTypingResp | undefined> {
    this.assertReady("sendTyping");
    let ticket = params.typingTicket;
    if (!ticket) {
      const cfg = await this.getConfig({
        ilinkUserId: params.ilinkUserId,
        contextToken: params.contextToken,
      });
      ticket = cfg?.typing_ticket;
    }
    if (!ticket) {
      this.log("debug", `sendTyping skipped: no typing_ticket for ${params.ilinkUserId}`);
      return undefined;
    }
    try {
      const resp = await this.postJson<SendTypingResp>({
        endpoint: "ilink/bot/sendtyping",
        body: {
          ilink_user_id: params.ilinkUserId,
          typing_ticket: ticket,
          status: params.status,
          base_info: this.buildBaseInfo(),
        },
        timeoutMs: this.timeouts.configMs,
        label: "sendTyping",
        traceUrl: `${this.baseUrl}/ilink/bot/sendtyping`,
      });
      if (resp.ret !== undefined && resp.ret !== 0) {
        this.log("warn", `sendTyping ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
      }
      return resp;
    } catch (err) {
      // -14 仍然要置位暂停；但其他失败不应阻断正文发送（[R] 2.6.3 的 finally 语义）。
      if (err instanceof ILinkBusinessError && err.isStaleToken) {
        this.handleBusinessError(err, "sendTyping");
      }
      this.log("warn", `sendTyping failed (ignored): ${String(err)}`);
      return undefined;
    }
  }

  /** 便捷方法：开始/取消输入状态。 */
  async startTyping(ilinkUserId: string, contextToken?: string): Promise<void> {
    await this.sendTyping({ ilinkUserId, status: TypingStatus.TYPING, contextToken });
  }
  async stopTyping(ilinkUserId: string, contextToken?: string): Promise<void> {
    await this.sendTyping({ ilinkUserId, status: TypingStatus.CANCEL, contextToken });
  }

  /**
   * [P] `POST /ilink/bot/sendmessage` — **第一阶段仅文本**。
   *
   * 文本 body（[P] "sendMessage" 示例 + [R] 2.6.4）：
   * ```
   * { msg: { from_user_id: "", to_user_id, client_id, message_type: 2,
   *          message_state: 2, context_token, item_list: [{ type: 1,
   *          text_item: { text } }] }, base_info }
   * ```
   *
   * 校验：三层（网络 + HTTP 2xx + JSON 且 `ret`/`errcode` 为 0 或缺省）。
   * ⚠️ [P]：`sendMessage` 只检查非零 `ret`；本文件同时检查 `errcode`（[R] 2.7.1
   *    要求两者都看），更严格不会误判成功。
   * ⚠️ `context_token` 必须来自**当前入站消息**；`client_id` 每次唯一。
   *
   * @param text 文本内容
   * @param params.toUserId 目标用户
   * @param params.contextToken 当前会话上下文；缺省时尝试用本地缓存（主动发送）。
   * @param params.runId 可选：同一轮 agent/tool 运行 ID。
   */
  async sendText(
    text: string,
    params: {
      toUserId: string;
      contextToken?: string;
      runId?: string;
      clientId?: string;
    },
  ): Promise<SendMessageResp> {
    this.assertReady("sendMessage");
    const contextToken =
      params.contextToken ?? (await this.resolveContextToken(params.toUserId));
    if (!contextToken) {
      // [P]：官方在缺 token 时只告警仍然发送，但这不证明服务端会接受。
      this.log(
        "warn",
        `sendMessage: context_token missing for ${params.toUserId}, sending anyway (may be rejected)`,
      );
    }

    const clientId = params.clientId ?? newClientId();
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: params.toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        ...(contextToken ? { context_token: contextToken } : {}),
        ...(params.runId ? { run_id: params.runId } : {}),
        item_list: [
          {
            type: MessageItemType.TEXT,
            text_item: { text },
          },
        ],
      },
    };
    this.log(
      "info",
      `sendMessage text to=${params.toUserId} clientId=${clientId} ` +
        `textLen=${text.length} contextTokenFp=${tokenFingerprint(contextToken)}`,
    );

    try {
      const resp = await this.postJson<SendMessageResp>({
        endpoint: "ilink/bot/sendmessage",
        body: { ...req, base_info: this.buildBaseInfo() },
        timeoutMs: this.timeouts.apiMs,
        label: "sendMessage",
        traceUrl: `${this.baseUrl}/ilink/bot/sendmessage`,
      });
      // 三层校验第 3 层。
      this.assertBusinessOk("sendMessage", resp);
      this.log(
        "info",
        `sendMessage ok ret=${resp.ret ?? 0} messageId=${resp.message_id ?? "(none)"}`,
      );
      return resp;
    } catch (err) {
      this.handleBusinessError(err, "sendMessage");
    }
  }

  /**
   * 完整的一轮交互辅助：`sendtyping(1)` → `sendmessage` → `sendtyping(2)`。
   * 取消输入状态放在 `finally`（[R] 2.6.3）——即使正文发送失败也要尽力取消。
   * `getConfig/sendtyping` 失败**不阻断**正文发送。
   */
  async replyWithTyping(
    inbound: WeixinMessage,
    produce: () => Promise<string> | string,
  ): Promise<SendMessageResp> {
    const toUserId = inbound.from_user_id;
    if (!toUserId) throw new ILinkAuthError("bad_message", "inbound message has no from_user_id");
    const accountId = this.account?.ilink_bot_id ?? "";
    // 入站 token 立即落盘（按账号 + 用户隔离）。
    if (inbound.context_token && accountId) {
      await this.saveConversation(accountId, toUserId, inbound.context_token);
      this.contextTokenCache.set(toUserId, inbound.context_token);
    }
    // 尽力拿 typing_ticket（失败不影响正文）。
    try {
      await this.getConfig({ ilinkUserId: toUserId, contextToken: inbound.context_token });
    } catch (err) {
      this.log("warn", `replyWithTyping: getConfig failed (ignored): ${String(err)}`);
    }
    await this.startTyping(toUserId, inbound.context_token);
    try {
      const text = await produce();
      return await this.sendText(text, {
        toUserId,
        contextToken: inbound.context_token,
        runId: inbound.run_id,
      });
    } finally {
      await this.stopTyping(toUserId, inbound.context_token);
    }
  }

  // ---------------------------------------------------------------------------
  // 8.7 长轮询
  // ---------------------------------------------------------------------------

  /**
   * [P] `POST /ilink/bot/getupdates` 单次调用。
   *
   * 关键点：
   *  - body 只发 `get_updates_buf` + `base_info`（`sync_buf` 已废弃，不发）。
   *  - `longpolling_timeout_ms` **正数才采用**，用于下一轮超时（[M]）。
   *  - 客户端超时返回 `{kind:"timeout"}`，游标保留（[R] 2.6.1）。
   *  - 成功且 `get_updates_buf` 非空才更新并**原子持久化**（[P]/[M]）。
   *  - `ret`/`errcode` = -14 → `{kind:"stale_token"}` 并置位暂停。
   */
  async pollOnce(externalSignal?: AbortSignal): Promise<PollOutcome> {
    if (this.staleTokenPaused) {
      return {
        kind: "stale_token",
        message: "bot token is stale (-14); relogin required before polling",
      };
    }
    if (!this.account?.bot_token) {
      return { kind: "error", ret: undefined, errcode: undefined, errmsg: "no bot_token" };
    }
    const timeoutMs = this.nextLongPollTimeoutMs;
    let resp: GetUpdatesResp;
    try {
      resp = await this.postJson<GetUpdatesResp>({
        endpoint: "ilink/bot/getupdates",
        body: {
          get_updates_buf: this.getUpdatesBuf,
          base_info: this.buildBaseInfo(),
        },
        timeoutMs,
        label: "getUpdates",
        externalSignal,
        traceUrl: `${this.baseUrl}/ilink/bot/getupdates`,
      });
    } catch (err) {
      // 外部取消（优雅停止）。
      if (externalSignal?.aborted) {
        return { kind: "timeout", timeoutMs };
      }
      if (err instanceof ILinkNetworkError && err.timedOut) {
        // 长轮询正常控制流：保留游标，交给循环按退避策略处理（D2）。
        this.log("debug", `getUpdates: client-side timeout after ${timeoutMs}ms`);
        return { kind: "timeout", timeoutMs };
      }
      throw err;
    }

    // `longpolling_timeout_ms` 动态采用（[M]：正数才用）。
    if (typeof resp.longpolling_timeout_ms === "number" && resp.longpolling_timeout_ms > 0) {
      this.nextLongPollTimeoutMs = resp.longpolling_timeout_ms;
      this.log("debug", `getUpdates: next poll timeout = ${this.nextLongPollTimeoutMs}ms`);
    }

    const badRet = resp.ret !== undefined && resp.ret !== 0;
    const badErr = resp.errcode !== undefined && resp.errcode !== 0;
    if (badRet || badErr) {
      const stale = resp.ret === STALE_TOKEN_ERRCODE || resp.errcode === STALE_TOKEN_ERRCODE;
      if (stale) {
        const accountId = this.account?.ilink_bot_id ?? "(unknown)";
        this.staleTokenPaused = true;
        this.typingTicketCache.clear();
        this.log(
          "error",
          `getUpdates: ret/errcode=${STALE_TOKEN_ERRCODE} bot token STALE, stop tight polling ` +
            `(accountId=${accountId})`,
        );
        try {
          this.onStaleToken?.({
            accountId,
            message: `getUpdates ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
          });
        } catch {
          // 忽略回调异常
        }
        return {
          kind: "stale_token",
          message: `ret=${resp.ret ?? "-"} errcode=${resp.errcode ?? "-"} errmsg=${resp.errmsg ?? ""}`,
        };
      }
      this.log(
        "error",
        `getUpdates failed ret=${resp.ret ?? "-"} errcode=${resp.errcode ?? "-"} ` +
          `errmsg=${resp.errmsg ?? "(none)"} response=${redactBody(JSON.stringify(resp))}`,
      );
      return { kind: "error", ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg };
    }

    // 成功：只在非空时更新游标（[P]：不在非空时才保存）。
    if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
      this.getUpdatesBuf = resp.get_updates_buf;
      const accountId = this.account?.ilink_bot_id ?? "";
      if (accountId) {
        try {
          await this.saveSyncBuf(accountId, this.getUpdatesBuf);
          this.log("debug", `saved get_updates_buf (${this.getUpdatesBuf.length} bytes)`);
        } catch (err) {
          // 持久化失败不能丢消息：内存游标已更新，下一轮仍可继续，只告警。
          this.log("warn", `saveSyncBuf failed (ignored): ${String(err)}`);
        }
      }
    }

    const msgs = resp.msgs ?? [];
    if (msgs.length === 0) return { kind: "empty", timeoutMs };
    return { kind: "messages", msgs, timeoutMs };
  }

  /**
   * 长轮询主循环（可取消、可退避、动态超时）。
   *
   * 退避策略（[M] + 任务要求）：普通失败先等 2s；连续失败达 3 次后等 30s 并重置计数。
   * **成功（含空 msgs）重置计数**（D3）。
   * `-14` → 立即退出循环并触发 `onStaleToken`，绝不重试（D6）。
   * 长轮询客户端超时 → 计入普通失败（D2）。
   */
  runPollLoop(options: {
    onMessage: (msg: WeixinMessage, client: ILinkClient) => Promise<void> | void;
    onError?: (err: unknown, consecutiveFailures: number) => void;
    /** 每轮成功/超时后调用，便于外部做心跳。 */
    onTick?: (outcome: PollOutcome) => void;
    /** 外部取消信号（与 `stop()` 等效）。 */
    abortSignal?: AbortSignal;
  }): PollLoopHandle {
    const controller = new AbortController();
    const signal = controller.signal;
    const external = options.abortSignal;
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    let consecutiveFailures = 0;
    this.loopAbort = controller;
    this.loopRunning = true;

    const done = (async () => {
      this.log("info", `poll loop started baseUrl=${this.baseUrl}`);
      try {
        while (!signal.aborted) {
          if (this.staleTokenPaused) {
            // -14 之后不得紧密轮询：直接退出，等待上层 relogin()。
            this.log("error", "poll loop exits: stale token (-14), relogin required");
            break;
          }
          let outcome: PollOutcome;
          try {
            outcome = await this.pollOnce(signal);
          } catch (err) {
            // 网络层 / HTTP 层 / 解析层失败。
            if (signal.aborted) break;
            consecutiveFailures += 1;
            const classified =
              err instanceof ILinkNetworkError ? err.classified : classifyFetchError(err);
            this.log(
              "error",
              `getUpdates error (${consecutiveFailures}/${this.backoff.maxConsecutiveFailures}) ` +
                `type=${classified.type}` +
                (classified.code ? ` code=${classified.code}` : "") +
                ` err=${String(err)}`,
            );
            try {
              options.onError?.(err, consecutiveFailures);
            } catch {
              // 忽略回调异常
            }
            const waitMs = this.computeBackoff(consecutiveFailures);
            if (waitMs > 0 && consecutiveFailures >= this.backoff.maxConsecutiveFailures) {
              consecutiveFailures = 0;
            }
            try {
              await sleep(waitMs, signal);
            } catch {
              break;
            }
            continue;
          }

          options.onTick?.(outcome);

          if (outcome.kind === "stale_token") {
            // 已由 pollOnce 置位暂停；退出循环。
            break;
          }

          if (outcome.kind === "error") {
            consecutiveFailures += 1;
            this.log(
              "error",
              `getUpdates business error (${consecutiveFailures}/${this.backoff.maxConsecutiveFailures})`,
            );
            try {
              options.onError?.(
                new ILinkBusinessError("getUpdates", outcome.ret, outcome.errcode, outcome.errmsg),
                consecutiveFailures,
              );
            } catch {
              // 忽略回调异常
            }
            const waitMs = this.computeBackoff(consecutiveFailures);
            if (consecutiveFailures >= this.backoff.maxConsecutiveFailures) consecutiveFailures = 0;
            try {
              await sleep(waitMs, signal);
            } catch {
              break;
            }
            continue;
          }

          if (outcome.kind === "timeout") {
            // D2：客户端超时按普通失败计入退避（任务策略，与 [M] 不同）。
            consecutiveFailures += 1;
            this.log(
              "debug",
              `getUpdates long-poll client timeout (${consecutiveFailures}/${this.backoff.maxConsecutiveFailures})`,
            );
            const waitMs = this.computeBackoff(consecutiveFailures);
            if (consecutiveFailures >= this.backoff.maxConsecutiveFailures) consecutiveFailures = 0;
            try {
              await sleep(waitMs, signal);
            } catch {
              break;
            }
            continue;
          }

          // empty / messages 都算成功 → 重置连续失败计数（D3）。
          consecutiveFailures = 0;

          if (outcome.kind === "messages") {
            for (const msg of outcome.msgs) {
              if (signal.aborted) break;
              this.log(
                "info",
                `inbound message from=${msg.from_user_id ?? "(none)"} ` +
                  `types=${msg.item_list?.map((i) => i.type).join(",") ?? "none"} ` +
                  `messageId=${msg.message_id ?? "(none)"} ` +
                  `contextTokenFp=${tokenFingerprint(msg.context_token)}`,
              );
              // ⚠️ 群消息（有 group_id）第一阶段不支持：只记录并跳过，
              //    避免把群消息错误地私聊回复给发言人（[R] 2.8）。
              if (msg.group_id) {
                this.log(
                  "warn",
                  `inbound message has group_id=${msg.group_id}; group chat is not supported, skipped`,
                );
                continue;
              }
              try {
                await options.onMessage(msg, this);
              } catch (err) {
                // 单条消息处理失败不能打死整个循环。
                this.log("error", `onMessage handler failed: ${String(err)}`);
                try {
                  options.onError?.(err, consecutiveFailures);
                } catch {
                  // 忽略
                }
              }
            }
          }
        }
      } finally {
        this.loopRunning = false;
        this.loopAbort = null;
        external?.removeEventListener("abort", onExternalAbort);
        this.log("info", "poll loop ended");
      }
    })();

    return {
      stop: async () => {
        controller.abort();
        // 等待循环真正退出（若已在退出，立刻 resolve）。
        await done.catch(() => {});
      },
      done: done.catch(() => {}),
    };
  }

  /** 计算退避等待（[M]：<3 次等 2s；达 3 次等 30s 并重置计数由调用方完成）。 */
  private computeBackoff(consecutiveFailures: number): number {
    return consecutiveFailures >= this.backoff.maxConsecutiveFailures
      ? this.backoff.backoffDelayMs
      : this.backoff.retryDelayMs;
  }

  /** 是否正在跑长轮询。 */
  isPolling(): boolean {
    return this.loopRunning;
  }

  /**
   * 优雅停止（[R] 2.7.6）：
   *   1. 先取消正在进行的 `getupdates` 长轮询；
   *   2. 等循环退出；
   *   3. 再用**独立短超时**调用 `notifystop`。
   */
  async shutdown(): Promise<void> {
    this.log("info", "shutdown: cancelling in-flight long poll");
    this.loopAbort?.abort();
    if (this.loopRunning) {
      // 给循环一点时间收敛（fetch 会因 abort 立刻 reject）。
      await sleep(50).catch(() => {});
    }
    // notifystop 使用独立超时，且不共享上面的 abort 信号。
    await this.notifyStop();
    this.log("info", "shutdown complete");
  }
}
