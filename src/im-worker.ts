/**
 * im-worker.ts
 *
 * Worker 线程入口。每个 Worker 线程运行一个独立的 IM SDK 实例。
 * 由于 worker_threads 有独立的模块缓存，不受 SDK 单例限制。
 *
 * 通过 parentPort 与主线程通信。
 */

import { parentPort } from "node:worker_threads";
import type { WorkerCommand, WorkerEvent } from "./worker-protocol.js";

if (!parentPort) {
  throw new Error("[im-worker] must be run as a Worker thread");
}

// 动态加载 SDK（每个 Worker 线程有独立的模块系统，SDK create 缓存互不干扰）
// @ts-expect-error 运行时路径有效
import TencentCloudChat from "../im-sdk-bundle/node.es.js";
const Chat: any = TencentCloudChat;

const port = parentPort;

let chat: any = null;
let loginTime = 0;
let ready = false;
let destroyed = false;

/**
 * 消息对象缓存：messageID → SDK Message 实例
 *
 * 问题背景：
 *   postMessage 使用 Structured Clone 序列化对象，传回主线程的 message 对象丢失原型链。
 *   再传回 Worker 时，SDK 的 chat.modifyMessage() 不接受纯数据对象。
 *
 * 解决方案：
 *   Worker 内部缓存发送成功的 message 对象引用，modifyMessage 时通过 ID 查找。
 */
const sentMessageCache = new Map<string, any>();
const CACHE_MAX_SIZE = 200;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟过期

function cacheSentMessage(message: any): void {
  if (!message?.ID) return;
  sentMessageCache.set(message.ID, { message, ts: Date.now() });

  // 超过上限时清理最早的
  if (sentMessageCache.size > CACHE_MAX_SIZE) {
    const now = Date.now();
    for (const [id, entry] of sentMessageCache) {
      if (now - entry.ts > CACHE_TTL_MS || sentMessageCache.size > CACHE_MAX_SIZE) {
        sentMessageCache.delete(id);
      }
      if (sentMessageCache.size <= CACHE_MAX_SIZE * 0.8) break;
    }
  }
}

function getCachedMessage(messageID: string): any | undefined {
  const entry = sentMessageCache.get(messageID);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    sentMessageCache.delete(messageID);
    return undefined;
  }
  return entry.message;
}

function emit(event: WorkerEvent): void {
  port.postMessage(event);
}

function log(level: "info" | "warn" | "error", message: string): void {
  emit({ type: "log", payload: { level, message } });
}

// ============ 处理主线程指令 ============

port.on("message", async (cmd: WorkerCommand) => {
  switch (cmd.type) {
    case "login":
      await handleLogin(cmd.payload);
      break;
    case "logout":
      await handleLogout();
      break;
    case "destroy":
      await handleDestroy();
      break;
    case "send-c2c-text":
      await handleSendC2CText(cmd.requestId, cmd.payload);
      break;
    case "send-group-text":
      await handleSendGroupText(cmd.requestId, cmd.payload);
      break;
    case "send-c2c-custom":
      await handleSendC2CCustom(cmd.requestId, cmd.payload);
      break;
    case "send-group-custom":
      await handleSendGroupCustom(cmd.requestId, cmd.payload);
      break;
    case "modify-message":
      await handleModifyMessage(cmd.requestId, cmd.payload);
      break;
  }
});

// ============ 指令处理器 ============

async function handleLogin(payload: { sdkAppId: number; userID: string; userSig: string }): Promise<void> {
  const { sdkAppId, userID, userSig } = payload;

  try {
    log("info", `[im-worker] creating SDK instance, sdkAppId=${sdkAppId}, userID=${userID}`);
    chat = Chat.create({ SDKAppID: sdkAppId });

    // 注册事件
    chat.on(Chat.EVENT.SDK_READY, () => {
      ready = true;
      emit({ type: "sdk-ready" });
      log("info", "[im-worker] SDK ready");
    });

    chat.on(Chat.EVENT.SDK_NOT_READY, () => {
      ready = false;
      emit({ type: "sdk-not-ready" });
      log("warn", "[im-worker] SDK not ready");
    });

    chat.on(Chat.EVENT.MESSAGE_RECEIVED, (event: any) => {
      const messages = event?.data ?? [];
      if (messages.length > 0) {
        log("info", `[im-worker] received ${messages.length} message(s)`);
        emit({ type: "message-received", payload: { messages } });
      }
    });

    chat.on(Chat.EVENT.NET_STATE_CHANGE, (event: any) => {
      const rawState = event?.data?.state ?? "unknown";
      let state = "disconnected";
      if (rawState === Chat.TYPES.NET_STATE_CONNECTED) state = "connected";
      else if (rawState === Chat.TYPES.NET_STATE_CONNECTING) state = "connecting";
      else if (rawState === Chat.TYPES.NET_STATE_DISCONNECTED) state = "disconnected";

      log("info", `[im-worker] net state: ${state} (raw: ${rawState})`);
      emit({ type: "net-state-change", payload: { state, rawState } });
    });

    chat.on(Chat.EVENT.KICKED_OUT, (event: any) => {
      const kickType = event?.data?.type ?? "unknown";
      log("warn", `[im-worker] kicked out: ${kickType}`);
      emit({ type: "kicked-out", payload: { kickType } });

      // 如果是 UserSig 过期，尝试重新登录
      if (kickType === Chat.TYPES.KICKED_OUT_USERSIG_EXPIRED) {
        log("info", "[im-worker] attempting relogin (userSig expired)");
        chat.login({ userID, userSig }).catch((err: any) => {
          log("error", `[im-worker] relogin failed: ${err?.message ?? String(err)}`);
        });
      }
    });

    // 执行登录
    loginTime = Math.floor(Date.now() / 1000);
    await chat.login({ userID, userSig });
    log("info", "[im-worker] login successful");
    emit({ type: "login-ok", payload: { loginTime } });

  } catch (err: any) {
    const code = err?.code ?? err?.errorCode;
    const message = err?.message ?? String(err);
    log("error", `[im-worker] login failed: code=${code}, message=${message}`);
    emit({ type: "login-error", payload: { code, message } });
  }
}

