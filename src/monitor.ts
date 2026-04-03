import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import type {
  ResolvedTimbotAccount,
  TimbotInboundMessage,
  TimbotMsgBodyElement,
} from "./types.js";
import { getTimbotRuntime } from "./runtime.js";
import { LOG_PREFIX, logSimple } from "./logger.js";
import {
  extractMentionedBotAccounts,
  extractTextFromMsgBody,
  selectTimbotWebhookTarget,
} from "./inbound-routing.js";
import {
  allowsFinalTextRecovery,
  buildBotErrorPayload,
  buildBotStreamPayload,
  buildCustomMsgBody,
  buildStreamingMsgBody,
  buildTimStreamChunk,
  buildTimStreamMsgBody,
  buildTextMsgBody,
} from "./streaming-policy.js";
import type { TimbotTimStreamChunk } from "./streaming-policy.js";
import type { WsTransport, Message } from "./ws-transport.js";

export type TimbotRuntimeEnv = {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type TimbotWsTarget = {
  account: ResolvedTimbotAccount;
  config: OpenClawConfig;
  runtime: TimbotRuntimeEnv;
  core: PluginRuntime;
  transport: WsTransport;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const wsTargets = new Map<string, TimbotWsTarget[]>();

/** 带 target 上下文的日志 */
function log(target: TimbotWsTarget, level: "info" | "warn" | "error", message: string): void {
  const full = `${LOG_PREFIX} ${message}`;
  if (level === "error") {
    target.runtime.error?.(full);
  } else if (level === "warn") {
    (target.runtime.warn ?? target.runtime.log)?.(full);
  } else {
    target.runtime.log?.(full);
  }
}

/** verbose 日志 */
function logVerbose(target: TimbotWsTarget, message: string): void {
  const should = target.core.logging?.shouldLogVerbose?.() ?? false;
  if (should) {
    const full = `${LOG_PREFIX} ${message}`;
    target.runtime.log?.(full);
  }
}

function resolveOutboundSenderAccount(account: ResolvedTimbotAccount): string {
  return account.botAccount || account.identifier || "administrator";
}

const TIMBOT_PARTIAL_STREAM_THROTTLE_MS = 1000;
const TIMBOT_STREAM_SOFT_LIMIT_BYTES = 11 * 1024;
const TIMBOT_FINAL_TEXT_CHUNK_LIMIT = 3500;
const TIMBOT_OVERFLOW_NOTICE_TEXT = "内容较长，已停止发送剩余内容。";
const TIMBOT_MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const TIMBOT_MEDIA_MAX_FILES = 8;
const TIMBOT_MEDIA_FETCH_TIMEOUT_MS = 30_000;

function buildReplyRuntimeConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  disableBlockStreaming: boolean;
} {
  return {
    config,
    disableBlockStreaming: true,
  };
}

function mergeStreamingText(previousText: string | undefined, nextText: string | undefined): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }
  if (next.includes(previous)) {
    return next;
  }
  if (previous.includes(next)) {
    return previous;
  }

  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  return `${previous}${next}`;
}

function estimateMsgBodyBytes(msgBody: TimbotMsgBodyElement[]): number {
  return Buffer.byteLength(JSON.stringify(msgBody), "utf8");
}

function splitTextByFixedLength(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks;
}

function isMsgTooLongError(error: string | undefined): boolean {
  return /msg too long/i.test(error ?? "");
}

function resolveStreamingFinalText(streamVisibleText: string, streamFallbackText: string): string {
  if (!streamVisibleText) {
    return streamFallbackText;
  }
  if (!streamFallbackText) {
    return streamVisibleText;
  }
  if (
    streamFallbackText.startsWith(streamVisibleText)
    || streamFallbackText.includes(streamVisibleText)
  ) {
    return streamFallbackText;
  }
  if (
    streamVisibleText.startsWith(streamFallbackText)
    || streamVisibleText.includes(streamFallbackText)
  ) {
    return streamVisibleText;
  }
  return streamFallbackText.length > streamVisibleText.length
    ? streamFallbackText
    : streamVisibleText;
}

function buildSnapshotStreamingMsgBody(params: {
  useCustomStreaming: boolean;
  text: string;
  isFinished: 0 | 1;
  typingText?: string;
}): TimbotMsgBodyElement[] {
  return buildStreamingMsgBody({
    useCustomStreaming: params.useCustomStreaming,
    chunks: params.text ? [params.text] : [],
    isFinished: params.isFinished,
    typingText: params.typingText,
  });
}

function createPartialTextAccumulator() {
  const committedSegments: string[] = [];
  let currentPartialText = "";

  const commitCurrentPartial = () => {
    if (!currentPartialText) {
      return;
    }
    if (committedSegments.at(-1) !== currentPartialText) {
      committedSegments.push(currentPartialText);
    }
    currentPartialText = "";
  };

  const getVisibleText = () => {
    const segments = currentPartialText
      ? [...committedSegments, currentPartialText]
      : [...committedSegments];
    return segments.filter(Boolean).join("\n\n");
  };

  return {
    noteAssistantMessageStart: () => {
      commitCurrentPartial();
    },
    absorbPartial: (text: string) => {
      currentPartialText = mergeStreamingText(currentPartialText, text);
      return getVisibleText();
    },
    getVisibleText,
  };
}

type LatestTextThrottleLoop = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
  waitForInFlight: () => Promise<void>;
};

function createLatestTextThrottleLoop(params: {
  throttleMs: number;
  isStopped: () => boolean;
  sendLatestText: (text: string) => Promise<boolean>;
}): LatestTextThrottleLoop {
  let lastSentAt = 0;
  let pendingText = "";
  let inFlightPromise: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!params.isStopped()) {
      if (inFlightPromise) {
        await inFlightPromise;
        continue;
      }
      const text = pendingText;
      if (!text) {
        pendingText = "";
        return;
      }
      pendingText = "";
      const current = params.sendLatestText(text).finally(() => {
        if (inFlightPromise === current) {
          inFlightPromise = undefined;
        }
      });
      inFlightPromise = current;
      const sent = await current;
      if (sent === false) {
        if (!params.isStopped()) {
          pendingText = text;
        }
        return;
      }
      lastSentAt = Date.now();
      if (!pendingText) {
        return;
      }
    }
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, params.throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      void flush();
    }, delay);
  };

  return {
    update: (text: string) => {
      if (params.isStopped()) {
        return;
      }
      pendingText = text;
      if (inFlightPromise) {
        schedule();
        return;
      }
      if (!timer && Date.now() - lastSentAt >= params.throttleMs) {
        void flush();
        return;
      }
      schedule();
    },
    flush,
    stop: () => {
      pendingText = "";
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    waitForInFlight: async () => {
      if (inFlightPromise) {
        await inFlightPromise;
      }
    },
  };
}

function isStreamingEnabled(mode: ResolvedTimbotAccount["streamingMode"]): boolean {
  return mode !== "off";
}

function isCustomStreamingMode(mode: ResolvedTimbotAccount["streamingMode"]): boolean {
  return mode === "custom_modify";
}

function isTimStreamMode(mode: ResolvedTimbotAccount["streamingMode"]): boolean {
  return mode === "tim_stream";
}

// ============ 流式传输适配器 ============

/** 消息引用，用于后续 modifyMessage */
type StreamingMsgRef = { kind: "c2c"; message: Message } | { kind: "group"; message: Message };

