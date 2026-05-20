/**
 * worker-protocol.ts
 *
 * 定义主线程（Main Thread）与 Worker 线程之间的消息协议。
 * 使用 worker_threads 的 parentPort.postMessage / worker.postMessage 通信。
 */

// ============ 主线程 → Worker 的指令 ============

export type WorkerCommand =
  | { type: "login"; payload: { sdkAppId: number; userID: string; userSig: string } }
  | { type: "logout" }
  | { type: "destroy" }
  | { type: "send-c2c-text"; requestId: string; payload: { toUserID: string; text: string } }
  | { type: "send-group-text"; requestId: string; payload: { groupID: string; text: string } }
  | { type: "send-c2c-custom"; requestId: string; payload: { toUserID: string; data: string; description?: string } }
  | { type: "send-group-custom"; requestId: string; payload: { groupID: string; data: string; description?: string } }
  | { type: "modify-message"; requestId: string; payload: { originalMessage: any; newPayload: any } };

// ============ Worker → 主线程的事件 ============

export type WorkerEvent =
  | { type: "login-ok"; payload: { loginTime: number } }
  | { type: "login-error"; payload: { code?: number; message: string } }
  | { type: "message-received"; payload: { messages: any[] } }
  | { type: "net-state-change"; payload: { state: string; rawState: string } }
  | { type: "sdk-ready" }
  | { type: "sdk-not-ready" }
  | { type: "kicked-out"; payload: { kickType: string } }
  | { type: "destroyed" }
  | { type: "log"; payload: { level: "info" | "warn" | "error"; message: string } }
  | { type: "send-result"; requestId: string; payload: { ok: boolean; message?: any; error?: string } }
  | { type: "modify-result"; requestId: string; payload: { ok: boolean; message?: any; error?: string } };
