import { envSchema, type AppConfig } from "./schema.js";

export type { AppConfig } from "./schema.js";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.issues = issues;
  }
}

/** Keys whose values must never appear in logs or error messages. */
const SECRET_KEYS = new Set(["WALLET_PRIVATE_KEY", "LLM_API_KEY", "XAI_API_KEY", "SOLANA_RPC_URL"]);

/**
 * Pure: validates the given env record and returns a frozen config, or throws ConfigError.
 * Error messages name the offending keys but never echo their values.
 */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      const message = SECRET_KEYS.has(key) && issue.code !== "custom" ? "missing or invalid" : issue.message;
      return `${key}: ${message}`;
    });
    throw new ConfigError(issues);
  }
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