type StreamingTransport = {
  label: string;
  sendStreamMsg: (params: {
    chunks: TimbotTimStreamChunk[];
    compatibleText?: string;
    streamMsgId?: string;
  }) => Promise<{ ok: boolean; streamMsgId?: string; error?: string }>;
  modifyMsg: (params: {
    ref: StreamingMsgRef;
    msgBody: TimbotMsgBodyElement[];
  }) => Promise<{ ok: boolean; error?: string }>;
  sendMsgBody: (params: {
    msgBody: TimbotMsgBodyElement[];
  }) => Promise<{ ok: boolean; ref?: StreamingMsgRef; error?: string }>;
  sendText: (params: {
    text: string;
  }) => Promise<{ ok: boolean; error?: string }>;
};

// ============ SDK 消息适配 ============

/** 从 SDK 图片消息 payload 中解析最大尺寸图片的 URL */
function resolveImageUrl(payload: any): string | undefined {
  // SDK payload.imageInfoArray: [{ sizeType, imageUrl, width, height, size }]
  // sizeType: 0=原图, 1=大图, 2=缩略图
  const imageInfoArray: any[] = payload?.imageInfoArray ?? [];
  if (imageInfoArray.length === 0) return undefined;

  // 优先原图(0) > 大图(1) > 缩略图(2)
  for (const sizeType of [0, 1, 2]) {
    const info = imageInfoArray.find((i: any) => i.sizeType === sizeType);
    if (info?.imageUrl || info?.url) return info.imageUrl ?? info.url;
  }
  // fallback: 取第一个有 URL 的
  const first = imageInfoArray.find((i: any) => i.imageUrl || i.url);
  return first?.imageUrl ?? first?.url;
}

/** 从 SDK 消息 payload 中提取媒体信息 */
export type InboundMediaInfo = {
  url: string;
  contentType?: string;
  fileName?: string;
  size?: number;
  placeholder: string;
};

function extractMediaInfoFromPayload(msgType: string, payload: any): InboundMediaInfo | undefined {
  if (!payload) return undefined;

  switch (msgType) {
    case "TIMImageElem": {
      const url = resolveImageUrl(payload);
      if (!url) return undefined;
      return {
        url,
        contentType: "image/jpeg", // SDK 默认，下载后会检测实际类型
        fileName: payload.fileName || undefined,
        size: payload.imageInfoArray?.[0]?.size,
        placeholder: "[image]",
      };
    }
    case "TIMFileElem": {
      const url = payload.fileUrl ?? payload.url;
      if (!url) return undefined;
      return {
        url,
        fileName: payload.fileName || undefined,
        size: payload.fileSize,
        placeholder: payload.fileName ? `[file: ${payload.fileName}]` : "[file]",
      };
    }
    case "TIMSoundElem":
    case "TIMAudioElem": {
      const url = payload.remoteAudioUrl ?? payload.url;
      if (!url) return undefined;
      return {
        url,
        contentType: "audio/mpeg",
        size: payload.size ?? payload.second,
        placeholder: "[voice]",
      };
    }
    case "TIMVideoFileElem": {
      const url = payload.remoteVideoUrl ?? payload.videoUrl ?? payload.url;
      if (!url) return undefined;
      return {
        url,
        contentType: "video/mp4",
        fileName: payload.videoName || undefined,
        size: payload.videoSize,
        placeholder: "[video]",
      };
    }
    default:
      return undefined;
  }
}

/** 将 SDK Message 转换为内部格式 */
function adaptSdkMessage(sdkMsg: Message): { msg: TimbotInboundMessage; mediaInfos: InboundMediaInfo[] } {
  const isGroup = sdkMsg.conversationType === "GROUP";
  const msgBody: TimbotMsgBodyElement[] = [];
  const mediaInfos: InboundMediaInfo[] = [];

  const msgType = sdkMsg.type as string;
  if (msgType === "TIMTextElem") {
    msgBody.push({
      MsgType: "TIMTextElem",
      MsgContent: { Text: sdkMsg.payload?.text ?? "" },
    });
  } else if (msgType === "TIMCustomElem") {
    msgBody.push({
      MsgType: "TIMCustomElem",
      MsgContent: {
        Data: sdkMsg.payload?.data ?? "",
        Desc: sdkMsg.payload?.description ?? "",
        Ext: sdkMsg.payload?.extension ?? "",
      },
    });
  } else if (msgType === "TIMImageElem") {
    msgBody.push({ MsgType: "TIMImageElem", MsgContent: {} });
    const media = extractMediaInfoFromPayload("TIMImageElem", sdkMsg.payload);
    if (media) mediaInfos.push(media);
  } else if (msgType === "TIMSoundElem") {
    msgBody.push({ MsgType: "TIMSoundElem", MsgContent: {} });
    const media = extractMediaInfoFromPayload("TIMSoundElem", sdkMsg.payload);
    if (media) mediaInfos.push(media);
  } else if (msgType === "TIMFileElem") {
    msgBody.push({ MsgType: "TIMFileElem", MsgContent: {} });
    const media = extractMediaInfoFromPayload("TIMFileElem", sdkMsg.payload);
    if (media) mediaInfos.push(media);
  } else if (msgType === "TIMVideoFileElem") {
    msgBody.push({ MsgType: "TIMVideoFileElem", MsgContent: {} });
    const media = extractMediaInfoFromPayload("TIMVideoFileElem", sdkMsg.payload);
    if (media) mediaInfos.push(media);
  } else if (msgType === "TIMFaceElem") {
    msgBody.push({ MsgType: "TIMFaceElem", MsgContent: {} });
  } else if (msgType === "TIMLocationElem") {
    msgBody.push({ MsgType: "TIMLocationElem", MsgContent: {} });
  } else {
    msgBody.push({ MsgType: msgType || "TIMUnknownElem", MsgContent: {} });
  }

  let groupId: string | undefined;
  if (isGroup) {
    groupId = sdkMsg.to;
  }

  const atRobots: string[] = [];
  if (Array.isArray(sdkMsg.atUserList) && sdkMsg.atUserList.length > 0) {
    atRobots.push(...sdkMsg.atUserList);
  }

  return {
    msg: {
      CallbackCommand: isGroup ? "Bot.OnGroupMessage" : "Bot.OnC2CMessage",
      From_Account: sdkMsg.from,
      To_Account: sdkMsg.to,
      AtRobots_Account: atRobots.length > 0 ? atRobots : undefined,
      GroupId: groupId,
      MsgSeq: undefined,
      MsgRandom: undefined,
      MsgTime: sdkMsg.time,
      MsgKey: sdkMsg.ID,
      MsgBody: msgBody,
      CloudCustomData: sdkMsg.cloudCustomData || undefined,
    },
    mediaInfos,
  };
}

// ============ 入站媒体处理 ============

type ResolvedMedia = {
  path: string;
  contentType?: string;
  placeholder: string;
};

/**
 * 下载并保存入站媒体文件到 OpenClaw 媒体存储。
 * 
 * 流程：
 * 1. 从 SDK payload 中获取 COS URL
 * 2. 通过 core.channel.media.fetchRemoteMedia() 下载（带 SSRF 防护）
 * 3. 通过 core.channel.media.saveMediaBuffer() 保存到磁盘
 * 4. 返回本地路径、MIME 类型供 inbound context 使用
 */
