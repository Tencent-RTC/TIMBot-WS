# timbot-ws - Tencent Cloud IM WebSocket Channel Plugin

Maintainer: leochliu@tencent.com

Tencent Cloud IM intelligent bot via WebSocket SDK.

**✨ No public IP required. Zero-config deployment. Ready to use.**

For a full integration tutorial, see: **[Tencent Cloud Official Documentation](https://cloud.tencent.com/document/product/269/128326)**

---

## Comparison with timbot (Webhook Version)

| Feature | timbot-ws (WebSocket) | timbot (Webhook) |
|---------|----------------------|------------------|
| **Deployment** | No public IP needed | Requires public IP + HTTPS |
| **Connection** | Long-lived connection | Passive Webhook callbacks |
| **Use Cases** | Local dev, intranet, quick prototyping | Production, high concurrency, multi-instance |
| **Multi-Agent** | 🚧 Single-bot multi-agent not supported | ✅ Supported |
| **Streaming** | ⚠️ Partial (text_modify/custom_modify only) | ✅ Full support (including native TIMStreamElem) |

> ⚠️ **Note**: timbot-ws currently does not support single-bot multi-agent mode. Use timbot (Webhook version) if you need this feature. See [Limitations](#limitations).

---

## Install

### Option A: Install from npm
```bash
openclaw plugins install timbot-ws
```

### Option B: Local development (link)
```bash
git clone https://github.com/Tencent-RTC/TIMBot-WS.git && cd TIMBot-WS
pnpm install && pnpm build
bash install-timbot-ws.sh
```

## Configuration

All options are under `channels.timbot-ws` in the OpenClaw config.

### Basic

| Option | Required | Description | Default |
|--------|----------|-------------|---------|
| `sdkAppId` | Yes | Tencent Cloud IM SDK App ID | — |
| `userId` | Yes | Bot login UserID (the identity that sends/receives messages) | — |
| `userSig` | Yes | User signature for SDK login authentication | — |
| `enabled` | No | Enable/disable this channel | `true` |

> **About UserSig**: Recommended validity period is 10 years (315360000 seconds). Generate it from the Tencent IM Console under "Development Tools > UserSig Generation". If leaked, you can revoke it via REST API to invalidate it immediately. See [UserSig Documentation](https://cloud.tencent.com/document/product/269/32688).

### Messaging & Streaming

| Option | Description | Default |
|--------|-------------|---------|
| `welcomeText` | Welcome message for new conversations | — |
| `typingText` | Placeholder text while the bot is generating (in non-streaming mode, sent as a placeholder message then modified; in streaming mode, used as CompatibleText) | `正在思考中...` |
| `typingDelayMs` | Delay in milliseconds before sending typingText, to avoid UI sorting issues when message timestamps fall within the same second | `1000` |
| `streamingMode` | Streaming mode: `off` / `text_modify` / `custom_modify` | `off` |
| `fallbackPolicy` | Streaming fallback policy: `strict` (no fallback) / `final_text` (degrade to final text on failure) | `strict` |
| `overflowPolicy` | What to do when a streaming reply gets too large: `stop` (stop and send a notice, default) / `split` (continue by hard-splitting into follow-up messages) | `stop` |

### DM Policy

| Option | Description | Default |
|--------|-------------|---------|
| `dm.policy` | DM policy: `open` / `allowlist` / `pairing` / `disabled` | `open` |
| `dm.allowFrom` | Allowed sender list (`open` policy defaults to `["*"]`) | — |

### Multi-Account

| Option | Description |
|--------|-------------|
| `defaultAccount` | Default account ID |
| `accounts` | Multi-account config object; key is account ID, value contains all account-level options above |

In multi-account mode, top-level config serves as the base for all accounts. Account-level fields override the top-level config.

## FAQ

### How do I choose a streamingMode?

- **Not sure / just getting started** → `off` (default). Most stable; works on all clients.
- **Want a "typing" experience with official IM clients** → `text_modify`. Best compatibility across Web, Android, iOS, Mini Program, and Desktop — the message is continuously updated in place.
- **Custom frontend with your own rendering** → `custom_modify`. Has more control; delivers structured data via `TIMCustomElem` for your frontend to parse and render.

> ⚠️ **`tim_stream` mode is not available**: The IM Node SDK does not support sending streaming messages (`TIMStreamElem`). Use timbot (Webhook version) if you need this feature.

Important: these streaming modes only decide how TIM carries updates. They do not guarantee that the upstream model will emit text incrementally. The selected provider/model must produce partial text in OpenClaw (`onPartialReply`). If the upstream only returns a final answer at the end, TIM will behave like "placeholder message -> final replace" instead of showing text grow chunk by chunk.

### How do I quickly change streaming settings?

```bash
# Enable text_modify streaming
openclaw config set channels.timbot-ws.streamingMode text_modify

# Enable custom_modify streaming
openclaw config set channels.timbot-ws.streamingMode custom_modify

# Disable streaming
openclaw config set channels.timbot-ws.streamingMode off

# Set fallback policy to degrade to final text on failure
openclaw config set channels.timbot-ws.fallbackPolicy final_text

# Stop and send a notice when streaming output gets too large (default)
openclaw config set channels.timbot-ws.overflowPolicy stop

# Continue by hard-splitting long output into follow-up messages
openclaw config set channels.timbot-ws.overflowPolicy split

# Customize typing placeholder text
openclaw config set channels.timbot-ws.typingText "Thinking, please wait..."
```

---

## Changelog

### 2026.5.20

- feat: Supports @mentions in group chats with message history context.

---

## Limitations

### tim_stream Mode Not Supported

The `tim_stream` mode (native `TIMStreamElem` streaming messages) is **not available** in timbot-ws.

**Reason**: The Tencent IM Node SDK currently does not support sending streaming messages (`TIMStreamElem`). This feature is only available via server-side REST API.

**Available streaming modes**:
| Mode | Available | Description |
|------|-----------|-------------|
| `off` | ✅ | No streaming, send final message at once |
| `text_modify` | ✅ | Typewriter effect via text message modification |
| `custom_modify` | ✅ | Custom message modification, frontend renders |
| `tim_stream` | ❌ | Not supported, use timbot (Webhook version) |

### Single-Bot Multi-Agent Not Supported

timbot-ws currently **does not support single-bot multi-agent mode**.
