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
| **Multi-Agent** | ✅ Supported | ✅ Supported |
| **Streaming** | ⚠️ Partial (text_modify/custom_modify only) | ✅ Full support (including native TIMStreamElem) |

> ✅ **Multi-Agent**: timbot-ws now supports multi-agent mode. See [Multi-Agent Setup Guide](#multi-agent-setup-guide).

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

- feat: **Multi-Agent support** — Configure a separate bot account for each Agent.
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

---

## Multi-Agent Setup Guide

timbot-ws supports configuring multiple bot accounts under the same Tencent IM application. Each bot binds to a different OpenClaw Agent, enabling a "different conversation = different AI assistant" experience.

### Prerequisites

- timbot-ws >= 2026.5.20
- OpenClaw >= 2026.3.24

### Step 1: Create Agent Workspaces

Create an independent workspace for each Agent:

```bash
openclaw agents add translator
openclaw agents add coder
```

Each Agent has its own SOUL.md (persona), AGENTS.md (behavior instructions), session storage, and auth configuration.

### Step 2: Configure timbot-ws Multi-Account

#### Option A: CLI Commands (Recommended)

```bash
# Set default account
openclaw config set channels.timbot-ws.defaultAccount default

# Set botAccount (userId) for each account
openclaw config set channels.timbot-ws.accounts.default.botAccount "@RBT#001"
openclaw config set channels.timbot-ws.accounts.translator.botAccount "@RBT#002"
openclaw config set channels.timbot-ws.accounts.coder.botAccount "@RBT#003"

# Override top-level config per account (optional)
openclaw config set channels.timbot-ws.accounts.coder.streamingMode text_modify
```

You can also use `--batch-json` for batch configuration:

```bash
openclaw config set --batch-json '[
  { "path": "channels.timbot-ws.defaultAccount", "value": "default" },
  { "path": "channels.timbot-ws.accounts.default.botAccount", "value": "@RBT#001" },
  { "path": "channels.timbot-ws.accounts.translator.botAccount", "value": "@RBT#002" },
  { "path": "channels.timbot-ws.accounts.coder.botAccount", "value": "@RBT#003" }
]'
```

#### Option B: Edit Config File Manually

Edit `~/.openclaw/openclaw.json`:

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
          "userSig": "<UserSig generated for @RBT#002>"
        },
        "coder": {
          "botAccount": "@RBT#003",
          "userId": "@RBT#003",
          "userSig": "<UserSig generated for @RBT#003>",
          "streamingMode": "text_modify"
        }
      }
    }
  }
}
```

Account-level fields override top-level fields of the same name. Unspecified fields inherit from top-level defaults. Shared credentials like `sdkAppId` only need to be written once at the top level.

### Step 3: Add Bindings

Bindings map timbot-ws accountIds to OpenClaw agentIds.

#### Option A: CLI Commands (Recommended)

```bash
# Bind timbot-ws accounts to their respective agents
openclaw agents bind --agent main --bind timbot-ws:default
openclaw agents bind --agent translator --bind timbot-ws:translator
openclaw agents bind --agent coder --bind timbot-ws:coder

# Verify bindings
openclaw agents bindings
```

#### Option B: Edit Config File Manually

Add to `~/.openclaw/openclaw.json`:

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

### Step 4: Set Agent Personas

Edit `SOUL.md` in each Agent's workspace to define its personality:

```bash
# Translator
echo "You are a professional translator, skilled in Chinese-English translation. Translate content provided by the user in a concise and accurate style." \
  > ~/.openclaw/workspace-translator/SOUL.md

# Coder
echo "You are a senior programmer, skilled in code review, debugging, and writing. Include code examples in your responses." \
  > ~/.openclaw/workspace-coder/SOUL.md
```

### Step 5: Restart and Verify

```bash
# Restart Gateway
openclaw gateway restart

# Check agents and bindings
openclaw agents list --bindings

# Check channel status
openclaw channels status --probe
```

