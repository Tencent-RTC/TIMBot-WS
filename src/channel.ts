import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";

import { listTimbotAccountIds, resolveDefaultTimbotAccountId, resolveTimbotAccount } from "./accounts.js";
import { timbotConfigSchema } from "./config-schema.js";
import { timbotWsSetupWizard } from "./setup-surface.js";
import type { ResolvedTimbotAccount } from "./types.js";
import { registerWsTarget, handleWsMessage, sendTimbotMessage, sendTimbotGroupMessage } from "./monitor.js";
import type { TimbotWsTarget } from "./monitor.js";
import { WsTransport } from "./ws-transport.js";
import { getTimbotRuntime } from "./runtime.js";
import { logSimple } from "./logger.js";

const meta = {
  id: "timbot-ws",
  label: "Tencent IM",
  selectionLabel: "Tencent IM (timbot-ws)",
  detailLabel: "Tencent Cloud IM Bot (WebSocket)",
  docsPath: "/channels/timbot-ws",
  docsLabel: "timbot-ws",
  blurb: "Tencent Cloud IM bot via WebSocket SDK. Zero-config deployment - no public IP needed.",
  aliases: ["tencentim", "腾讯im", "即时通信"],
  order: 85,
  quickstartAllowFrom: true,
};

function normalizeTimbotMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(timbot-ws|timbot|tencentim):/i, "").trim() || undefined;
}