async function resolveInboundMedia(params: {
  mediaInfos: InboundMediaInfo[];
  core: PluginRuntime;
  target: TimbotWsTarget;
}): Promise<ResolvedMedia[]> {
  const { mediaInfos, core, target } = params;
  if (mediaInfos.length === 0) return [];

  const limited = mediaInfos.slice(0, TIMBOT_MEDIA_MAX_FILES);
  const results: ResolvedMedia[] = [];

  for (const info of limited) {
    try {
      // 验证 URL 合法性
      const parsed = new URL(info.url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        log(target, "warn", `skip media with non-HTTP URL: ${parsed.protocol}`);
        continue;
      }

      logVerbose(target, `downloading media: type=${info.placeholder}, url=${info.url.slice(0, 80)}...`);

      // Step 1: 下载远程媒体
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: info.url,
        maxBytes: TIMBOT_MEDIA_MAX_BYTES,
        filePathHint: info.fileName,
        readIdleTimeoutMs: TIMBOT_MEDIA_FETCH_TIMEOUT_MS,
      });

      if (fetched.buffer.byteLength > TIMBOT_MEDIA_MAX_BYTES) {
        log(target, "warn", `media too large (${(fetched.buffer.byteLength / 1024 / 1024).toFixed(1)}MB), skip`);
        continue;
      }

      // Step 2: 保存到本地
      const effectiveMime = info.contentType ?? fetched.contentType;
      const saved = await core.channel.media.saveMediaBuffer(
        fetched.buffer,
        effectiveMime,
        "inbound",
        TIMBOT_MEDIA_MAX_BYTES,
        info.fileName,
      );

      logVerbose(target, `media saved: path=${saved.path}, contentType=${saved.contentType}, size=${fetched.buffer.byteLength}`);

      results.push({
        path: saved.path,
        contentType: effectiveMime ?? saved.contentType,
        placeholder: info.placeholder,
      });
    } catch (err) {
      log(target, "warn", `media download/save failed: ${String(err)}`);
      // 跳过失败的媒体，继续处理其他
    }
  }

  return results;
}

// ============ WS 消息处理 ============

/**
 * handleWsMessage 处理 SDK 收到的消息
 */
export function handleWsMessage(params: {
  messageList: Message[];
  target: TimbotWsTarget;
}): void {
  const { messageList, target } = params;
  const outboundSender = resolveOutboundSenderAccount(target.account);

  log(target, "info", `received ${messageList.length} message(s)`);
  for (const m of messageList) {
    log(target, "info", `msg: flow=${m.flow}, type=${m.type}, conv=${m.conversationType}, from=${m.from}, to=${m.to}`);
  }

  for (const sdkMsg of messageList) {
    // 只处理入站消息
    if (sdkMsg.flow !== "in") {
      continue;
    }

    // 过滤自身消息
    if (sdkMsg.from === outboundSender || sdkMsg.from === target.account.identifier) {
      continue;
    }

    // 过滤登录前的历史消息
    if (sdkMsg.time < target.transport.loginTime) {
      logVerbose(target, `skip history: msgId=${sdkMsg.ID}, time=${sdkMsg.time}, loginTime=${target.transport.loginTime}`);
      continue;
    }

    const { msg, mediaInfos } = adaptSdkMessage(sdkMsg);

    target.statusSink?.({ lastInboundAt: Date.now() });

    const isGroup = sdkMsg.conversationType === "GROUP";
    const isC2C = sdkMsg.conversationType === "C2C";

    if (!isC2C && !isGroup) {
      logVerbose(target, `skip non-C2C/GROUP: conversationType=${sdkMsg.conversationType}`);
      continue;
    }

    // 获取运行时
    let core: PluginRuntime | null = null;
    try {
      core = getTimbotRuntime();
    } catch (err) {
      logSimple("error", `runtime not ready: ${String(err)}`);
      continue;
    }

    if (!core) continue;

    const enrichedTarget: TimbotWsTarget = { ...target, core };

    if (isGroup) {
      // 检查是否 @了机器人
      const botAccount = target.account.botAccount;
      const rawBody = extractTextFromMsgBody(msg.MsgBody);
      const mentionedAccounts = [
        ...(msg.AtRobots_Account ?? []),
        ...extractMentionedBotAccounts(rawBody),
      ];
      const normalizedBotAccount = botAccount?.replace(/^＠/u, "@").toLowerCase();
      const wasMentioned = mentionedAccounts.some(
        (m) => m.replace(/^＠/u, "@").toLowerCase() === normalizedBotAccount,
      );

      // 也检查 atUserList
      const wasMentionedByAtList = Array.isArray(sdkMsg.atUserList) && (
        sdkMsg.atUserList.includes(target.account.botAccount ?? "") ||
        sdkMsg.atUserList.includes(target.account.identifier ?? "")
      );

      if (!wasMentioned && !wasMentionedByAtList) {
        logVerbose(target, `group msg not mentioned, skip: group=${msg.GroupId}, from=${msg.From_Account}`);
        continue;
      }

      processGroupAndReply({ target: enrichedTarget, msg, mediaInfos }).catch((err) => {
        target.runtime.error?.(`[${target.account.accountId}] timbot group agent failed: ${String(err)}`);
      });
    } else {
      processAndReply({ target: enrichedTarget, msg, mediaInfos }).catch((err) => {
        target.runtime.error?.(`[${target.account.accountId}] timbot agent failed: ${String(err)}`);
      });
    }
  }
}

// ============ 公共流式回复逻辑 ============

