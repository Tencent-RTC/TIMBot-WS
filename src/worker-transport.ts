/**
 * worker-transport.ts
 *
 * 主线程中的传输代理。内部启动一个 Worker 线程运行 IM SDK 实例。
 * 实现 TransportInterface 接口，对外表现与 WsTransport 一致。
 *
 * 用于多账号同 SDKAppID 场景：每个 WorkerTransport 在独立线程中运行，
 * 绕过 SDK 的进程内单例缓存限制。
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TransportInterface, TransportSendResult, TransportNetState, TransportNetStateChangeEvent } from "./transport-interface.js";

type WsSendResult = TransportSendResult;
type NetState = TransportNetState;
type NetStateChangeEvent = TransportNetStateChangeEvent;
import type { WorkerCommand, WorkerEvent } from "./worker-protocol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Worker 脚本路径（编译后位于同目录） */
const WORKER_SCRIPT = join(__dirname, "im-worker.js");

export type WorkerTransportOptions = {
  sdkAppId: number;
  userID: string;
  userSig?: string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
};

/**
 * WorkerTransport - 通过 Worker 线程运行独立 IM SDK 实例
 */
export class WorkerTransport implements TransportInterface {
  private worker: Worker | null = null;
  private sdkAppId: number;
  private userID: string;
  private userSig?: string;
  private _log: (level: "info" | "warn" | "error", message: string) => void;
  private _ready = false;
  private _destroyed = false;
  private _loginTime = 0;
  private _netState: NetState = "disconnected";

  private _messageHandler: ((messageList: any[]) => void) | null = null;
  private _netStateChangeHandler: ((event: NetStateChangeEvent) => void) | null = null;

  /** 等待发送结果的回调 Map */
  private _pendingRequests = new Map<string, { resolve: (result: WsSendResult) => void }>();

  /** 用于生成唯一 requestId */
  private _requestCounter = 0;

  constructor(options: WorkerTransportOptions) {
    this.sdkAppId = options.sdkAppId;
    this.userID = options.userID;
    this.userSig = options.userSig;
    this._log = options.log ?? ((level, msg) => {
      if (level === "error") console.error(msg);
      else if (level === "warn") console.warn(msg);
      else console.log(msg);
    });
  }

  get loginTime(): number {
    return this._loginTime;
  }

  get isReady(): boolean {
    return this._ready && !this._destroyed;
  }

  get netState(): NetState {
    return this._netState;
  }

  get isConnected(): boolean {
    return this._netState === "connected" && this._ready && !this._destroyed;
  }

  /** 启动 Worker 并登录 */
  async login(): Promise<void> {
    if (!this.userSig?.trim()) {
      throw new Error("[worker-transport] userSig is required");
    }

    this._log("info", `[worker-transport] spawning worker thread, sdkAppId=${this.sdkAppId}, userID=${this.userID}`);

    // 创建 Worker 线程
    this.worker = new Worker(WORKER_SCRIPT);

    // 监听 Worker 消息
    this.worker.on("message", (event: WorkerEvent) => this._handleWorkerEvent(event));

    this.worker.on("error", (err) => {
      this._log("error", `[worker-transport] worker error: ${err.message}`);
    });

    this.worker.on("exit", (code) => {
      if (!this._destroyed) {
        this._log("warn", `[worker-transport] worker exited unexpectedly: code=${code}`);
        this._ready = false;
        this._netState = "disconnected";
      }
    });

    // 发送登录指令并等待结果
    return new Promise<void>((resolve, reject) => {
      const onLoginResult = (event: WorkerEvent) => {
        if (event.type === "login-ok") {
          this._loginTime = event.payload.loginTime;
          this._ready = true;
          cleanup();
          resolve();
        } else if (event.type === "login-error") {
          const err: any = new Error(event.payload.message);
          err.code = event.payload.code;
          err.errorCode = event.payload.code;
          cleanup();
          reject(err);
        }
      };

      // 临时监听登录结果
      const originalHandler = this._handleWorkerEvent.bind(this);
      this._handleWorkerEvent = (event: WorkerEvent) => {
        onLoginResult(event);
        originalHandler(event);
      };

      const cleanup = () => {
        this._handleWorkerEvent = originalHandler;
      };

      // 发送登录指令
      this._send({ type: "login", payload: { sdkAppId: this.sdkAppId, userID: this.userID, userSig: this.userSig! } });
    });
  }

