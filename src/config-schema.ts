import type { ChannelConfigSchema } from "openclaw/plugin-sdk";

const dmSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    policy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
    allowFrom: {
      type: "array",
      items: { oneOf: [{ type: "string" }, { type: "number" }] },
    },
  },
  additionalProperties: false,
};

const accountSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    enabled: { type: "boolean" },
    sdkAppId: { type: "string" },
    userId: { type: "string" },
    userSig: { type: "string" },
    welcomeText: { type: "string" },
    typingText: { type: "string" },
    typingDelayMs: { type: "number", minimum: 0 },
    streamingMode: { type: "string", enum: ["off", "custom_modify", "text_modify", "tim_stream"] },
    fallbackPolicy: { type: "string", enum: ["strict", "final_text"] },
    overflowPolicy: { type: "string", enum: ["stop", "split"] },
    chunkMode: { type: "string" },
    dm: dmSchema,
  },
  additionalProperties: false,
};

/**
 * Channel config schema for timbot-ws.
 * Named following openclaw convention: *ChannelConfigSchema for auto-discovery.
 */
export const TimbotWsChannelConfigSchema: ChannelConfigSchema = {
  schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      sdkAppId: { type: "string" },
      userId: { type: "string" },
      userSig: { type: "string" },
      welcomeText: { type: "string" },
      typingText: { type: "string" },
      typingDelayMs: { type: "number", minimum: 0 },
      streamingMode: { type: "string", enum: ["off", "custom_modify", "text_modify", "tim_stream"] },
      fallbackPolicy: { type: "string", enum: ["strict", "final_text"] },
      overflowPolicy: { type: "string", enum: ["stop", "split"] },
      chunkMode: { type: "string" },
      dm: dmSchema,
      defaultAccount: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: accountSchema,
      },
    },
    additionalProperties: false,
  },
};

/** @deprecated Use TimbotWsChannelConfigSchema instead */
export const timbotConfigSchema: ChannelConfigSchema = TimbotWsChannelConfigSchema;
