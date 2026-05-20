# timbot-ws - Tencent Cloud IM WebSocket Channel Plugin

OpenClaw 腾讯云 IM 通道插件（WebSocket 版）— 通过 WebSocket SDK 实现腾讯云即时通信 IM 智能机器人。


**Maintainer:** leochliu@tencent.com

---

- **English:** [README.en.md](./README.en.md)
- **中文：** [README.zh-CN.md](./README.zh-CN.md)

---

## 与 timbot（Webhook 版）的区别

| 特性 | timbot-ws (WebSocket) | timbot (Webhook) |
|------|----------------------|------------------|
| **部署要求** | 无需公网 IP | 需要公网 IP + HTTPS |
| **连接方式** | 长连接，主动连接腾讯 IM | 被动接收 Webhook 回调 |
| **适用场景** | 本地开发、内网部署、快速原型 | 生产环境、高并发、多实例 |
| **Multi-Agent** | ✅ 支持 | ✅ 支持 |
| **流式消息** | ⚠️ 部分支持（text_modify/custom_modify） | ✅ 完整支持（含原生 TIMStreamElem） |

> ✅ **Multi-Agent**：timbot-ws 已支持多 Agent 模式。详见 [多 Agent 配置教程](#多-agent-配置教程)。

---

**[Web Demo](https://web.sdk.qcloud.com/trtc/webrtc/v5/test/qer/openclaw-demo/index.html)** — 腾讯云 IM TIMBot 插件支持全平台，本页面仅供 Web 测试，请勿用于正式环境。

**[Full integration guide / 完整对外接入教程](https://cloud.tencent.com/document/product/269/128326)** — OpenClaw：微信小程序快速接入指南

---

## Quick Start

```bash
# Install from npm
openclaw plugins install timbot-ws

# Or local development
git clone https://github.com/Tencent-RTC/TIMBot-WS.git && cd TIMBot-WS
pnpm install && pnpm build
bash install-timbot-ws.sh
```

---

## Changelog

### 2026.5.20

- feat: **支持多 Agent 模式** — 为每个 Agent 配置不同的机器人账号。
- feat: 支持群聊@携带上下文历史消息。

### 2026.4.8

- fix: 修复 openclaw 新版本安装失败问题， 限制 openclaw 最低支持版本为 v2026.3.24

### 2026.4.2

- feat: 支持图片/文件消息

### 2026.4.1

- feat: C2C 私聊与群聊支持

---

## 限制说明

### tim_stream 模式不支持

timbot-ws 的 `tim_stream` 模式（原生 `TIMStreamElem` 流式消息）**不可用**。

**原因**：腾讯 IM Node SDK 目前不支持发送流式消息（`TIMStreamElem`），该功能只能通过服务端 REST API 实现。

**可用的流式模式**：
| 模式 | 可用性 | 说明 |
|------|--------|------|
| `off` | ✅ | 关闭流式，一次性发送最终消息 |
| `text_modify` | ✅ | 通过修改文本消息实现打字机效果 |
| `custom_modify` | ✅ | 通过修改自定义消息实现，前端自行渲染 |
| `tim_stream` | ❌ | SDK 不支持，请使用 timbot（Webhook 版） |

---

## 多 Agent 配置教程

timbot-ws 支持在同一个腾讯 IM 应用下配置多个机器人账号，每个机器人绑定不同的 OpenClaw Agent，实现"不同会话 = 不同 AI 助手"的体验。

### 前置条件

- timbot-ws >= 2026.5.20
- OpenClaw >= 2026.3.24

### 第一步：创建 Agent workspace

为每个 Agent 创建独立的 workspace：

```bash
openclaw agents add translator
openclaw agents add coder
```

每个 Agent 拥有独立的 SOUL.md（人设）、AGENTS.md（行为指令）、session 存储和 auth 配置。

### 第二步：配置 timbot-ws 多账号

#### 方式 A：CLI 命令（推荐）

```bash
# 设置默认账号
openclaw config set channels.timbot-ws.defaultAccount default

# 为每个账号设置 botAccount（userId）
openclaw config set channels.timbot-ws.accounts.default.botAccount "@RBT#001"
openclaw config set channels.timbot-ws.accounts.translator.botAccount "@RBT#002"
openclaw config set channels.timbot-ws.accounts.coder.botAccount "@RBT#003"

# 可按账号覆盖顶层配置（可选）
openclaw config set channels.timbot-ws.accounts.coder.streamingMode text_modify
```

也可以用 `--batch-json` 一次性批量设置：

```bash
openclaw config set --batch-json '[
  { "path": "channels.timbot-ws.defaultAccount", "value": "default" },
  { "path": "channels.timbot-ws.accounts.default.botAccount", "value": "@RBT#001" },
  { "path": "channels.timbot-ws.accounts.translator.botAccount", "value": "@RBT#002" },
  { "path": "channels.timbot-ws.accounts.coder.botAccount", "value": "@RBT#003" }
]'
```

#### 方式 B：手动编辑配置文件

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "timbot-ws": {
      "sdkAppId": "1600012345",
      "userId": "@RBT#001",
      "userSig": "your-main-user-sig",

      "streamingMode": "off",
      "dm": { "policy": "open", "allowFrom": ["*"] },

      "defaultAccount": "default",

      "accounts": {
        "default": {
          "botAccount": "@RBT#001"
        },
        "translator": {
          "botAccount": "@RBT#002",
          "userId": "@RBT#002",
          "userSig": "<为 @RBT#002 生成的 UserSig>"
        },
        "coder": {
          "botAccount": "@RBT#003",
          "userId": "@RBT#003",
          "userSig": "<为 @RBT#003 生成的 UserSig>",
          "streamingMode": "text_modify"
        }
      }
    }
  }
}
```

账号级字段会覆盖顶层同名字段，未指定的继承顶层默认值。`sdkAppId` 等共享凭证只需在顶层写一次。

### 第三步：添加 bindings

bindings 将 timbot-ws 的 accountId 映射到 OpenClaw 的 agentId。

#### 方式 A：CLI 命令（推荐）

```bash
# 将 timbot-ws 的各账号绑定到对应 agent
openclaw agents bind --agent main --bind timbot-ws:default
openclaw agents bind --agent translator --bind timbot-ws:translator
openclaw agents bind --agent coder --bind timbot-ws:coder

# 验证绑定关系
openclaw agents bindings
```

#### 方式 B：手动编辑配置文件

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "agents": {
    "list": [
      { "id": "main", "default": true, "workspace": "~/.openclaw/workspace" },
      { "id": "translator", "workspace": "~/.openclaw/workspace-translator" },
      { "id": "coder", "workspace": "~/.openclaw/workspace-coder" }
    ]
  },

  "bindings": [
    { "agentId": "main",       "match": { "channel": "timbot-ws", "accountId": "default" } },
    { "agentId": "translator", "match": { "channel": "timbot-ws", "accountId": "translator" } },
    { "agentId": "coder",      "match": { "channel": "timbot-ws", "accountId": "coder" } }
  ]
}
```

### 第四步：设置 Agent 人设

每个 Agent 的 workspace 下编辑 `SOUL.md` 定义人格：

```bash
# 翻译官
echo "你是一位专业翻译官，擅长中英互译。请用简洁准确的风格翻译用户提供的内容。" \
  > ~/.openclaw/workspace-translator/SOUL.md

# 代码助手
echo "你是一位资深程序员，擅长代码审查、调试和编写。回复时附带代码示例。" \
  > ~/.openclaw/workspace-coder/SOUL.md
```

### 第五步：重启并验证

```bash
# 重启 Gateway
openclaw gateway restart

# 检查 agents 和 bindings
openclaw agents list --bindings

# 检查通道状态
openclaw channels status --probe
```

### 架构原理

腾讯 IM Node.js SDK 对同一 `SDKAppID` 使用单例缓存 — `Chat.create({ SDKAppID })` 同一个 SDKAppID 永远返回相同的实例。timbot-ws 通过 **Worker Threads（线程隔离）** 解决这个问题：

```
┌─────────────────────────────────────────────────────┐
│  主线程 (Main Thread)                                │
│                                                     │
│  Account A (第一个) → WsTransport（直连，零开销）      │
│                                                     │
│  Account B (同 SDKAppID)                            │
│    → WorkerTransport → [Worker Thread B]            │
│                           └── 独立 SDK 实例          │
│                                                     │
│  Account C (同 SDKAppID)                            │
│    → WorkerTransport → [Worker Thread C]            │
│                           └── 独立 SDK 实例          │
└─────────────────────────────────────────────────────┘
```

- 每个 SDKAppID 的**第一个**账号使用直连模式（零开销）
- 同一 SDKAppID 的**后续**账号自动切换到 Worker 线程模式
- 不同 SDKAppID 的账号之间无冲突，各自直连
