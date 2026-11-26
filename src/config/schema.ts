import { z } from "zod";

/** Treat empty strings as "not set" so `KEY=` in .env behaves like a missing key. */
const optionalSecret = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

/** Only the literal string "true" enables a flag. "1", "yes", "TRUE " etc. do not. */
const strictBoolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const nonNegativeNumber = z.coerce.number().finite().nonnegative().default(0);

/** Grok model ids: conservative charset so a typo or injected value cannot reach the request body. */
const modelId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be a model id like grok-4.1-fast");

export const rawEnvSchema = z.object({
  EXECUTION_MODE: z.enum(["PAPER", "LIVE"]).default("PAPER"),
  LIVE_TRADING_ENABLED: strictBoolean,
  MAX_POSITION_SOL: nonNegativeNumber,
  MAX_POSITION_USD: nonNegativeNumber,
  SOLANA_RPC_URL: z.url({ protocol: /^(https?|wss?)$/ }),
  WALLET_PRIVATE_KEY: optionalSecret,
  LLM_API_KEY: optionalSecret,
  // --- Grok / xAI social signals (advisory only) ---
  GROK_ENABLED: strictBoolean,
  XAI_API_KEY: optionalSecret,
  /** Cheap model used for first-pass triage of every candidate. */
  GROK_MODEL: modelId.default("grok-4.1-fast"),
  /** Stronger model, used only for candidates that passed every on-chain gate and the volume threshold. */
  GROK_ESCALATION_MODEL: modelId.default("grok-4.7"),
  GROK_ESCALATION_MIN_VOLUME_USD: z.coerce.number().finite().nonnegative().default(50_000),
  GROK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3_500),
  GROK_CACHE_TTL_SEC: z.coerce.number().int().nonnegative().max(86_400).default(300),
  /** Caps agentic x_search turns per request (cost control). */
  GROK_MAX_TOOL_TURNS: z.coerce.number().int().min(1).max(10).default(2),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const envSchema = rawEnvSchema.superRefine((env, ctx) => {
  if (env.GROK_ENABLED && env.XAI_API_KEY === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["XAI_API_KEY"],
      message: 'GROK_ENABLED="true" requires XAI_API_KEY',
    });
  }

  if (env.EXECUTION_MODE !== "LIVE") return;

  if (!env.LIVE_TRADING_ENABLED) {
    ctx.addIssue({
      code: "custom",
      path: ["LIVE_TRADING_ENABLED"],
      message: 'EXECUTION_MODE=LIVE requires LIVE_TRADING_ENABLED="true"',
    });
  }
  if (env.MAX_POSITION_SOL <= 0 && env.MAX_POSITION_USD <= 0) {
    ctx.addIssue({
      code: "custom",
      path: ["MAX_POSITION_SOL"],
      message: "EXECUTION_MODE=LIVE requires a non-zero MAX_POSITION_SOL or MAX_POSITION_USD cap",
    });
  }
  if (env.WALLET_PRIVATE_KEY === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["WALLET_PRIVATE_KEY"],
      message: "EXECUTION_MODE=LIVE requires WALLET_PRIVATE_KEY",
    });
  }
});

export type AppConfig = Readonly<z.output<typeof envSchema>>;
