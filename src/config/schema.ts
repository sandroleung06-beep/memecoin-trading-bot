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

export const rawEnvSchema = z.object({
  EXECUTION_MODE: z.enum(["PAPER", "LIVE"]).default("PAPER"),
  LIVE_TRADING_ENABLED: strictBoolean,
  MAX_POSITION_SOL: nonNegativeNumber,
  MAX_POSITION_USD: nonNegativeNumber,
  SOLANA_RPC_URL: z.url({ protocol: /^(https?|wss?)$/ }),
  WALLET_PRIVATE_KEY: optionalSecret,
  LLM_API_KEY: optionalSecret,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const envSchema = rawEnvSchema.superRefine((env, ctx) => {
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
