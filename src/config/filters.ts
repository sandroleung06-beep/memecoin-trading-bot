import { z } from "zod";
import { toConfigError } from "./errors.js";

/**
 * Pre-trade safety gate thresholds. Every value has a conservative default, and anything
 * malformed throws at startup. A threshold can be tightened or relaxed but never switched off:
 * percentages must be in (0, 100] and the liquidity floor must be positive.
 */

/** Only the literal strings "true"/"false" are accepted. Defaults to the safe setting (true). */
const strictBooleanDefaultTrue = z
  .enum(["true", "false"])
  .default("true")
  .transform((v) => v === "true");

const pct = (fallback: number) => z.coerce.number().finite().gt(0).lte(100).default(fallback);

export const filterEnvSchema = z.object({
  REQUIRE_MINT_AUTHORITY_REVOKED: strictBooleanDefaultTrue,
  REQUIRE_FREEZE_AUTHORITY_REVOKED: strictBooleanDefaultTrue,
  /** Minimum pool liquidity (both sides, USD). */
  MIN_LIQUIDITY_USD: z.coerce.number().finite().positive().default(20_000),
  /** Max intended buy size as a percent of the pool's quote-side reserve. */
  MAX_POOL_IMPACT_PCT: pct(1.5),
  /** Max combined supply held by the 10 largest non-LP holders. */
  MAX_TOP10_PCT: pct(30),
  /** Max supply acquired by wallets bundled into the launch slot. */
  MAX_BUNDLED_PCT: pct(15),
  /** Max loss on a simulated buy then immediate sell (taxes + fees + slippage). */
  MAX_ROUNDTRIP_LOSS_PCT: pct(10),
  /** Hard cap on sell simulation latency; a slower simulation is treated as a failure. */
  SELL_SIMULATION_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(5_000),
});

export type FilterConfig = Readonly<z.output<typeof filterEnvSchema>>;

export function parseFilterConfig(env: Record<string, string | undefined>): FilterConfig {
  const result = filterEnvSchema.safeParse(env);
  if (!result.success) throw toConfigError(result.error);
  return Object.freeze(result.data);
}