async function executeStreamingReply(params: {
  transport: StreamingTransport;
  target: TimbotWsTarget;
  account: ResolvedTimbotAccount;
  core: PluginRuntime;
  config: OpenClawConfig;
  ctxPayload: Record<string, unknown>;
  replyRuntime: { config: OpenClawConfig; disableBlockStreaming: boolean };
  tableMode: string;
  splitFinalText: (text: string) => string[];
  streamingMode: ResolvedTimbotAccount["streamingMode"];
  fallbackPolicy: ResolvedTimbotAccount["fallbackPolicy"];
  overflowPolicy: ResolvedTimbotAccount["overflowPolicy"];
  useStreaming: boolean;
  useCustomStreaming: boolean;
  useTimStream: boolean;
  typingText: string;
  hasTypingText: boolean;
}): Promise<void> {
  const {
    transport,
    target,
    account,
    core,
    replyRuntime,
    tableMode,
    splitFinalText,
    streamingMode,
    fallbackPolicy,
    overflowPolicy,
    useStreaming,
    useCustomStreaming,
    useTimStream,
    typingText,
    hasTypingText,
    ctxPayload,
  } = params;

  const L = transport.label;

  logVerbose(
    target,
    `${L}reply streaming path: ${useStreaming ? `partial (throttleMs=${TIMBOT_PARTIAL_STREAM_THROTTLE_MS})` : "final-only"} (streamingMode=${account.streamingMode}, fallbackPolicy=${fallbackPolicy}, overflowPolicy=${overflowPolicy})`,
  );

  let streamMsgRef: StreamingMsgRef | undefined;
  let timStreamMsgId: string | undefined;
  let timStreamNextChunkIndex = 1;
  let timStreamClosed = false;
  let streamFailed = !useStreaming;
  let streamFailureReason: string | undefined;
  let streamOverflowed = false;
  let lastSentVisibleText = "";
  const partialTextAccumulator = createPartialTextAccumulator();
  const streamFallbackTexts: string[] = [];

  let typingMsgRef: StreamingMsgRef | undefined;
  const collectedTexts: string[] = [];
  let assistantMessageStartCount = 0;
  let assistantMessageStartAt: number | undefined;
  let partialReplyCount = 0;
  let firstPartialReplyAt: number | undefined;

  const buildTimStreamRequest = (params: {
    markdown: string;
    isLast: boolean;
    compatibleText?: string;
    streamMsgId?: string;
  }): { chunks: TimbotTimStreamChunk[]; compatibleText?: string; streamMsgId?: string } => ({
    chunks: [
      buildTimStreamChunk({
        index: timStreamNextChunkIndex,
        markdown: params.markdown,
        isLast: params.isLast,
      }),
    ],
    compatibleText: params.compatibleText,
    streamMsgId: params.streamMsgId,
  });

  const estimateTimStreamMsgBodyBytes = (params: {
    markdown: string;
    isLast: boolean;
    compatibleText?: string;
    streamMsgId?: string;
  }): number =>
    estimateMsgBodyBytes(
      buildTimStreamMsgBody(buildTimStreamRequest(params)),
    );

  const resolveTimStreamDelta = (nextText: string): string | undefined => {
    if (!timStreamMsgId || !lastSentVisibleText) {
      return nextText;
    }
    return nextText.startsWith(lastSentVisibleText)
      ? nextText.slice(lastSentVisibleText.length)
      : undefined;
  };

  const sendTimStreamChunk = async (params: {
    markdown: string;
    isLast: boolean;
    compatibleText?: string;
  }): Promise<{ ok: boolean; error?: string }> => {
    const result = await transport.sendStreamMsg(
      buildTimStreamRequest({
        markdown: params.markdown,
        isLast: params.isLast,
        compatibleText: params.compatibleText,
        streamMsgId: timStreamMsgId,
      }),
    );
    if (result.ok && (timStreamMsgId || result.streamMsgId)) {
      timStreamMsgId = result.streamMsgId ?? timStreamMsgId;
      timStreamNextChunkIndex += 1;
      timStreamClosed = params.isLast;
      return { ok: true };
    }
    return {
      ok: false,
      error:
        result.error
        || (timStreamMsgId ? `${L}流式消息更新失败` : `${L}流式消息未返回 StreamMsgID`),
    };
  };

  const closeTimStream = async (compatibleText: string): Promise<boolean> => {
    if (!timStreamMsgId || timStreamClosed) {
      return true;
    }
    const result = await sendTimStreamChunk({
      markdown: "",
      isLast: true,
      compatibleText,
    });
    return result.ok;
  };

  const sendChunkedFinalText = async (text: string): Promise<boolean> => {
    const chunks = splitFinalText(text).filter((chunk) => chunk.length > 0);
    if (chunks.length === 0) {
      return false;
    }

    if (useTimStream && timStreamMsgId) {
      const closed = await closeTimStream(lastSentVisibleText || typingText);
      if (closed) {
        target.statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        log(target, "warn", `${L}长消息流式收尾失败，继续分段发送`);
      }
    }

    let startIndex = 0;
    if (!useTimStream && streamMsgRef) {
      const firstChunk = chunks[0];
      const firstResult = await transport.modifyMsg({
        ref: streamMsgRef,
        msgBody: buildTextMsgBody(firstChunk),
      });
      if (firstResult.ok) {
        target.statusSink?.({ lastOutboundAt: Date.now() });
        startIndex = 1;
      } else {
        log(target, "warn", `${L}长消息首段修改失败，改为新消息发送: ${firstResult.error}`);
      }
    }

    for (const chunk of chunks.slice(startIndex)) {
      const result = await transport.sendText({ text: chunk });
      if (!result.ok) {
        streamFailureReason = result.error || streamFailureReason || `${L}长消息分段发送失败`;
        return false;
      }
      target.statusSink?.({ lastOutboundAt: Date.now() });
    }

    return true;
  };

  const sendOverflowNotice = async (): Promise<boolean> => {
    if (useTimStream && timStreamMsgId) {
      const closed = await closeTimStream(lastSentVisibleText || typingText);
      if (closed) {
        target.statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        log(target, "warn", `${L}超限后流式收尾失败`);
      }
    } else if (streamMsgRef && !lastSentVisibleText) {
      const replaceResult = await transport.modifyMsg({
        ref: streamMsgRef,
        msgBody: buildTextMsgBody(TIMBOT_OVERFLOW_NOTICE_TEXT),
      });
      if (replaceResult.ok) {
        target.statusSink?.({ lastOutboundAt: Date.now() });
        return true;
      }
      log(target, "warn", `${L}超限提示覆盖占位消息失败: ${replaceResult.error}`);
    } else if (useCustomStreaming && streamMsgRef && lastSentVisibleText) {
      const finalizeResult = await transport.modifyMsg({
        ref: streamMsgRef,
        msgBody: buildSnapshotStreamingMsgBody({
          useCustomStreaming: true,
          text: lastSentVisibleText,
          isFinished: 1,
          typingText,
        }),
      });
      if (finalizeResult.ok) {
        target.statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        log(target, "warn", `${L}超限后 custom_modify 收尾失败: ${finalizeResult.error}`);
      }
    }

    const noticeResult = await transport.sendText({ text: TIMBOT_OVERFLOW_NOTICE_TEXT });
    if (noticeResult.ok) {
      target.statusSink?.({ lastOutboundAt: Date.now() });
      return true;
    }
    log(target, "warn", `${L}超限提示发送失败: ${noticeResult.error}`);
    return false;
  };

  const streamLoop = useStreaming
    ? createLatestTextThrottleLoop({
        throttleMs: TIMBOT_PARTIAL_STREAM_THROTTLE_MS,
        isStopped: () => streamFailed,
        sendLatestText: async (visibleText) => {
          if (!visibleText.trim() || visibleText === lastSentVisibleText) {
            return true;
          }

          if (useTimStream) {
            if (lastSentVisibleText && !visibleText.startsWith(lastSentVisibleText)) {
              streamFailureReason = `${L}流式快照与已发送文本不连续，停止 TIM stream 增量更新`;
              log(target, "warn", streamFailureReason);
              streamFailed = true;
              return false;
            }

            const deltaText = resolveTimStreamDelta(visibleText);
            if (deltaText == null) {
              streamFailureReason = `${L}流式快照与已发送文本不连续，停止 TIM stream 增量更新`;
              log(target, "warn", streamFailureReason);
              streamFailed = true;
              return false;
            }
            if (!deltaText) {
              return true;
            }
            const estimatedBytes = estimateTimStreamMsgBodyBytes({
              markdown: deltaText,
              isLast: false,
              compatibleText: visibleText,
              streamMsgId: timStreamMsgId,
            });
            if (estimatedBytes > TIMBOT_STREAM_SOFT_LIMIT_BYTES) {
              streamOverflowed = true;
              streamFailureReason = `${L}流式消息接近长度上限，停止增量更新并改为最终分段发送 (bytes=${estimatedBytes})`;
              log(target, "warn", streamFailureReason);
              streamFailed = true;
              return false;
            }

            const result = await sendTimStreamChunk({
              markdown: deltaText,
              isLast: false,
              compatibleText: visibleText,
            });

            if (result.ok) {
              lastSentVisibleText = visibleText;
              target.statusSink?.({ lastOutboundAt: Date.now() });
              return true;
            }

            streamFailureReason =
              result.error
              || streamFailureReason
              || (timStreamMsgId ? `${L}流式消息更新失败` : `${L}流式消息未返回 StreamMsgID`);
            if (isMsgTooLongError(result.error)) {
              streamOverflowed = true;
            }
            log(target, "warn", `${L}流式消息发送失败，等待最终收尾: ${streamFailureReason}`);
            streamFailed = true;
            return false;
          }

          const msgBody = buildSnapshotStreamingMsgBody({
            useCustomStreaming,
            text: visibleText,
            isFinished: 0,
            typingText,
          });
          const estimatedBytes = estimateMsgBodyBytes(msgBody);
          if (estimatedBytes > TIMBOT_STREAM_SOFT_LIMIT_BYTES) {
            streamOverflowed = true;
            streamFailureReason = `${L}流式消息接近长度上限，停止 modify 并改为最终分段发送 (bytes=${estimatedBytes})`;
            log(target, "warn", streamFailureReason);
            streamFailed = true;
            return false;
          }

          if (streamMsgRef) {
            const result = await transport.modifyMsg({
              ref: streamMsgRef,
              msgBody,
            });

            if (result.ok) {
              lastSentVisibleText = visibleText;
              target.statusSink?.({ lastOutboundAt: Date.now() });
              return true;
            }

            streamFailureReason = result.error || streamFailureReason || `${L}流式消息更新失败`;
            if (isMsgTooLongError(result.error)) {
              streamOverflowed = true;
            }
            log(target, "warn", `${L}流式消息更新失败，等待最终收尾: ${streamFailureReason}`);
            streamFailed = true;
            return false;
          }

          const result = await transport.sendMsgBody({ msgBody });

          if (result.ok && result.ref) {
            streamMsgRef = result.ref;
            lastSentVisibleText = visibleText;
            target.statusSink?.({ lastOutboundAt: Date.now() });
            return true;
          }

          streamFailureReason = result.error || streamFailureReason || `${L}流式消息创建失败`;
          if (isMsgTooLongError(result.error)) {
            streamOverflowed = true;
          }
          log(target, "warn", `${L}流式消息创建失败，等待最终收尾: ${streamFailureReason}`);
          streamFailed = true;
          return false;
        },
      })
    : undefined;

  // 延迟 1s 发送, 避免消息乱序
  if (hasTypingText) {
    const typingDelayMs = account.config.typingDelayMs ?? 1000;
    if (typingDelayMs > 0) {
      logVerbose(target, `${L}延迟 ${typingDelayMs}ms 发送 typingText`);
      await new Promise(resolve => setTimeout(resolve, typingDelayMs));
    }
  }

  // typingText 发送
  if (useStreaming && hasTypingText) {
    if (useTimStream) {
      const typingResult = await sendTimStreamChunk({
        markdown: "",
        isLast: false,
        compatibleText: typingText,
      });
      if (typingResult.ok && timStreamMsgId) {
        target.statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        log(target, "warn", `${L}流式 typingText 发送失败，首块文本到达时再创建消息: ${typingResult.error || "未返回 StreamMsgID"}`);
      }
    } else {
      const typingMsgBody = useCustomStreaming
        ? buildCustomMsgBody(buildBotStreamPayload([], 0, typingText))
        : buildTextMsgBody(typingText);
      const typingResult = await transport.sendMsgBody({ msgBody: typingMsgBody });
      if (typingResult.ok && typingResult.ref) {
        streamMsgRef = typingResult.ref;
        target.statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        log(target, "warn", `${L}流式 typingText 发送失败，首块文本到达时再创建消息: ${typingResult.error}`);
      }
    }
  } else if (!useStreaming && hasTypingText) {
    const typingResult = await transport.sendMsgBody({ msgBody: buildTextMsgBody(typingText) });
    if (typingResult.ok && typingResult.ref) {
      typingMsgRef = typingResult.ref;
    }
  }

  // dispatch 回复
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: replyRuntime.config,
    replyOptions: {
      disableBlockStreaming: replyRuntime.disableBlockStreaming,
      onAssistantMessageStart: useStreaming
        ? () => {
            assistantMessageStartCount += 1;
            assistantMessageStartAt ??= Date.now();
            partialTextAccumulator.noteAssistantMessageStart();
          }
        : undefined,
      onPartialReply: useStreaming
        ? (payload: { text?: string }) => {
            const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
            if (!text) {
              return;
            }
            partialReplyCount += 1;
            firstPartialReplyAt ??= Date.now();
            const visibleText = partialTextAccumulator.absorbPartial(text);
            logVerbose(
              target,
              `[partialStream] ${L}snapshot: partialLen=${text.length}, visibleLen=${visibleText.length}, trimEmpty=${!visibleText.trim()}, streamFailed=${streamFailed}, t=${Date.now()}`,
            );
            if (!visibleText.trim()) {
              return;
            }
            streamLoop?.update(visibleText);
          }
        : undefined,
    },
    dispatcherOptions: {
      deliver: async (payload: { text?: string }, info: { kind: string }) => {
        const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
        if (useStreaming) {
          logVerbose(
            target,
            `[partialStream] ${L}dispatcher deliver kind=${info.kind}: len=${text.length}, trimEmpty=${!text.trim()}, streamFailed=${streamFailed}, t=${Date.now()}`,
          );
          if (text.trim()) {
            streamFallbackTexts.push(text);
          }
          return;
        }

        if (!text.trim()) {
          return;
        }

        if (typingMsgRef) {
          collectedTexts.push(text);
          return;
        }

        const result = await transport.sendText({ text });
        if (!result.ok) {
          target.runtime.error?.(`[${account.accountId}] timbot ${L}send failed: ${result.error}`);
        } else {
          target.statusSink?.({ lastOutboundAt: Date.now() });
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        target.runtime.error?.(`[${account.accountId}] timbot ${L}${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  // 流式收尾
  if (useStreaming) {
    await streamLoop?.flush();
    streamLoop?.stop();
    await streamLoop?.waitForInFlight();
  }

  const streamFallbackText = streamFallbackTexts.join("\n\n");
  const streamVisibleText = partialTextAccumulator.getVisibleText();
  const firstPartialLatencyMs =
    assistantMessageStartAt != null && firstPartialReplyAt != null
      ? Math.max(0, firstPartialReplyAt - assistantMessageStartAt)
      : undefined;

  if (useStreaming) {
    logVerbose(
      target,
      `[partialStream] ${L}summary: assistantStarts=${assistantMessageStartCount}, partialCount=${partialReplyCount}, firstPartialLatencyMs=${firstPartialLatencyMs ?? "n/a"}, visibleLen=${streamVisibleText.length}, fallbackLen=${streamFallbackText.length}, streamFailed=${streamFailed}, overflowed=${streamOverflowed}, t=${Date.now()}`,
    );
  }

  if (
    useStreaming
    && (
      (useTimStream && (timStreamMsgId || streamVisibleText || streamFallbackText))
      || (!useTimStream && (streamMsgRef || streamVisibleText || streamFallbackText))
    )
  ) {
    const fullText = resolveStreamingFinalText(streamVisibleText, streamFallbackText);
    if (assistantMessageStartCount > 0 && partialReplyCount === 0 && fullText.trim()) {
      log(
        target,
        "warn",
        `${L}上游模型未产出可见 partial 文本，本次回复没有中间流式更新，将表现为「占位消息 + 最终收尾」(assistantStarts=${assistantMessageStartCount}, finalTextLen=${fullText.length})。如需确认，请开启 --raw-stream 并检查是否存在 assistant_text_stream/text_delta。`,
      );
    }
    let finalized = false;
    let overflowStopHandled = false;
    const handleOverflow = async (): Promise<boolean> => {
      if (overflowPolicy === "split" && fullText) {
        return sendChunkedFinalText(fullText);
      }
      overflowStopHandled = true;
      return sendOverflowNotice();
    };
    const finalSnapshotMsgBody = !useTimStream
      ? buildSnapshotStreamingMsgBody({
          useCustomStreaming,
          text: fullText,
          isFinished: 1,
          typingText,
        })
      : undefined;
    const finalTimStreamDelta = useTimStream ? resolveTimStreamDelta(fullText) : undefined;
    const finalTimStreamMsgBody = useTimStream
      && finalTimStreamDelta != null
      ? buildTimStreamMsgBody(
          buildTimStreamRequest({
            markdown: finalTimStreamDelta,
            isLast: true,
            compatibleText: fullText || typingText,
            streamMsgId: timStreamMsgId,
          }),
        )
      : undefined;
    if (streamOverflowed && overflowPolicy === "stop") {
      overflowStopHandled = true;
      finalized = await sendOverflowNotice();
    }

    const shouldUseChunkedFinalText = overflowPolicy === "split" && Boolean(fullText) && (
      streamOverflowed
      || (
        useTimStream
          ? estimateMsgBodyBytes(finalTimStreamMsgBody ?? []) > TIMBOT_STREAM_SOFT_LIMIT_BYTES
          : estimateMsgBodyBytes(finalSnapshotMsgBody ?? []) > TIMBOT_STREAM_SOFT_LIMIT_BYTES
      )
    );

    if (!overflowStopHandled && shouldUseChunkedFinalText && fullText) {
      finalized = await sendChunkedFinalText(fullText);
    }

    if (!overflowStopHandled && !finalized && useTimStream) {
      const compatibleFinalText = fullText || typingText;
      if (finalTimStreamDelta == null) {
        streamFailureReason = `${L}流式消息最终文本与已发送内容不连续，无法继续 TIM stream 收尾`;
        log(target, "warn", streamFailureReason);
      } else if (timStreamMsgId) {
        const finalResult = await sendTimStreamChunk({
          markdown: finalTimStreamDelta,
          isLast: true,
          compatibleText: compatibleFinalText,
        });
        if (finalResult.ok) {
          finalized = true;
          target.statusSink?.({ lastOutboundAt: Date.now() });
        } else {
          streamFailureReason = finalResult.error || streamFailureReason || `${L}流式消息最终收尾失败`;
          if (isMsgTooLongError(finalResult.error)) {
            streamOverflowed = true;
            finalized = await handleOverflow();
          }
          if (!finalized) {
            log(target, "warn", `${L}流式消息最终收尾失败: ${streamFailureReason}`);
          }
        }
      } else if (fullText) {
        const startResult = await sendTimStreamChunk({
          markdown: fullText,
          isLast: true,
          compatibleText: fullText,
        });
        if (startResult.ok) {
          finalized = true;
          target.statusSink?.({ lastOutboundAt: Date.now() });
        } else {
          streamFailureReason = startResult.error || streamFailureReason || `${L}流式消息未返回 StreamMsgID`;
          if (isMsgTooLongError(startResult.error)) {
            streamOverflowed = true;
            finalized = await handleOverflow();
          }
          if (!finalized) {
            log(target, "warn", `${L}流式消息最终发送失败: ${streamFailureReason}`);
          }
        }
      }
    } else if (!overflowStopHandled && !finalized) {
      const finalMsgBody = finalSnapshotMsgBody ?? buildSnapshotStreamingMsgBody({
        useCustomStreaming,
        text: fullText,
        isFinished: 1,
        typingText,
      });

      if (streamMsgRef) {
        const finalResult = await transport.modifyMsg({
          ref: streamMsgRef,
          msgBody: finalMsgBody,
        });
        if (finalResult.ok) {
          finalized = true;
          target.statusSink?.({ lastOutboundAt: Date.now() });
        } else {
          streamFailureReason = finalResult.error || streamFailureReason || `${L}流式消息最终收尾失败`;
          if (isMsgTooLongError(finalResult.error)) {
            streamOverflowed = true;
            finalized = await handleOverflow();
          }
          if (!finalized) {
            log(target, "warn", `${L}流式消息最终收尾失败: ${streamFailureReason}`);
          }
        }
      } else if (fullText) {
        const finalSendResult = await transport.sendMsgBody({ msgBody: finalMsgBody });
        if (finalSendResult.ok && finalSendResult.ref) {
          streamMsgRef = finalSendResult.ref;
          finalized = true;
          target.statusSink?.({ lastOutboundAt: Date.now() });
        } else {
          streamFailureReason = finalSendResult.error || streamFailureReason || `${L}流式消息最终发送失败`;
          if (isMsgTooLongError(finalSendResult.error)) {
            streamOverflowed = true;
            finalized = await handleOverflow();
          }
          if (!finalized) {
            log(target, "warn", `${L}流式消息最终发送失败: ${streamFailureReason}`);
          }
        }
      }
    }

    if (!overflowStopHandled && !finalized && fullText && allowsFinalTextRecovery({ streamingMode, fallbackPolicy })) {
      let recovered = false;

      if (streamMsgRef && useCustomStreaming) {
        const recoverResult = await transport.modifyMsg({
          ref: streamMsgRef,
          msgBody: buildTextMsgBody(fullText),
        });
        if (recoverResult.ok) {
          recovered = true;
          target.statusSink?.({ lastOutboundAt: Date.now() });
        } else {
          streamFailureReason = recoverResult.error || streamFailureReason || `${L}流式消息文本恢复失败`;
          log(target, "warn", `${L}流式消息文本恢复失败: ${streamFailureReason}`);
        }
      }

      if (!recovered) {
        if (streamOverflowed) {
          finalized = await handleOverflow();
        } else {
          const fallbackResult = await transport.sendText({ text: fullText });
          if (fallbackResult.ok) {
            finalized = true;
            target.statusSink?.({ lastOutboundAt: Date.now() });
          } else {
            streamFailureReason = fallbackResult.error || streamFailureReason || `${L}流式消息文本兜底失败`;
            if (isMsgTooLongError(fallbackResult.error)) {
              streamOverflowed = true;
              finalized = await handleOverflow();
            }
            if (!finalized) {
              log(target, "warn", `${L}流式消息文本兜底失败: ${streamFailureReason}`);
            }
          }
        }
      } else {
        finalized = true;
      }
    }

    if (!overflowStopHandled && !finalized && !streamOverflowed && useCustomStreaming && streamMsgRef) {
      const errorResult = await transport.modifyMsg({
        ref: streamMsgRef,
        msgBody: buildCustomMsgBody(buildBotErrorPayload(streamFailureReason || "流式消息处理失败")),
      });
      if (errorResult.ok) {
        target.statusSink?.({ lastOutboundAt: Date.now() });
      } else {
        log(target, "warn", `${L}流式错误状态更新失败: ${errorResult.error}`);
      }
    }
  }

  // typingText 占位消息修改为实际回复
  if (typingMsgRef && collectedTexts.length > 0) {
    const fullText = collectedTexts.join("\n\n");
    const modResult = await transport.modifyMsg({
      ref: typingMsgRef,
      msgBody: buildTextMsgBody(fullText),
    });
    if (!modResult.ok) {
      log(target, "warn", `${L}typingText 消息修改失败，发送新消息: ${modResult.error}`);
      await transport.sendText({ text: fullText });
    }
    target.statusSink?.({ lastOutboundAt: Date.now() });
  }
}

// ============ C2C 消息处理与回复 ============

async function processAndReply(params: {
  target: TimbotWsTarget;
  msg: TimbotInboundMessage;
  mediaInfos: InboundMediaInfo[];
}): Promise<void> {
  const { target, msg, mediaInfos } = params;
  const core = target.core;
  const config = target.config;
  const account = target.account;
  const wsTransport = target.transport;

  const fromAccount = msg.From_Account?.trim() || "unknown";
  const outboundSender = resolveOutboundSenderAccount(account);

  if (fromAccount === outboundSender) {
    log(target, "info", `skip self message <- ${fromAccount}`);
    return;
  }

  const rawBody = extractTextFromMsgBody(msg.MsgBody);

  log(target, "info", `C2C message <- ${fromAccount}, msgKey=${msg.MsgKey}${mediaInfos.length > 0 ? `, media=${mediaInfos.length}` : ""}`);
  logVerbose(target, `content: ${rawBody.slice(0, 200)}${rawBody.length > 200 ? "..." : ""}`);

  // 如果既没有文本也没有媒体，跳过
  if (!rawBody.trim() && mediaInfos.length === 0) {
    log(target, "warn", "empty message (no text, no media), skip");
    return;
  }

  // 过滤占位符消息，但保留 TUIEmoji 表情；有媒体的消息不过滤
  if (mediaInfos.length === 0 && /^\[.+\]$/.test(rawBody.trim()) && !/^\[TUIEmoji_/i.test(rawBody.trim())) {
    logVerbose(target, `placeholder message, skip: ${rawBody} (from: ${fromAccount})`);
    return;
  }

  logVerbose(target, `processing, account=${account.accountId}`);

  // 下载并保存媒体
  let resolvedMedia: ResolvedMedia[] = [];
  if (mediaInfos.length > 0) {
    resolvedMedia = await resolveInboundMedia({ mediaInfos, core, target });
    logVerbose(target, `resolved media: ${resolvedMedia.length}/${mediaInfos.length} saved`);
  }

  // 构建 Body 文本：文本 + 媒体占位符
  const bodyParts: string[] = [];
  if (rawBody.trim()) bodyParts.push(rawBody);
  for (const media of resolvedMedia) {
    bodyParts.push(media.placeholder);
  }
  const effectiveBody = bodyParts.join("\n");
  const effectiveRawBody = effectiveBody;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "timbot-ws",
    accountId: account.accountId,
    peer: { kind: "dm", id: fromAccount },
  });

  logVerbose(target, `route: agentId=${route.agentId}`);

  const fromLabel = `user:${fromAccount}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "TIMBOT",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: effectiveBody,
  });

  // 构建 media 字段
  const firstMedia = resolvedMedia[0];

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: effectiveRawBody,
    CommandBody: effectiveRawBody,
    From: `timbot:${fromAccount}`,
    To: `timbot:${account.botAccount || msg.To_Account || "bot"}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderName: fromAccount,
    SenderId: fromAccount,
    Provider: "timbot-ws",
    Surface: "timbot-ws",
    MessageSid: msg.MsgKey,
    OriginatingChannel: "timbot-ws",
    OriginatingTo: `timbot:${fromAccount}`,
    // Media fields
    MediaPath: firstMedia?.path,
    MediaType: firstMedia?.contentType,
    MediaUrl: firstMedia?.path,
    MediaPaths: resolvedMedia.length > 0 ? resolvedMedia.map((m) => m.path) : undefined,
    MediaUrls: resolvedMedia.length > 0 ? resolvedMedia.map((m) => m.path) : undefined,
    MediaTypes: resolvedMedia.length > 0 ? resolvedMedia.map((m) => m.contentType ?? "") : undefined,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`timbot: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "timbot-ws",
    accountId: account.accountId,
  });
  const finalTextChunkLimit = core.channel.text.resolveTextChunkLimit(config, "timbot-ws", account.accountId, {
    fallbackLimit: TIMBOT_FINAL_TEXT_CHUNK_LIMIT,
  });
  const splitFinalText = (text: string) => splitTextByFixedLength(text, finalTextChunkLimit);

  logVerbose(target, `generating reply -> ${fromAccount}`);
  logVerbose(target, `dispatch: sessionKey=${ctxPayload.SessionKey}, from=${ctxPayload.From}`);

  const transport: StreamingTransport = {
    label: "",
    sendStreamMsg: async (_p) => {
      return { ok: false, error: "tim_stream not supported via SDK WebSocket" };
    },
    modifyMsg: async (p) => {
      const ref = p.ref as { kind: "c2c"; message: Message };
      const elem = p.msgBody[0];
      let newPayload: { text: string } | { data: string; description?: string };
      if (elem?.MsgType === "TIMCustomElem") {
        newPayload = { data: elem.MsgContent.Data ?? JSON.stringify(elem.MsgContent), description: elem.MsgContent.Desc };
      } else {
        newPayload = { text: elem?.MsgContent?.Text ?? "" };
      }
      const result = await wsTransport.modifyMessage(ref.message, newPayload);
      if (result.ok && result.message) {
        ref.message = result.message;
      }
      return { ok: result.ok, error: result.error };
    },
    sendMsgBody: async (p) => {
      const elem = p.msgBody[0];
      let result;
      if (elem?.MsgType === "TIMCustomElem") {
        result = await wsTransport.sendC2CCustomMessage(
          fromAccount,
          elem.MsgContent.Data ?? JSON.stringify(elem.MsgContent),
          elem.MsgContent.Desc,
        );
      } else {
        result = await wsTransport.sendC2CTextMessage(
          fromAccount,
          elem?.MsgContent?.Text ?? "",
        );
      }
      return {
        ok: result.ok,
        ref: result.message ? { kind: "c2c" as const, message: result.message } : undefined,
        error: result.error,
      };
    },
    sendText: async (p) => {
      const result = await wsTransport.sendC2CTextMessage(fromAccount, p.text);
      return { ok: result.ok, error: result.error };
    },
  };

  const streamingMode = account.streamingMode;
  const useStreaming = isStreamingEnabled(streamingMode);
  const replyRuntime = buildReplyRuntimeConfig(config);

  await executeStreamingReply({
    transport,
    target,
    account,
    core,
    config,
    ctxPayload,
    replyRuntime,
    tableMode,
    splitFinalText,
    streamingMode,
    fallbackPolicy: account.fallbackPolicy,
    overflowPolicy: account.overflowPolicy,
    useStreaming,
    useCustomStreaming: isCustomStreamingMode(streamingMode),
    useTimStream: isTimStreamMode(streamingMode),
    typingText: (account.config.typingText ?? "正在思考中...").trim(),
    hasTypingText: Boolean((account.config.typingText ?? "正在思考中...").trim()),
  });

  log(target, "info", `C2C done <- ${fromAccount}`);
}