export const timbotPlugin: ChannelPlugin<ResolvedTimbotAccount> = {
  id: "timbot-ws",
  meta,
  setupWizard: timbotWsSetupWizard,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.timbot-ws"] },
  configSchema: timbotConfigSchema,
  config: {
    listAccountIds: (cfg) => listTimbotAccountIds(cfg as OpenClawConfig),
    resolveAccount: (cfg, accountId) => resolveTimbotAccount({ cfg: cfg as OpenClawConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTimbotAccountId(cfg as OpenClawConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as OpenClawConfig,
        sectionKey: "timbot-ws",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as OpenClawConfig,
        sectionKey: "timbot-ws",
        clearBaseFields: ["name", "sdkAppId", "identifier", "userId", "userSig", "botAccount", "welcomeText", "typingText", "streamingMode", "fallbackPolicy", "overflowPolicy"],
        accountId,
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveTimbotAccount({ cfg: cfg as OpenClawConfig, accountId });
      return (account.config.dm?.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean((cfg as OpenClawConfig).channels?.["timbot-ws"]?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath ? `channels.timbot-ws.accounts.${resolvedAccountId}.` : "channels.timbot-ws.";
      const policy = account.config.dm?.policy ?? "open";
      const rawAllowFrom = (account.config.dm?.allowFrom ?? []).map((entry) => String(entry));
      const allowFrom = policy === "open" && rawAllowFrom.length === 0 ? ["*"] : rawAllowFrom;
      return {
        policy,
        allowFrom,
        policyPath: `${basePath}dm.policy`,
        allowFromPath: `${basePath}dm.allowFrom`,
        approveHint: formatPairingApproveHint("timbot-ws"),
        normalizeEntry: (raw) => raw.trim().toLowerCase(),
      };
    },
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: normalizeTimbotMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(raw.trim()),
      hint: "<userid> or group:<groupid>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 10000,
    sendText: async ({ account, target, text }) => {
      // 群消息以 group: 开头
      if (target.startsWith("group:")) {
        const groupId = target.slice("group:".length);
        const result = await sendTimbotGroupMessage({
          account,
          groupId,
          text,
          fromAccount: account.botAccount,
        });
        return {
          channel: "timbot-ws",
          ok: result.ok,
          messageId: result.messageId ?? "",
          error: result.error ? new Error(result.error) : undefined,
        };
      }

      const result = await sendTimbotMessage({
        account,
        toAccount: target,
        text,
        fromAccount: account.botAccount,
      });

      return {
        channel: "timbot-ws",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async () => ({ ok: true }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? "open",
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      ctx.log?.debug(`starting account: ${account.accountId}, configured=${account.configured}, enabled=${account.enabled}`);
      ctx.log?.debug(`sdkAppId=${account.sdkAppId ?? "unset"}, userId=${account.userId ?? account.identifier ?? "unset"}, userSig=${account.userSig ? "set" : "unset"}`);

      if (!account.configured) {
        ctx.log?.warn(`[${account.accountId}] not configured, skipping`);
        ctx.setStatus({ accountId: account.accountId, running: false, configured: false });
        return;
      }

      const sdkAppId = Number(account.sdkAppId);
      if (!sdkAppId || isNaN(sdkAppId)) {
        ctx.log?.warn(`[${account.accountId}] invalid sdkAppId: ${account.sdkAppId}`);
        ctx.setStatus({ accountId: account.accountId, running: false, configured: false, lastError: "invalid sdkAppId" });
        return;
      }

      const userID = account.userId || account.identifier || account.botAccount || "administrator";
      const userSig = account.userSig;

      if (!userSig) {
        ctx.log?.error(`[${account.accountId}] userSig required`);
        ctx.setStatus({ accountId: account.accountId, running: false, configured: true, lastError: "missing userSig" });
        return;
      }

      const transport = new WsTransport({
        sdkAppId,
        userID,
        userSig,
        log: (level, msg) => {
          if (level === "error") ctx.log?.error(msg);
          else if (level === "warn") ctx.log?.warn(msg);
          else ctx.log?.info(msg);
        },
      });

      // 登录重试，遇到致命错误时立即停止
      let loginSuccess = false;
      let lastLoginError: string | undefined;
      let needsReconfigure = false;
      const maxRetries = 5;
      const baseDelay = 1000;

      // 致命错误码，需要用户重新配置
      // 参考文档: https://cloud.tencent.com/document/product/269/1671
      const FATAL_ERROR_CODES: Record<number, string> = {
        70001: "UserSig 已过期，请重新生成",
        70003: "UserSig 解析失败，请使用官网 API 重新生成",
        70009: "UserSig 验证失败，请检查 SDKAppID 和密钥是否匹配",
        70013: "请求中的 UserID 与生成 UserSig 时使用的 UserID 不一致",
        70014: "请求中的 SDKAppID 与生成 UserSig 时使用的 SDKAppID 不一致",
        70016: "密钥/公钥不存在，请检查 SDKAppID 和 IM 数据中心是否一致",
        70017: "UserSig 已被撤销",
        70020: "SDKAppID 不存在，请检查 SDKAppID 和 IM 数据中心是否一致",
        70050: "UserSig 验证失败且请求频率超限，请1分钟后重试",
        70051: "账号被拉入黑名单，请联系腾讯云 IM 技术支持",
        70107: "用户账号未导入 IM 系统，请先导入账号",
        70398: "账号数超限，请升级为专业版",
        70399: "账号被删除后三个月内不允许重新导入",
        72000: "DAU 超过免费额度，请升级套餐",
        72002: "MAU 超过免费额度，请升级套餐",
      };
      
      // 可重试的临时错误
      const RETRYABLE_ERROR_CODES = new Set([70169, 70500, 72010]);

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await transport.login();
          loginSuccess = true;
          break;
        } catch (err: any) {
          const errorCode = err?.code ?? err?.errorCode;
          lastLoginError = err instanceof Error ? err.message : String(err);

          // 致命错误，停止重试
          if (errorCode && FATAL_ERROR_CODES[errorCode]) {
            const hint = FATAL_ERROR_CODES[errorCode];
            ctx.log?.error(`[${account.accountId}] login failed (${errorCode}): ${hint}`);
            ctx.log?.error(`[${account.accountId}] run 'openclaw onboard timbot-ws' to reconfigure`);
            lastLoginError = `${hint} (${errorCode})`;
            needsReconfigure = true;
            break;
          }

          if (attempt < maxRetries) {
            const delay = Math.min(baseDelay * Math.pow(2, attempt), 30000);
            ctx.log?.warn(`[${account.accountId}] login attempt ${attempt + 1} failed: ${lastLoginError}, retry in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      if (!loginSuccess) {
        const retryInfo = needsReconfigure ? "" : ` after ${maxRetries + 1} attempts`;
        ctx.log?.error(`[${account.accountId}] login failed${retryInfo}: ${lastLoginError}`);
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          configured: !needsReconfigure,
          lastError: needsReconfigure 
            ? `${lastLoginError}. Run 'openclaw onboard timbot-ws' to reconfigure`
            : `login failed: ${lastLoginError}`,
        });
        await transport.destroy();
        return;
      }

      // 获取运行时
      let core: any;
      try {
        core = getTimbotRuntime();
      } catch {
        core = {} as any;
      }

      const wsTarget: TimbotWsTarget = {
        account,
        config: ctx.cfg as OpenClawConfig,
        runtime: {
          log: (msg) => ctx.log?.info(msg),
          warn: (msg) => ctx.log?.warn(msg),
          error: (msg) => ctx.log?.error(msg),
        },
        core,
        transport,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      };

      const unregister = registerWsTarget(wsTarget);

      transport.onMessageReceived((messageList) => {
        let latestCore: any;
        try {
          latestCore = getTimbotRuntime();
        } catch {
          latestCore = core;
        }
        handleWsMessage({
          messageList,
          target: { ...wsTarget, core: latestCore },
        });
      });

      ctx.log?.info(`[${account.accountId}] connected via WebSocket, sdkAppId=${sdkAppId}, userID=${userID}`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        configured: true,
        lastStartAt: Date.now(),
      });

      // 保持运行直到收到 abort 信号
      return new Promise<void>((resolve) => {
        const onAbort = async () => {
          unregister();

          const timeout = setTimeout(() => {}, 30000);
          try {
            await transport.destroy();
          } catch (err) {
            ctx.log?.warn(`[${account.accountId}] destroy error: ${String(err)}`);
          }
          clearTimeout(timeout);

          ctx.log?.info(`[${account.accountId}] disconnected`);
          ctx.setStatus({
            accountId: account.accountId,
            running: false,
            lastStopAt: Date.now(),
          });
          resolve();
        };
        if (ctx.abortSignal.aborted) {
          onAbort();
          return;
        }
        ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
      });
    },
    stopAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.account.accountId,
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
