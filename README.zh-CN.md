# timbot-ws - OpenClaw 腾讯云 IM 通道插件（WebSocket 版）

维护者：leochliu@tencent.com

通过 WebSocket SDK 实现腾讯云即时通信 IM 智能机器人。

**✨ 无需公网 IP，零配置部署，开箱即用。**

完整接入教程请参考：**[腾讯云官方文档](https://cloud.tencent.com/document/product/269/128326)**

---

## 与 timbot（Webhook 版）的区别

| 特性 | timbot-ws (WebSocket) | timbot (Webhook) |
|------|----------------------|------------------|
| **部署要求** | 无需公网 IP | 需要公网 IP + HTTPS |
| **连接方式** | 长连接，主动连接腾讯 IM | 被动接收 Webhook 回调 |
| **适用场景** | 本地开发、内网部署、快速原型 | 生产环境、高并发、多实例 |
| **Multi-Agent** | ✅ 支持 | ✅ 支持 |
| **流式消息** | ⚠️ 部分支持（text_modify/custom_modify） | ✅ 完整支持（含原生 TIMStreamElem） |

> ✅ **Multi-Agent**：timbot-ws 已支持多 Agent 模式，通过 Worker 线程隔离实现同一 SDKAppID 下多机器人并行运行。详见 [多 Agent 配置教程](#多-agent-配置教程)。

---

## 安装

### 方式 A：从 npm 安装
```bash
openclaw plugins install timbot-ws
```

### 方式 B：本地开发（link）
```bash
git clone https://github.com/Tencent-RTC/TIMBot-WS.git && cd TIMBot-WS
pnpm install && pnpm build
bash install-timbot-ws.sh
```

## 配置项说明

配置位于 OpenClaw config 的 `channels.timbot-ws` 下。

### 基础配置

| 配置项 | 必需 | 说明 | 默认值 |
|--------|------|------|--------|
| `sdkAppId` | 是 | 腾讯云 IM SDK 应用 ID | — |
| `userId` | 是 | 机器人登录 UserID（即发送/接收消息的身份标识） | — |
| `userSig` | 是 | 用户签名，用于 SDK 登录鉴权 | — |
| `enabled` | 否 | 是否启用该通道 | `true` |

> **关于 UserSig**：建议设置有效期为 10 年（315360000 秒）。可在腾讯云 IM 控制台"开发辅助工具"中生成。如果 UserSig 泄露，可通过 REST API 撤销使其立即失效。详见 [UserSig 文档](https://cloud.tencent.com/document/product/269/32688)。

### 消息与流式配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `welcomeText` | 新会话欢迎语 | — |
| `typingText` | 机器人生成中占位文案（非流式模式下通过发送占位消息 + modify 实现；流式模式下作为 CompatibleText） | `正在思考中...` |
| `typingDelayMs` | 发送 typingText 前的延迟毫秒数，用于避免消息时间戳在同一秒导致 UI 排序异常 | `1000` |
| `streamingMode` | 流式模式：`off` / `text_modify` / `custom_modify` | `off` |
| `fallbackPolicy` | 流式失败兜底策略：`strict`（不降级）/ `final_text`（降级为最终文本） | `strict` |
| `overflowPolicy` | 流式超限后的处理策略：`stop`（停止并提示，默认）/ `split`（按长度强行分段续发） | `stop` |

### 私聊策略（dm）

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `dm.policy` | 私聊策略：`open` / `allowlist` / `pairing` / `disabled` | `open` |
| `dm.allowFrom` | 允许发消息的用户列表（`open` 策略默认 `["*"]`） | — |

### 多账号配置

| 配置项 | 说明 |
|--------|------|
| `defaultAccount` | 默认账号 ID |
| `accounts` | 多账号配置对象，key 为账号 ID，value 为上述所有账号级配置项 |

多账号模式下，顶层配置作为所有账号的基础配置，各账号的同名字段会覆盖顶层配置。

## FAQ

### streamingMode 应该怎么选？

- **不确定 / 刚开始接入** → `off`（默认），最稳定，所有客户端都能正常展示。
- **希望有"正在输入"体验，且使用官方客户端** → `text_modify`，兼容性最好，各端（Web、Android、iOS、小程序、桌面）都能看到消息被持续更新。
- **自研前端，需要自定义渲染逻辑** → `custom_modify`，拥有更细致的控制能力，通过 `TIMCustomElem` 传递结构化数据，前端自行解析渲染。

> ⚠️ **`tim_stream` 模式不可用**：IM Node SDK 不支持发送流式消息（`TIMStreamElem`），如需此功能请使用 timbot（Webhook 版）。

注意：以上流式模式只决定 TIM 侧的消息承载方式，不保证上游模型一定会逐块输出。前提是所选 provider/model 能在 OpenClaw 中产生 partial 文本（`onPartialReply`）。如果上游只在结束时返回 final，TIM 侧会表现为「占位消息 -> 最终替换」，不会看到逐字增长。

### 如何快速修改流式消息配置？

```bash
# 开启 text_modify 流式模式
openclaw config set channels.timbot-ws.streamingMode text_modify

# 开启 custom_modify 流式模式
openclaw config set channels.timbot-ws.streamingMode custom_modify

# 关闭流式
openclaw config set channels.timbot-ws.streamingMode off

# 设置失败兜底策略为降级发送最终文本
openclaw config set channels.timbot-ws.fallbackPolicy final_text

# 长文本超限后直接停止并提示（默认）
openclaw config set channels.timbot-ws.overflowPolicy stop

# 长文本超限后按长度继续分段发送
openclaw config set channels.timbot-ws.overflowPolicy split

# 自定义占位文案
openclaw config set channels.timbot-ws.typingText "思考中，请稍候..."
```

## 常用命令速查

### Gateway 前台运行 + 日志

```bash
# 前台运行 Gateway，并强制占用端口（开发调试推荐）
openclaw gateway run --verbose --force

# 如需本地开发模式（自动创建本地 workspace / 配置）
openclaw gateway run --verbose --force --dev
```

### 配置 / 切换大模型 Provider

```bash
# 交互式配置（推荐，一次性完成 Provider + 模型 + 凭证）
openclaw configure

# 为某个 Provider 配置认证（示例：openai）
openclaw models auth login --provider openai
# 或粘贴已有 token
openclaw models auth paste-token --provider openai

# 将默认模型切换到某个 Provider 的指定模型
openclaw models set openai/gpt-4.1

# 查看当前默认模型与认证状态
openclaw models status
```

---

## 更新日志

### 2026.5.20

- feat: **支持多 Agent 模式** — 为每个 Agent 配置不同的机器人账号。
- feat: 支持群聊@携带上下文历史消息。

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