// ============ 群聊消息处理与回复 ============

async function processGroupAndReply(params: {
  target: TimbotWsTarget;
  msg: TimbotInboundMessage;
  mediaInfos: InboundMediaInfo[];
}): Promise<void> {
  const { target, msg, mediaInfos } = params;
  const core = target.core;
  const config = target.config;
  const account = target.account;
  const wsTransport = target.transport;

  const groupId = msg.GroupId?.trim() || "unknown";
  const fromAccount = msg.From_Account?.trim() || "unknown";
  const outboundSender = resolveOutboundSenderAccount(account);

  if (fromAccount === outboundSender) {
    log(target, "info", `skip self message <- group:${groupId}, from=${fromAccount}`);
    return;
  }

  const rawBody = extractTextFromMsgBody(msg.MsgBody);

  log(target, "info", `group message <- group:${groupId}, from=${fromAccount}, msgId=${msg.MsgKey}${mediaInfos.length > 0 ? `, media=${mediaInfos.length}` : ""}`);
  logVerbose(target, `content: ${rawBody.slice(0, 200)}${rawBody.length > 200 ? "..." : ""}`);

  // 如果既没有文本也没有媒体，跳过
  if (!rawBody.trim() && mediaInfos.length === 0) {
    log(target, "warn", "empty group message (no text, no media), skip");
    return;
  }

  if (mediaInfos.length === 0 && /^\[.+\]$/.test(rawBody.trim()) && !/^\[TUIEmoji_/i.test(rawBody.trim())) {
    logVerbose(target, `placeholder message, skip: ${rawBody} (group=${groupId}, from=${fromAccount})`);
    return;
  }

  logVerbose(target, `processing group message, account=${account.accountId}, group=${groupId}`);

  // 下载并保存媒体
  let resolvedMedia: ResolvedMedia[] = [];
  if (mediaInfos.length > 0) {
    resolvedMedia = await resolveInboundMedia({ mediaInfos, core, target });
    logVerbose(target, `resolved media: ${resolvedMedia.length}/${mediaInfos.length} saved`);
  }

  // 构建 Body 文本：文本 + 媒体占位符
  const bodyParts: string[] = [];
  if (rawBody.trim()) bodyParts.push(rawBody);
  for (const media of resolvedMedia) {
    bodyParts.push(media.placeholder);
  }
  const effectiveBody = bodyParts.join("\n");
  const effectiveRawBody = effectiveBody;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "timbot-ws",
    accountId: account.accountId,
    peer: { kind: "group", id: groupId },
  });

  logVerbose(target, `route: agentId=${route.agentId}, group=${groupId}`);

  const groupLabel = `group:${groupId}`;
  const senderLabel = `user:${fromAccount}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "TIMBOT",
    from: groupLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: effectiveBody,
    chatType: "group",
    senderLabel,
  });

  // 构建 media 字段
  const firstMedia = resolvedMedia[0];

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: effectiveRawBody,
    CommandBody: effectiveRawBody,
    From: `timbot:group:${groupId}`,
    To: `timbot:${account.botAccount || msg.To_Account || "bot"}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: groupLabel,
    GroupSubject: undefined,
    SenderName: fromAccount,
    SenderId: fromAccount,
    Provider: "timbot-ws",
    Surface: "timbot-ws",
    MessageSid: msg.MsgKey ?? String(msg.MsgSeq ?? ""),
    OriginatingChannel: "timbot-ws",
    OriginatingTo: `timbot:group:${groupId}`,
    WasMentioned: true,
    // Media fields
    MediaPath: firstMedia?.path,
    MediaType: firstMedia?.contentType,
    MediaUrl: firstMedia?.path,
    MediaPaths: resolvedMedia.length > 0 ? resolvedMedia.map((m) => m.path) : undefined,
    MediaUrls: resolvedMedia.length > 0 ? resolvedMedia.map((m) => m.path) : undefined,
    MediaTypes: resolvedMedia.length > 0 ? resolvedMedia.map((m) => m.contentType ?? "") : undefined,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      target.runtime.error?.(`timbot: failed updating group session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "timbot-ws",
    accountId: account.accountId,
  });
  const finalTextChunkLimit = core.channel.text.resolveTextChunkLimit(config, "timbot-ws", account.accountId, {
    fallbackLimit: TIMBOT_FINAL_TEXT_CHUNK_LIMIT,
  });
  const splitFinalText = (text: string) => splitTextByFixedLength(text, finalTextChunkLimit);

  logVerbose(target, `generating reply -> group:${groupId}`);

  // Group 传输适配器
  const transport: StreamingTransport = {
    label: "群",
    sendStreamMsg: async (_p) => {
      return { ok: false, error: "tim_stream not supported via SDK WebSocket" };
    },
    modifyMsg: async (p) => {
      const ref = p.ref as { kind: "group"; message: Message };
      const elem = p.msgBody[0];
      let newPayload: { text: string } | { data: string; description?: string };
      if (elem?.MsgType === "TIMCustomElem") {
        newPayload = { data: elem.MsgContent.Data ?? JSON.stringify(elem.MsgContent), description: elem.MsgContent.Desc };
      } else {
        newPayload = { text: elem?.MsgContent?.Text ?? "" };
      }
      const result = await wsTransport.modifyMessage(ref.message, newPayload);
      if (result.ok && result.message) {
        ref.message = result.message;
      }
      return { ok: result.ok, error: result.error };
    },
    sendMsgBody: async (p) => {
      const elem = p.msgBody[0];
      let result;
      if (elem?.MsgType === "TIMCustomElem") {
        result = await wsTransport.sendGroupCustomMessage(
          groupId,
          elem.MsgContent.Data ?? JSON.stringify(elem.MsgContent),
          elem.MsgContent.Desc,
        );
      } else {
        result = await wsTransport.sendGroupTextMessage(
          groupId,
          elem?.MsgContent?.Text ?? "",
        );
      }
      return {
        ok: result.ok,
        ref: result.message ? { kind: "group" as const, message: result.message } : undefined,
        error: result.error,
      };
    },
    sendText: async (p) => {
      const result = await wsTransport.sendGroupTextMessage(groupId, p.text);
      return { ok: result.ok, error: result.error };
    },
  };

  const streamingMode = account.streamingMode;
  const useStreaming = isStreamingEnabled(streamingMode);
  const replyRuntime = buildReplyRuntimeConfig(config);

  await executeStreamingReply({
    transport,
    target,
    account,
    core,
    config,
    ctxPayload,
    replyRuntime,
    tableMode,
    splitFinalText,
    streamingMode,
    fallbackPolicy: account.fallbackPolicy,
    overflowPolicy: account.overflowPolicy,
    useStreaming,
    useCustomStreaming: isCustomStreamingMode(streamingMode),
    useTimStream: isTimStreamMode(streamingMode),
    typingText: (account.config.typingText ?? "正在思考中...").trim(),
    hasTypingText: Boolean((account.config.typingText ?? "正在思考中...").trim()),
  });

  log(target, "info", `group done <- group:${groupId}, from=${fromAccount}`);
}

// ============ WS Target 注册 / 注销 ============

export function registerWsTarget(target: TimbotWsTarget): () => void {
  const key = target.account.accountId;
  const existing = wsTargets.get(key) ?? [];
  const next = [...existing, target];
  wsTargets.set(key, next);
  return () => {
    const updated = (wsTargets.get(key) ?? []).filter((entry) => entry !== target);
    if (updated.length > 0) wsTargets.set(key, updated);
    else wsTargets.delete(key);
  };
}

// ============ 外部暴露的发送函数（供 channel.ts outbound 使用） ============

export async function sendTimbotMessage(params: {
  account: ResolvedTimbotAccount;
  toAccount: string;
  text: string;
  fromAccount?: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const targets = wsTargets.get(params.account.accountId);
  const target = targets?.[0];
  if (!target) {
    return { ok: false, error: "no active WS transport for this account" };
  }
  const result = await target.transport.sendC2CTextMessage(params.toAccount, params.text);
  return { ok: result.ok, messageId: result.message?.ID, error: result.error };
}

export async function sendTimbotGroupMessage(params: {
  account: ResolvedTimbotAccount;
  groupId: string;
  text: string;
  fromAccount?: string;
}): Promise<{ ok: boolean; messageId?: string; msgSeq?: number; error?: string }> {
  const targets = wsTargets.get(params.account.accountId);
  const target = targets?.[0];
  if (!target) {
    return { ok: false, error: "no active WS transport for this account" };
  }
  const result = await target.transport.sendGroupTextMessage(params.groupId, params.text);
  return { ok: result.ok, messageId: result.message?.ID, error: result.error };
}
