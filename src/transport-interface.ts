/**
 * transport-interface.ts
 *
 * 抽象传输层接口。WsTransport（直连）和 WorkerTransport（线程隔离）均实现此接口。
 * monitor.ts / channel.ts 通过此接口与传输层交互，无需感知底层实现。
 */

export type TransportMessage = any;

export type TransportSendResult = {
  ok: boolean;
  message?: TransportMessage;
  error?: string;
};

export type TransportNetState = "connected" | "connecting" | "disconnected";

export type TransportNetStateChangeEvent = {
  state: TransportNetState;
  rawState: string;
};

/**
 * 统一传输层接口
 */
export interface TransportInterface {
  /** 登录时间戳（秒），用于过滤历史消息 */
  readonly loginTime: number;

  /** SDK 是否就绪 */
  readonly isReady: boolean;

  /** 当前网络状态 */
  readonly netState: TransportNetState;

  /** 是否已连接 */
  readonly isConnected: boolean;

  /** 登录 */
  login(): Promise<void>;

  /** 注册消息接收回调 */
  onMessageReceived(handler: (messageList: TransportMessage[]) => void): void;

  /** 注册网络状态变化回调 */
  onNetStateChange(handler: (event: TransportNetStateChangeEvent) => void): void;

  /** 发送 C2C 文本消息 */
  sendC2CTextMessage(toUserID: string, text: string): Promise<TransportSendResult>;

  /** 发送群文本消息 */
  sendGroupTextMessage(groupID: string, text: string): Promise<TransportSendResult>;

  /** 发送 C2C 自定义消息 */
  sendC2CCustomMessage(toUserID: string, data: string, description?: string): Promise<TransportSendResult>;

  /** 发送群自定义消息 */
  sendGroupCustomMessage(groupID: string, data: string, description?: string): Promise<TransportSendResult>;

  /** 修改已发送的消息 */
  modifyMessage(
    originalMessage: TransportMessage,
    newPayload: { text: string } | { data: string; description?: string },
  ): Promise<{ ok: boolean; message?: TransportMessage; error?: string }>;

  /** 发送流式消息（TIMStreamElem） */
  sendStreamMessage(options: {
    to: string;
    conversationType: "C2C" | "GROUP";
    chunks: Array<{ index: number; markdown: string; isLast: boolean }>;
    compatibleText?: string;
    streamMsgId?: string;
  }): Promise<TransportSendResult>;

  /** 销毁连接和资源 */
  destroy(): Promise<void>;
}
