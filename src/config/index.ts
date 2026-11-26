import { toConfigError } from "./errors.js";
import { envSchema, type AppConfig } from "./schema.js";

export { ConfigError } from "./errors.js";
export { parseFilterConfig, type FilterConfig } from "./filters.js";
export { parseRiskConfig, type RiskConfig } from "./risk.js";
export type { AppConfig } from "./schema.js";

/** Keys whose values must never appear in logs or error messages. */
const SECRET_KEYS = new Set(["WALLET_PRIVATE_KEY", "LLM_API_KEY", "SOLANA_RPC_URL"]);

/**
 * Pure: validates the given env record and returns a frozen config, or throws ConfigError.
 * Error messages name the offending keys but never echo their values.
 */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) throw toConfigError(result.error, SECRET_KEYS);
  return Object.freeze(result.data);
}

/**
 * Loads `.env` into process.env (without overriding already-set variables), then validates.
 * Call once at startup; any problem throws before the bot does anything else.
 */
export async function loadConfig(): Promise<AppConfig> {
  const dotenv = await import("dotenv");
  dotenv.config({ quiet: true });
  return parseConfig(process.env);
}