async function handleLogout(): Promise<void> {
  if (!chat) return;
  try {
    await chat.logout();
    log("info", "[im-worker] logged out");
  } catch (err: any) {
    log("warn", `[im-worker] logout error: ${err?.message ?? String(err)}`);
  }
}

async function handleDestroy(): Promise<void> {
  if (destroyed) return;
  destroyed = true;

  if (chat) {
    try { await chat.logout(); } catch {}
    try { await chat.destroy(); } catch {}
  }

  ready = false;
  log("info", "[im-worker] destroyed");
  emit({ type: "destroyed" });

  // 延迟退出，让消息发送完成
  setTimeout(() => process.exit(0), 100);
}

async function handleSendC2CText(requestId: string, payload: { toUserID: string; text: string }): Promise<void> {
  try {
    const msg = chat.createTextMessage({
      to: payload.toUserID,
      conversationType: Chat.TYPES.CONV_C2C,
      payload: { text: payload.text },
    });
    const result = await chat.sendMessage(msg);
    const sentMessage = result?.data?.message ?? msg;
    cacheSentMessage(sentMessage);
    emit({ type: "send-result", requestId, payload: { ok: true, message: sentMessage } });
  } catch (err: any) {
    emit({ type: "send-result", requestId, payload: { ok: false, error: err?.message ?? String(err) } });
  }
}

async function handleSendGroupText(requestId: string, payload: { groupID: string; text: string }): Promise<void> {
  try {
    const msg = chat.createTextMessage({
      to: payload.groupID,
      conversationType: Chat.TYPES.CONV_GROUP,
      payload: { text: payload.text },
    });
    const result = await chat.sendMessage(msg);
    const sentMessage = result?.data?.message ?? msg;
    cacheSentMessage(sentMessage);
    emit({ type: "send-result", requestId, payload: { ok: true, message: sentMessage } });
  } catch (err: any) {
    emit({ type: "send-result", requestId, payload: { ok: false, error: err?.message ?? String(err) } });
  }
}

async function handleSendC2CCustom(requestId: string, payload: { toUserID: string; data: string; description?: string }): Promise<void> {
  try {
    const msg = chat.createCustomMessage({
      to: payload.toUserID,
      conversationType: Chat.TYPES.CONV_C2C,
      payload: { data: payload.data, description: payload.description ?? "", extension: "" },
    });
    const result = await chat.sendMessage(msg);
    const sentMessage = result?.data?.message ?? msg;
    cacheSentMessage(sentMessage);
    emit({ type: "send-result", requestId, payload: { ok: true, message: sentMessage } });
  } catch (err: any) {
    emit({ type: "send-result", requestId, payload: { ok: false, error: err?.message ?? String(err) } });
  }
}

async function handleSendGroupCustom(requestId: string, payload: { groupID: string; data: string; description?: string }): Promise<void> {
  try {
    const msg = chat.createCustomMessage({
      to: payload.groupID,
      conversationType: Chat.TYPES.CONV_GROUP,
      payload: { data: payload.data, description: payload.description ?? "", extension: "" },
    });
    const result = await chat.sendMessage(msg);
    const sentMessage = result?.data?.message ?? msg;
    cacheSentMessage(sentMessage);
    emit({ type: "send-result", requestId, payload: { ok: true, message: sentMessage } });
  } catch (err: any) {
    emit({ type: "send-result", requestId, payload: { ok: false, error: err?.message ?? String(err) } });
  }
}

async function handleModifyMessage(requestId: string, payload: { originalMessage: any; newPayload: any }): Promise<void> {
  try {
    const { originalMessage, newPayload } = payload;

    // 从缓存中获取真正的 SDK 消息引用（保留原型链）
    // postMessage 的 Structured Clone 会丢失原型链，导致 SDK 的 modifyMessage 无法识别
    const messageID = originalMessage?.ID;
    const cachedMessage = messageID ? getCachedMessage(messageID) : undefined;
    const targetMessage = cachedMessage ?? originalMessage;

    if (!cachedMessage) {
      log("warn", `[im-worker] modifyMessage: cache miss for ID=${messageID}, using serialized object (may fail)`);
    }

    if ("text" in newPayload) {
      targetMessage.payload = { text: newPayload.text };
      targetMessage.type = Chat.TYPES.MSG_TEXT;
    } else {
      targetMessage.payload = { data: newPayload.data, description: newPayload.description ?? "", extension: "" };
      targetMessage.type = Chat.TYPES.MSG_CUSTOM;
    }
    const result = await chat.modifyMessage(targetMessage);
    const msg = result?.data?.message ?? targetMessage;
    // 更新缓存为修改后的新引用
    cacheSentMessage(msg);
    emit({ type: "modify-result", requestId, payload: { ok: true, message: msg } });
  } catch (err: any) {
    emit({ type: "modify-result", requestId, payload: { ok: false, error: err?.message ?? String(err) } });
  }
}
