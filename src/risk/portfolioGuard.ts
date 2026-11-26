import type { RiskConfig } from "../config/index.js";

export type GuardLimits = Pick<
  RiskConfig,
  "MAX_CONCURRENT_POSITIONS" | "TOKEN_REENTRY_COOLDOWN_MIN" | "MIN_RESERVE_SOL"
>;

export interface EntryRequest {
  readonly mint: string;
  /** Mints of currently open positions (including pending entries). */
  readonly openMints: ReadonlySet<string>;
  /** Spendable SOL in the wallet right now. */
  readonly walletSol: number;
  /** SOL the entry will spend: size plus network, priority and swap fees. */
  readonly entryCostSol: number;
}

export type GuardDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "invalid_input" | "max_concurrent" | "already_open" | "cooldown" | "reserve";
      readonly detail: string;
    };

const MINUTE_MS = 60_000;

/**
 * Portfolio-level entry gate: concurrent position cap, per-token re-entry cooldown after a
 * stop-out, and a minimum SOL reserve for gas/priority fees. Time is injected via `now`.
 */
export class PortfolioGuard {
  readonly #limits: GuardLimits;
  readonly #now: () => number;
  /** mint -> epoch ms when re-entry becomes allowed. */
  readonly #cooldownUntil = new Map<string, number>();

  constructor(limits: GuardLimits, now: () => number) {
    this.#limits = limits;
    this.#now = now;
  }

  /** Call when a position on `mint` closes via its stop-loss. */
  recordStopOut(mint: string): void {
    const until = this.#now() + this.#limits.TOKEN_REENTRY_COOLDOWN_MIN * MINUTE_MS;
    this.#cooldownUntil.set(mint, Math.max(until, this.#cooldownUntil.get(mint) ?? 0));
  }

  /** Remaining cooldown for `mint` in ms (0 if none). */
  cooldownRemainingMs(mint: string): number {
    const until = this.#cooldownUntil.get(mint);
    if (until === undefined) return 0;
    const left = until - this.#now();
    if (left <= 0) {
      this.#cooldownUntil.delete(mint);
      return 0;
    }
    return left;
  }

  check(req: EntryRequest): GuardDecision {
    const { walletSol, entryCostSol } = req;
    if (!Number.isFinite(walletSol) || walletSol < 0 || !Number.isFinite(entryCostSol) || entryCostSol <= 0) {
      return deny("invalid_input", "walletSol must be >= 0 and entryCostSol > 0");
    }
    if (req.openMints.has(req.mint)) return deny("already_open", "a position on this token is already open");
    if (req.openMints.size >= this.#limits.MAX_CONCURRENT_POSITIONS) {
      return deny("max_concurrent", `${req.openMints.size}/${this.#limits.MAX_CONCURRENT_POSITIONS} positions open`);
    }
    const left = this.cooldownRemainingMs(req.mint);
    if (left > 0) return deny("cooldown", `re-entry blocked for ${Math.ceil(left / MINUTE_MS)} more min`);

    const remaining = walletSol - entryCostSol;
    if (remaining < this.#limits.MIN_RESERVE_SOL) {
      return deny("reserve", `would leave ${remaining} SOL, reserve is ${this.#limits.MIN_RESERVE_SOL} SOL`);
    }
    return { allowed: true };
  }
}

function deny(reason: Exclude<GuardDecision, { allowed: true }>["reason"], detail: string): GuardDecision {
  return { allowed: false, reason, detail };
}
