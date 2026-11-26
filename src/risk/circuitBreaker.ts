import type { RiskConfig } from "../config/index.js";
import type { HaltReason, HaltRecord, HaltStore } from "./haltStore.js";

export type BreakerLimits = Pick<
  RiskConfig,
  | "MAX_DAILY_DRAWDOWN_PCT"
  | "MAX_CONSECUTIVE_LOSSES"
  | "RISK_WINDOW_MIN"
  | "MAX_RPC_ERROR_RATE_PCT"
  | "RPC_ERROR_MIN_SAMPLES"
  | "MAX_AVG_SLIPPAGE_PCT"
  | "SLIPPAGE_MIN_SAMPLES"
  | "MAX_SINGLE_FILL_SLIPPAGE_PCT"
>;

export type BreakerState = "ARMED" | "HALTED";

export interface EquitySnapshot {
  /** Account equity (USD) at the start of the trading day. */
  readonly dayStartEquityUsd: number;
  /** PnL already realized today. */
  readonly realizedPnlUsd: number;
  /** Mark-to-market PnL of open positions. */
  readonly unrealizedPnlUsd: number;
}

interface Sample {
  readonly t: number;
  readonly v: number;
}

/**
 * Trips into HALTED when any of these hold, and stays halted until a human runs the reset CLI
 * (`npm run risk:reset -- --confirm`), even across restarts:
 *  a) today's realized + unrealized loss exceeds MAX_DAILY_DRAWDOWN_PCT of start-of-day equity;
 *  b) MAX_CONSECUTIVE_LOSSES losing closes in a row;
 *  c) over the rolling RISK_WINDOW_MIN window, the RPC error rate reaches MAX_RPC_ERROR_RATE_PCT
 *     (with at least RPC_ERROR_MIN_SAMPLES calls), mean slippage reaches MAX_AVG_SLIPPAGE_PCT
 *     (with at least SLIPPAGE_MIN_SAMPLES fills), or one fill reaches MAX_SINGLE_FILL_SLIPPAGE_PCT.
 * Malformed inputs and unreadable persisted state also halt (fail closed).
 */
export class CircuitBreaker {
  readonly #limits: BreakerLimits;
  readonly #store: HaltStore;
  readonly #now: () => number;
  #halt: HaltRecord | null = null;
  /** False if the halt could not be written yet; it is retried and never auto-cleared. */
  #persisted = false;
  #consecutiveLosses = 0;
  #rpc: Sample[] = [];
  #fills: Sample[] = [];

  constructor(limits: BreakerLimits, store: HaltStore, now: () => number) {
    this.#limits = limits;
    this.#store = store;
    this.#now = now;
    try {
      this.#halt = store.load();
      this.#persisted = this.#halt !== null;
    } catch {
      this.#halt = this.#record("corrupt_state", "halt state file is unreadable; inspect it, then reset");
      this.#persisted = true; // leave the unreadable file in place as evidence; only the reset CLI removes it
    }
  }

  get state(): BreakerState {
    this.#syncWithStore();
    return this.#halt === null ? "ARMED" : "HALTED";
  }

  get halt(): HaltRecord | null {
    this.#syncWithStore();
    return this.#halt;
  }

  isTradingAllowed(): boolean {
    return this.state === "ARMED";
  }

  get consecutiveLosses(): number {
    return this.#consecutiveLosses;
  }