  /** 注册消息接收回调 */
  onMessageReceived(handler: (messageList: any[]) => void): void {
    this._messageHandler = handler;
  }

  /** 注册网络状态变化回调 */
  onNetStateChange(handler: (event: NetStateChangeEvent) => void): void {
    this._netStateChangeHandler = handler;
  }

  /** 发送 C2C 文本消息 */
  async sendC2CTextMessage(toUserID: string, text: string): Promise<WsSendResult> {
    const requestId = this._nextRequestId();
    this._send({ type: "send-c2c-text", requestId, payload: { toUserID, text } });
    return this._waitForResult(requestId);
  }

  /** 发送群文本消息 */
  async sendGroupTextMessage(groupID: string, text: string): Promise<WsSendResult> {
    const requestId = this._nextRequestId();
    this._send({ type: "send-group-text", requestId, payload: { groupID, text } });
    return this._waitForResult(requestId);
  }

  /** 发送 C2C 自定义消息 */
  async sendC2CCustomMessage(toUserID: string, data: string, description?: string): Promise<WsSendResult> {
    const requestId = this._nextRequestId();
    this._send({ type: "send-c2c-custom", requestId, payload: { toUserID, data, description } });
    return this._waitForResult(requestId);
  }

  /** 发送群自定义消息 */
  async sendGroupCustomMessage(groupID: string, data: string, description?: string): Promise<WsSendResult> {
    const requestId = this._nextRequestId();
    this._send({ type: "send-group-custom", requestId, payload: { groupID, data, description } });
    return this._waitForResult(requestId);
  }

  /** 修改已发送消息 */
  async modifyMessage(
    originalMessage: any,
    newPayload: { text: string } | { data: string; description?: string },
  ): Promise<{ ok: boolean; message?: any; error?: string }> {
    const requestId = this._nextRequestId();
    this._send({ type: "modify-message", requestId, payload: { originalMessage, newPayload } });
    return this._waitForResult(requestId);
  }

  /** 流式消息（不支持） */
  async sendStreamMessage(_options: {
    to: string;
    conversationType: "C2C" | "GROUP";
    chunks: Array<{ index: number; markdown: string; isLast: boolean }>;
    compatibleText?: string;
    streamMsgId?: string;
  }): Promise<WsSendResult> {
    return { ok: false, error: "TIMStreamElem not supported via Worker transport" };
  }

  /** 销毁 Worker 线程 */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this.worker) {
      this._send({ type: "destroy" });

      // 等待 Worker 退出，最多 5 秒
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.worker?.terminate();
          resolve();
        }, 5000);

        this.worker!.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      this.worker = null;
    }

    this._ready = false;
    this._netState = "disconnected";
    this._log("info", "[worker-transport] destroyed");
  }

  // ============ 内部方法 ============

  private _send(cmd: WorkerCommand): void {
    if (!this.worker) {
      this._log("error", "[worker-transport] cannot send: worker not initialized");
      return;
    }
    this.worker.postMessage(cmd);
  }

  private _nextRequestId(): string {
    return `req_${++this._requestCounter}_${Date.now()}`;
  }

  private _waitForResult(requestId: string): Promise<WsSendResult> {
    return new Promise<WsSendResult>((resolve) => {
      // 30 秒超时
      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        resolve({ ok: false, error: "timeout" });
      }, 30000);

      this._pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
    });
  }

  private _handleWorkerEvent(event: WorkerEvent): void {
    switch (event.type) {
      case "message-received":
        if (this._messageHandler) {
          this._messageHandler(event.payload.messages);
        }
        break;

      case "net-state-change": {
        const state = event.payload.state as NetState;
        this._netState = state;
        if (this._netStateChangeHandler) {
          this._netStateChangeHandler({ state, rawState: event.payload.rawState });
        }
        break;
      }

      case "sdk-ready":
        this._ready = true;
        break;

      case "sdk-not-ready":
        this._ready = false;
        break;

      case "kicked-out":
        this._ready = false;
        break;

      case "log":
        this._log(event.payload.level, event.payload.message);
        break;

      case "send-result":
      case "modify-result": {
        const pending = this._pendingRequests.get(event.requestId);
        if (pending) {
          this._pendingRequests.delete(event.requestId);
          pending.resolve(event.payload);
        }
        break;
      }

      case "login-ok":
      case "login-error":
        // 已在 login() 中处理
        break;

      case "destroyed":
        // Worker 自行销毁完成
        break;
    }
  }
}
