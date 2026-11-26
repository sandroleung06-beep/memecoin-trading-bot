import type { FilterConfig } from "../../config/filters.js";
import { bigintPct, type CheckResult, type FilterCheck, type TokenCandidate } from "../types.js";

/**
 * Rejects thin pools and positions too large for the pool. Impact is the intended buy as a
 * percent of the quote-side reserve, computed in integer units to stay exact.
 */
export function liquidityCheck(config: Pick<FilterConfig, "MIN_LIQUIDITY_USD" | "MAX_POOL_IMPACT_PCT">): FilterCheck {
  return {
    name: "liquidity",
    kind: "static",
    run(candidate: TokenCandidate): CheckResult {
      const { liquidityUsd, quoteReserve, baseReserve } = candidate.pool;
      const reasons: string[] = [];

      if (liquidityUsd < config.MIN_LIQUIDITY_USD) {
        reasons.push(`LIQUIDITY_BELOW_MIN: liquidityUsd=${liquidityUsd} min=${config.MIN_LIQUIDITY_USD}`);
      }
      if (quoteReserve === 0n || baseReserve === 0n) {
        reasons.push("POOL_RESERVES_EMPTY: cannot size against an empty pool");
        return { passed: false, reasons, metrics: { liquidityUsd, poolImpactPct: null } };
      }

      const poolImpactPct = bigintPct(candidate.intendedPositionQuote, quoteReserve);
      if (poolImpactPct > config.MAX_POOL_IMPACT_PCT) {
        reasons.push(`POOL_IMPACT_TOO_HIGH: impactPct=${poolImpactPct} max=${config.MAX_POOL_IMPACT_PCT}`);
      }
      return { passed: reasons.length === 0, reasons, metrics: { liquidityUsd, poolImpactPct } };
    },
  };
}