  recordEquity(s: EquitySnapshot): void {
    const values = [s.dayStartEquityUsd, s.realizedPnlUsd, s.unrealizedPnlUsd];
    if (!values.every(Number.isFinite) || s.dayStartEquityUsd <= 0) {
      this.#trip("invalid_input", "equity snapshot is not finite or start-of-day equity <= 0");
      return;
    }
    const pnl = s.realizedPnlUsd + s.unrealizedPnlUsd;
    const drawdownPct = (Math.max(0, -pnl) / s.dayStartEquityUsd) * 100;
    if (drawdownPct > this.#limits.MAX_DAILY_DRAWDOWN_PCT) {
      this.#trip(
        "daily_drawdown",
        `daily drawdown ${drawdownPct.toFixed(2)}% > ${this.#limits.MAX_DAILY_DRAWDOWN_PCT}%`,
      );
    }
  }

  /** Call once per closed position. A loss (or non-finite PnL) extends the streak; a non-loss resets it. */
  recordTradeClose(pnlUsd: number): void {
    if (Number.isFinite(pnlUsd) && pnlUsd >= 0) {
      this.#consecutiveLosses = 0;
      return;
    }
    this.#consecutiveLosses += 1;
    if (this.#consecutiveLosses >= this.#limits.MAX_CONSECUTIVE_LOSSES) {
      this.#trip("consecutive_losses", `${this.#consecutiveLosses} consecutive losing trades`);
    }
  }

  recordRpcResult(ok: boolean): void {
    this.#rpc.push({ t: this.#now(), v: ok ? 0 : 1 });
    this.#prune();
    const n = this.#rpc.length;
    if (n < this.#limits.RPC_ERROR_MIN_SAMPLES) return;
    const ratePct = (this.#rpc.reduce((a, s) => a + s.v, 0) / n) * 100;
    if (ratePct >= this.#limits.MAX_RPC_ERROR_RATE_PCT) {
      this.#trip(
        "rpc_error_rate",
        `RPC error rate ${ratePct.toFixed(1)}% over ${n} calls in ${this.#limits.RISK_WINDOW_MIN} min`,
      );
    }
  }

  /** Adverse slippage of a fill vs. its quote, in percent. Negative means price improvement. */
  recordFillSlippage(slippagePct: number): void {
    if (!Number.isFinite(slippagePct)) {
      this.#trip("invalid_input", "fill slippage is not a finite number");
      return;
    }
    if (slippagePct >= this.#limits.MAX_SINGLE_FILL_SLIPPAGE_PCT) {
      this.#trip(
        "slippage_spike",
        `single fill slippage ${slippagePct}% >= ${this.#limits.MAX_SINGLE_FILL_SLIPPAGE_PCT}%`,
      );
      return;
    }
    this.#fills.push({ t: this.#now(), v: slippagePct });
    this.#prune();
    const n = this.#fills.length;
    if (n < this.#limits.SLIPPAGE_MIN_SAMPLES) return;
    const mean = this.#fills.reduce((a, s) => a + s.v, 0) / n;
    if (mean >= this.#limits.MAX_AVG_SLIPPAGE_PCT) {
      this.#trip(
        "slippage_spike",
        `mean slippage ${mean.toFixed(2)}% over ${n} fills in ${this.#limits.RISK_WINDOW_MIN} min`,
      );
    }
  }

  #prune(): void {
    const cutoff = this.#now() - this.#limits.RISK_WINDOW_MIN * 60_000;
    this.#rpc = this.#rpc.filter((s) => s.t > cutoff);
    this.#fills = this.#fills.filter((s) => s.t > cutoff);
  }

  #record(reason: HaltReason, detail: string): HaltRecord {
    return Object.freeze({ reason, detail, haltedAt: new Date(this.#now()).toISOString() });
  }

  #trip(reason: HaltReason, detail: string): void {
    if (this.#halt !== null) return; // keep the first cause
    this.#halt = this.#record(reason, detail);
    this.#persist();
  }

  #persist(): void {
    if (this.#halt === null) return;
    try {
      this.#store.save(this.#halt);
      this.#persisted = true;
    } catch {
      this.#persisted = false; // stay halted in memory; retried on the next state check
    }
  }

  /**
   * While halted, re-read the store: once the reset CLI has cleared it, re-arm with fresh
   * counters. A halt that was never persisted, or an unreadable store, keeps the halt.
   */
  #syncWithStore(): void {
    if (this.#halt === null) return;
    if (!this.#persisted) {
      this.#persist();
      return;
    }
    let stored: HaltRecord | null;
    try {
      stored = this.#store.load();
    } catch {
      return;
    }
    if (stored !== null) return;
    this.#halt = null;
    this.#persisted = false;
    this.#consecutiveLosses = 0;
    this.#rpc = [];
    this.#fills = [];
  }
}
