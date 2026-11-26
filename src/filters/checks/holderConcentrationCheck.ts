import type { FilterConfig } from "../../config/filters.js";
import type { CheckResult, FilterCheck, Holder, TokenCandidate } from "../types.js";

/** Sum of the 10 largest non-LP holdings, rounded to 4 decimals. */
export function top10NonLpPct(holders: readonly Holder[]): number {
  const sum = holders
    .filter((h) => !h.isLiquidityPool)
    .map((h) => h.pct)
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((acc, pct) => acc + pct, 0);
  return Math.round(sum * 10_000) / 10_000;
}

/** Rejects supply concentrated in a few wallets or sniped by a launch-slot bundle. */
export function holderConcentrationCheck(config: Pick<FilterConfig, "MAX_TOP10_PCT" | "MAX_BUNDLED_PCT">): FilterCheck {
  return {
    name: "holderConcentration",
    kind: "static",
    run(candidate: TokenCandidate): CheckResult {
      const top10HolderPct = top10NonLpPct(candidate.holders);
      const { bundledLaunchPct } = candidate;
      const reasons: string[] = [];
      if (top10HolderPct > config.MAX_TOP10_PCT) {
        reasons.push(`TOP10_CONCENTRATION_TOO_HIGH: top10Pct=${top10HolderPct} max=${config.MAX_TOP10_PCT}`);
      }
      if (bundledLaunchPct > config.MAX_BUNDLED_PCT) {
        reasons.push(`BUNDLED_LAUNCH_TOO_HIGH: bundledPct=${bundledLaunchPct} max=${config.MAX_BUNDLED_PCT}`);
      }
      return { passed: reasons.length === 0, reasons, metrics: { top10HolderPct, bundledLaunchPct } };
    },
  };
}
