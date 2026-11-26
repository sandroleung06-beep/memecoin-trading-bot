import type { z } from "zod";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.issues = issues;
  }
}

/**
 * Converts zod issues to a ConfigError. For keys in `secretKeys`, built-in zod messages are
 * replaced so the offending value can never leak; custom (cross-field) messages are kept.
 */
export function toConfigError(error: z.ZodError, secretKeys: ReadonlySet<string> = new Set()): ConfigError {
  return new ConfigError(
    error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      const message = secretKeys.has(key) && issue.code !== "custom" ? "missing or invalid" : issue.message;
      return `${key}: ${message}`;
    }),
  );
}
