import type { AppConfig, FilterConfig, RiskConfig } from "../config/index.js";

/**
 * Narrow view of the Grok/LLM signal. Signals are advisory: they can only shrink a size or veto
 * it, never enlarge it past the deterministic caps below.
 */
export type ActionBias = "strong_interest" | "watch" | "avoid";
export interface SizingSignal {
  readonly actionBias: ActionBias;
}

/** Size multiplier per bias. Anything not listed (including unexpected runtime values) is 0. */
export const BIAS_MULTIPLIER: Readonly<Record<ActionBias, number>> = Object.freeze({
  strong_interest: 1,
  watch: 0.5,
  avoid: 0,
});

export type SizingLimits = Pick<AppConfig, "MAX_POSITION_USD" | "MAX_POSITION_SOL"> &
  Pick<FilterConfig, "MAX_POOL_IMPACT_PCT"> &
  Pick<RiskConfig, "MAX_RISK_PER_TRADE_PCT">;

export interface SizingInput {
  /** Capital available for trading in USD (wallet value minus the gas reserve). */
  readonly activeBankrollUsd: number;
  /** Distance from entry to stop-loss, as a percent of entry, in (0, 100]. */
  readonly stopLossPct: number;
  /** USD value of the pool's quote-side reserve (the side we buy with). */
  readonly poolQuoteLiquidityUsd: number;
  /** Needed only when MAX_POSITION_SOL is set; a missing or bad price then sizes to 0. */
  readonly solPriceUsd?: number;
  readonly signal: SizingSignal;
}

export type SizingCap = "risk" | "max_position_usd" | "max_position_sol" | "pool_impact";

export type SizingResult =
  | {
      readonly sizeUsd: number;
      /** The cap that set the pre-signal size. */
      readonly bindingCap: SizingCap;
      readonly biasMultiplier: number;
      /** Size before the signal multiplier. */
      readonly cappedUsd: number;
    }
  | { readonly sizeUsd: 0; readonly blocked: "invalid_input" | "signal_avoid"; readonly detail: string };

const isPos = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Pure. Size = min(risk-based size, USD cap, SOL cap, pool-impact cap) x signal multiplier.
 *
 * Risk-based size is the position whose loss at the stop equals MAX_RISK_PER_TRADE_PCT of the
 * active bankroll: bankroll x risk% / stop%. With a 100% stop it is simply risk% of bankroll.
 * A zero MAX_POSITION_USD / MAX_POSITION_SOL means "not set" (same meaning as in schema.ts).
 * Any bad input fails closed to size 0.
 */
export function sizePosition(limits: SizingLimits, input: SizingInput): SizingResult {
  const multiplier = Object.hasOwn(BIAS_MULTIPLIER, input.signal.actionBias)
    ? BIAS_MULTIPLIER[input.signal.actionBias]
    : 0;
  if (multiplier === 0) {
    return { sizeUsd: 0, blocked: "signal_avoid", detail: `actionBias=${String(input.signal.actionBias)}` };
  }
  if (!isPos(input.activeBankrollUsd)) return invalid("activeBankrollUsd must be > 0");
  if (!isPos(input.stopLossPct) || input.stopLossPct > 100) return invalid("stopLossPct must be in (0, 100]");
  if (!isPos(input.poolQuoteLiquidityUsd)) return invalid("poolQuoteLiquidityUsd must be > 0");

  const caps: [SizingCap, number][] = [
    ["risk", (input.activeBankrollUsd * limits.MAX_RISK_PER_TRADE_PCT) / input.stopLossPct],
    ["pool_impact", (input.poolQuoteLiquidityUsd * limits.MAX_POOL_IMPACT_PCT) / 100],
  ];
  if (limits.MAX_POSITION_USD > 0) caps.push(["max_position_usd", limits.MAX_POSITION_USD]);
  if (limits.MAX_POSITION_SOL > 0) {
    if (!isPos(input.solPriceUsd)) return invalid("solPriceUsd must be > 0 when MAX_POSITION_SOL is set");
    caps.push(["max_position_sol", limits.MAX_POSITION_SOL * input.solPriceUsd]);
  }
  // Never size above the bankroll itself, whatever the stop distance.
  const [bindingCap, cappedRaw] = caps.reduce((min, c) => (c[1] < min[1] ? c : min));
  const cappedUsd = Math.min(cappedRaw, input.activeBankrollUsd);

  return { sizeUsd: cappedUsd * multiplier, bindingCap, biasMultiplier: multiplier, cappedUsd };
}

function invalid(detail: string): SizingResult {
  return { sizeUsd: 0, blocked: "invalid_input", detail };
}
