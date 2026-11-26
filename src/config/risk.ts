import { z } from "zod";
import { toConfigError } from "./errors.js";

/**
 * Risk limits and circuit-breaker thresholds. Like the filter thresholds, every limit has a
 * conservative default and can be tuned but never switched off: percentages must be in (0, 100],
 * counts and durations must be positive, and anything malformed throws ConfigError at startup.
 *
 * MAX_POSITION_USD / MAX_POSITION_SOL live in `schema.ts`; MAX_POOL_IMPACT_PCT lives in
 * `filters.ts`. They are reused here, not duplicated.
 */

const pct = (fallback: number) => z.coerce.number().finite().gt(0).lte(100).default(fallback);
const posInt = (fallback: number, max: number) => z.coerce.number().int().positive().max(max).default(fallback);

export const riskEnvSchema = z.object({
  /** Max share of active bankroll lost if a trade hits its stop. */
  MAX_RISK_PER_TRADE_PCT: pct(1),
  MAX_CONCURRENT_POSITIONS: posInt(3, 100),
  /** Minutes a token is blocked after a stop-out on it. */
  TOKEN_REENTRY_COOLDOWN_MIN: z.coerce.number().finite().positive().max(10_080).default(60),
  /** SOL that must remain after any entry, for gas and priority fees. */
  MIN_RESERVE_SOL: z.coerce.number().finite().positive().default(0.05),

  /** Halt when today's realized + unrealized loss exceeds this share of start-of-day equity. */
  MAX_DAILY_DRAWDOWN_PCT: pct(8),
  /** Halt after this many losing closes in a row. */
  MAX_CONSECUTIVE_LOSSES: posInt(4, 1_000),
  /** Rolling window for RPC error rate and slippage, in minutes. */
  RISK_WINDOW_MIN: z.coerce.number().finite().positive().max(1_440).default(10),
  /** Halt when the share of failed RPC calls in the window reaches this. */
  MAX_RPC_ERROR_RATE_PCT: pct(25),
  /** RPC calls needed in the window before the error rate is judged (avoids 1-of-1 = 100%). */
  RPC_ERROR_MIN_SAMPLES: posInt(20, 100_000),
  /** Halt when mean realized slippage over fills in the window reaches this. */
  MAX_AVG_SLIPPAGE_PCT: pct(5),
  SLIPPAGE_MIN_SAMPLES: posInt(3, 10_000),
  /** Any single fill at or above this slippage halts immediately. */
  MAX_SINGLE_FILL_SLIPPAGE_PCT: pct(15),

  /** Where a halt is persisted so it survives restarts until cleared with `npm run risk:reset`. */
  HALT_STATE_FILE: z.string().trim().min(1).default("data/circuit-breaker.json"),
});

export type RiskConfig = Readonly<z.output<typeof riskEnvSchema>>;

export function parseRiskConfig(env: Record<string, string | undefined>): RiskConfig {
  const result = riskEnvSchema.safeParse(env);
  if (!result.success) throw toConfigError(result.error);
  return Object.freeze(result.data);
}
