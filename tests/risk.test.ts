import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, parseRiskConfig, type RiskConfig } from "../src/config/index.js";
import {
  CircuitBreaker,
  FileHaltStore,
  MemoryHaltStore,
  PortfolioGuard,
  runReset,
  sizePosition,
  type ActionBias,
  type EntryRequest,
  type SizingInput,
  type SizingLimits,
} from "../src/risk/index.js";
import { FlakyHaltStore, MIN, T0, fakeClock } from "./fixtures/risk.js";

const risk: RiskConfig = parseRiskConfig({});

// ---------------------------------------------------------------------------------------------
describe("risk config", () => {
  it("has conservative defaults", () => {
    expect(risk).toMatchObject({
      MAX_RISK_PER_TRADE_PCT: 1,
      MAX_CONCURRENT_POSITIONS: 3,
      TOKEN_REENTRY_COOLDOWN_MIN: 60,
      MIN_RESERVE_SOL: 0.05,
      MAX_DAILY_DRAWDOWN_PCT: 8,
      MAX_CONSECUTIVE_LOSSES: 4,
      RISK_WINDOW_MIN: 10,
      MAX_RPC_ERROR_RATE_PCT: 25,
      RPC_ERROR_MIN_SAMPLES: 20,
      MAX_AVG_SLIPPAGE_PCT: 5,
      SLIPPAGE_MIN_SAMPLES: 3,
      MAX_SINGLE_FILL_SLIPPAGE_PCT: 15,
      HALT_STATE_FILE: "data/circuit-breaker.json",
    });
    expect(Object.isFrozen(risk)).toBe(true);
  });

  it("parses overrides", () => {
    expect(parseRiskConfig({ MAX_CONCURRENT_POSITIONS: "5", MAX_RISK_PER_TRADE_PCT: "0.5" })).toMatchObject({
      MAX_CONCURRENT_POSITIONS: 5,
      MAX_RISK_PER_TRADE_PCT: 0.5,
    });
  });

  it.each([
    ["MAX_RISK_PER_TRADE_PCT", "0"],
    ["MAX_RISK_PER_TRADE_PCT", "101"],
    ["MAX_DAILY_DRAWDOWN_PCT", "-1"],
    ["MAX_CONCURRENT_POSITIONS", "0"],
    ["MAX_CONCURRENT_POSITIONS", "2.5"],
    ["MAX_CONSECUTIVE_LOSSES", "abc"],
    ["MIN_RESERVE_SOL", "0"],
    ["TOKEN_REENTRY_COOLDOWN_MIN", "0"],
    ["RISK_WINDOW_MIN", "0"],
    ["MAX_RPC_ERROR_RATE_PCT", "0"],
    ["HALT_STATE_FILE", "  "],
  ])("rejects %s=%j (limits cannot be disabled)", (key, value) => {
    expect(() => parseRiskConfig({ [key]: value })).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------------------------
describe("positionSizer", () => {
  const limits: SizingLimits = {
    MAX_RISK_PER_TRADE_PCT: 1,
    MAX_POOL_IMPACT_PCT: 1.5,
    MAX_POSITION_USD: 0,
    MAX_POSITION_SOL: 0,
  };
  const input = (over: Partial<SizingInput> = {}): SizingInput => ({
    activeBankrollUsd: 10_000,
    stopLossPct: 20,
    poolQuoteLiquidityUsd: 1_000_000,
    signal: { actionBias: "strong_interest" },
    ...over,
  });

  it("sizes so a stop-out loses MAX_RISK_PER_TRADE_PCT of bankroll", () => {
    // 1% of 10k = $100 at risk; with a 20% stop that is a $500 position.
    const r = sizePosition(limits, input());
    expect(r).toEqual({ sizeUsd: 500, bindingCap: "risk", biasMultiplier: 1, cappedUsd: 500 });
    expect(r.sizeUsd * 0.2).toBeCloseTo(10_000 * 0.01);
  });

  it("with a 100% stop the size is exactly the risk fraction of bankroll", () => {
    expect(sizePosition(limits, input({ stopLossPct: 100 })).sizeUsd).toBe(100);
  });

  it("never sizes above the bankroll, however tight the stop", () => {
    const r = sizePosition(limits, input({ stopLossPct: 0.5, poolQuoteLiquidityUsd: 1e9 }));
    expect(r.sizeUsd).toBe(10_000);
  });

  it("caps at MAX_POSITION_USD", () => {
    expect(sizePosition({ ...limits, MAX_POSITION_USD: 200 }, input())).toMatchObject({
      sizeUsd: 200,
      bindingCap: "max_position_usd",
    });
  });

  it("caps at MAX_POSITION_SOL using the SOL price", () => {
    expect(sizePosition({ ...limits, MAX_POSITION_SOL: 1 }, input({ solPriceUsd: 150 }))).toMatchObject({
      sizeUsd: 150,
      bindingCap: "max_position_sol",
    });
  });

  it("fails closed when MAX_POSITION_SOL is set but the SOL price is missing or bad", () => {
    for (const solPriceUsd of [undefined, 0, -1, Number.NaN]) {
      const over: Partial<SizingInput> = solPriceUsd === undefined ? {} : { solPriceUsd };
      expect(sizePosition({ ...limits, MAX_POSITION_SOL: 1 }, input(over))).toMatchObject({
        sizeUsd: 0,
        blocked: "invalid_input",
      });
    }
  });

  it("caps at MAX_POOL_IMPACT_PCT of quote-side liquidity", () => {
    // 1.5% of $20k = $300 < $500 risk size.
    expect(sizePosition(limits, input({ poolQuoteLiquidityUsd: 20_000 }))).toMatchObject({
      sizeUsd: 300,
      bindingCap: "pool_impact",
    });
    expect(sizePosition({ ...limits, MAX_POOL_IMPACT_PCT: 1 }, input({ poolQuoteLiquidityUsd: 20_000 })).sizeUsd).toBe(200);
  });

  it("halves the size for watch vs strong_interest, after every cap", () => {
    const strong = sizePosition({ ...limits, MAX_POSITION_USD: 200 }, input());
    const watch = sizePosition({ ...limits, MAX_POSITION_USD: 200 }, input({ signal: { actionBias: "watch" } }));
    expect(watch).toMatchObject({ sizeUsd: 100, biasMultiplier: 0.5, cappedUsd: 200 });
    expect(watch.sizeUsd).toBe(strong.sizeUsd / 2);
  });

  it("sizes avoid to 0 (fails closed)", () => {
    expect(sizePosition(limits, input({ signal: { actionBias: "avoid" } }))).toMatchObject({
      sizeUsd: 0,
      blocked: "signal_avoid",
    });
  });

  it("sizes an unknown actionBias to 0", () => {
    for (const bias of ["buy", "", "__proto__", "toString"]) {
      const r = sizePosition(limits, input({ signal: { actionBias: bias as ActionBias } }));
      expect(r).toMatchObject({ sizeUsd: 0, blocked: "signal_avoid" });
    }
  });

  it.each([
    ["activeBankrollUsd", 0],
    ["activeBankrollUsd", -5],
    ["activeBankrollUsd", Number.POSITIVE_INFINITY],
    ["stopLossPct", 0],
    ["stopLossPct", 101],
    ["stopLossPct", Number.NaN],
    ["poolQuoteLiquidityUsd", 0],
    ["poolQuoteLiquidityUsd", Number.NaN],
  ])("fails closed on %s=%s", (key, value) => {
    expect(sizePosition(limits, input({ [key]: value }))).toMatchObject({ sizeUsd: 0, blocked: "invalid_input" });
  });

  it("never exceeds any cap across a deterministic grid", () => {
    const capped: SizingLimits = { MAX_RISK_PER_TRADE_PCT: 2, MAX_POOL_IMPACT_PCT: 1, MAX_POSITION_USD: 750, MAX_POSITION_SOL: 4 };
    const solPriceUsd = 150;
    for (const bankroll of [100, 5_000, 50_000, 1_000_000]) {
      for (const stop of [1, 10, 35, 100]) {
        for (const liq of [1_000, 30_000, 5_000_000]) {
          for (const bias of ["strong_interest", "watch"] as const) {
            const { sizeUsd } = sizePosition(capped, {
              activeBankrollUsd: bankroll,
              stopLossPct: stop,
              poolQuoteLiquidityUsd: liq,
              solPriceUsd,
              signal: { actionBias: bias },
            });
            expect(sizeUsd).toBeGreaterThan(0);
            expect(sizeUsd * (stop / 100)).toBeLessThanOrEqual(bankroll * 0.02 + 1e-9);
            expect(sizeUsd).toBeLessThanOrEqual(750);
            expect(sizeUsd).toBeLessThanOrEqual(4 * solPriceUsd);
            expect(sizeUsd).toBeLessThanOrEqual(liq * 0.01 + 1e-9);
            expect(sizeUsd).toBeLessThanOrEqual(bankroll);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("portfolioGuard", () => {
  const MINT_A = "MintA";
  const setup = () => {
    const clock = fakeClock();
    const guard = new PortfolioGuard(risk, clock.now);
    const req = (over: Partial<EntryRequest> = {}): EntryRequest => ({
      mint: MINT_A,
      openMints: new Set(),
      walletSol: 10,
      entryCostSol: 1,
      ...over,
    });
    return { clock, guard, req };
  };

  it("allows an entry within every limit", () => {
    const { guard, req } = setup();
    expect(guard.check(req())).toEqual({ allowed: true });
  });

  it("enforces MAX_CONCURRENT_POSITIONS", () => {
    const { guard, req } = setup();
    expect(guard.check(req({ openMints: new Set(["X", "Y"]) })).allowed).toBe(true);
    expect(guard.check(req({ openMints: new Set(["X", "Y", "Z"]) }))).toMatchObject({
      allowed: false,
      reason: "max_concurrent",
    });
    expect(guard.check(req({ openMints: new Set(["W", "X", "Y", "Z"]) }))).toMatchObject({ reason: "max_concurrent" });
  });

  it("respects a custom concurrent limit", () => {
    const guard = new PortfolioGuard({ ...risk, MAX_CONCURRENT_POSITIONS: 1 }, fakeClock().now);
    const base = { mint: MINT_A, walletSol: 10, entryCostSol: 1 };
    expect(guard.check({ ...base, openMints: new Set() }).allowed).toBe(true);
    expect(guard.check({ ...base, openMints: new Set(["X"]) })).toMatchObject({ reason: "max_concurrent" });
  });

  it("refuses a second position on a token already held", () => {
    const { guard, req } = setup();
    expect(guard.check(req({ openMints: new Set([MINT_A]) }))).toMatchObject({ reason: "already_open" });
  });

  it("blocks re-entry for TOKEN_REENTRY_COOLDOWN_MIN after a stop-out, per token", () => {
    const { clock, guard, req } = setup();
    guard.recordStopOut(MINT_A);
    expect(guard.check(req())).toMatchObject({ allowed: false, reason: "cooldown" });
    expect(guard.check(req({ mint: "MintB" })).allowed).toBe(true);

    clock.advance(60 * MIN - 1);
    expect(guard.check(req())).toMatchObject({ reason: "cooldown" });
    expect(guard.cooldownRemainingMs(MINT_A)).toBe(1);

    clock.advance(1);
    expect(guard.check(req())).toEqual({ allowed: true });
    expect(guard.cooldownRemainingMs(MINT_A)).toBe(0);
  });

  it("a later stop-out extends the cooldown", () => {
    const { clock, guard, req } = setup();
    guard.recordStopOut(MINT_A);
    clock.advance(30 * MIN);
    guard.recordStopOut(MINT_A);
    clock.advance(45 * MIN);
    expect(guard.check(req())).toMatchObject({ reason: "cooldown" });
  });

  it("keeps MIN_RESERVE_SOL for gas and priority fees", () => {
    const { guard, req } = setup();
    expect(guard.check(req({ walletSol: 1.05, entryCostSol: 1 })).allowed).toBe(true);
    expect(guard.check(req({ walletSol: 1.04, entryCostSol: 1 }))).toMatchObject({ reason: "reserve" });
    expect(guard.check(req({ walletSol: 0.5, entryCostSol: 1 }))).toMatchObject({ reason: "reserve" });
  });

  it.each([
    { walletSol: Number.NaN },
    { walletSol: -1 },
    { entryCostSol: 0 },
    { entryCostSol: Number.POSITIVE_INFINITY },
  ])("fails closed on bad input %o", (over) => {
    const { guard, req } = setup();
    expect(guard.check(req(over))).toMatchObject({ allowed: false, reason: "invalid_input" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("circuitBreaker", () => {
  const setup = (over: Partial<RiskConfig> = {}) => {
    const clock = fakeClock();
    const store = new MemoryHaltStore();
    const breaker = new CircuitBreaker({ ...risk, ...over }, store, clock.now);
    return { clock, store, breaker };
  };
  const equity = (pnl: number, unrealized = 0) => ({
    dayStartEquityUsd: 10_000,
    realizedPnlUsd: pnl,
    unrealizedPnlUsd: unrealized,
  });

  it("starts ARMED", () => {
    const { breaker } = setup();
    expect(breaker.state).toBe("ARMED");
    expect(breaker.isTradingAllowed()).toBe(true);
    expect(breaker.halt).toBeNull();
  });

  describe("a) daily drawdown", () => {
    it("trips when realized + unrealized loss exceeds MAX_DAILY_DRAWDOWN_PCT", () => {
      const { breaker, store } = setup();
      breaker.recordEquity(equity(-500, -300)); // exactly 8%: not exceeded
      expect(breaker.state).toBe("ARMED");
      breaker.recordEquity(equity(-500, -301));
      expect(breaker.state).toBe("HALTED");
      expect(breaker.halt).toMatchObject({ reason: "daily_drawdown", haltedAt: new Date(T0).toISOString() });
      expect(store.record?.reason).toBe("daily_drawdown");
    });

    it("counts unrealized losses alone", () => {
      const { breaker } = setup();
      breaker.recordEquity(equity(0, -900));
      expect(breaker.halt?.reason).toBe("daily_drawdown");
    });

    it("lets unrealized gains offset realized losses", () => {
      const { breaker } = setup();
      breaker.recordEquity(equity(-1_000, 400));
      expect(breaker.state).toBe("ARMED");
    });

    it.each([
      { dayStartEquityUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
      { dayStartEquityUsd: 10_000, realizedPnlUsd: Number.NaN, unrealizedPnlUsd: 0 },
      { dayStartEquityUsd: 10_000, realizedPnlUsd: 0, unrealizedPnlUsd: Number.NEGATIVE_INFINITY },
    ])("fails closed on a bad snapshot %o", (snap) => {
      const { breaker } = setup();
      breaker.recordEquity(snap);
      expect(breaker.halt?.reason).toBe("invalid_input");
    });
  });

  describe("b) consecutive losses", () => {
    it("trips on the MAX_CONSECUTIVE_LOSSES-th loss in a row", () => {
      const { breaker } = setup();
      for (let i = 0; i < 3; i++) breaker.recordTradeClose(-10);
      expect(breaker.state).toBe("ARMED");
      expect(breaker.consecutiveLosses).toBe(3);
      breaker.recordTradeClose(-10);
      expect(breaker.halt).toMatchObject({ reason: "consecutive_losses" });
    });

    it("a winning or break-even close resets the streak", () => {
      const { breaker } = setup();
      for (const pnl of [-1, -1, -1, 5, -1, -1, -1, 0, -1, -1, -1]) breaker.recordTradeClose(pnl);
      expect(breaker.state).toBe("ARMED");
      expect(breaker.consecutiveLosses).toBe(3);
    });

    it("counts a non-finite PnL as a loss", () => {
      const { breaker } = setup({ MAX_CONSECUTIVE_LOSSES: 1 });
      breaker.recordTradeClose(Number.NaN);
      expect(breaker.halt?.reason).toBe("consecutive_losses");
    });
  });

  describe("c) RPC error rate over the rolling window", () => {
    it("trips when the error rate reaches the threshold", () => {
      const { breaker } = setup();
      for (let i = 0; i < 15; i++) breaker.recordRpcResult(true);
      for (let i = 0; i < 4; i++) breaker.recordRpcResult(false);
      expect(breaker.state).toBe("ARMED"); // 19 samples: below RPC_ERROR_MIN_SAMPLES
      breaker.recordRpcResult(false); // 5/20 = 25%
      expect(breaker.halt).toMatchObject({ reason: "rpc_error_rate" });
    });

    it("does not trip below the threshold", () => {
      const { breaker } = setup();
      for (let i = 0; i < 16; i++) breaker.recordRpcResult(true);
      for (let i = 0; i < 4; i++) breaker.recordRpcResult(false); // 20%
      expect(breaker.state).toBe("ARMED");
    });

    it("forgets samples older than RISK_WINDOW_MIN", () => {
      const { clock, breaker } = setup();
      for (let i = 0; i < 10; i++) breaker.recordRpcResult(false);
      clock.advance(10 * MIN); // all ten errors age out
      for (let i = 0; i < 20; i++) breaker.recordRpcResult(true);
      breaker.recordRpcResult(false);
      expect(breaker.state).toBe("ARMED");
    });

    it("errors spread inside the window still count", () => {
      const { clock, breaker } = setup();
      for (let i = 0; i < 20; i++) {
        breaker.recordRpcResult(i % 2 === 0);
        clock.advance(25_000); // 20 calls over ~8.3 min
      }
      expect(breaker.halt?.reason).toBe("rpc_error_rate");
    });
  });

  describe("c) realized slippage spike over the rolling window", () => {
    it("trips when mean slippage reaches MAX_AVG_SLIPPAGE_PCT", () => {
      const { breaker } = setup();
      breaker.recordFillSlippage(6);
      breaker.recordFillSlippage(6);
      expect(breaker.state).toBe("ARMED"); // below SLIPPAGE_MIN_SAMPLES
      breaker.recordFillSlippage(3); // mean 5%
      expect(breaker.halt).toMatchObject({ reason: "slippage_spike" });
    });

    it("price improvement lowers the mean", () => {
      const { breaker } = setup();
      for (const s of [8, 8, -4]) breaker.recordFillSlippage(s);
      expect(breaker.state).toBe("ARMED");
    });

    it("trips at once on a single fill at MAX_SINGLE_FILL_SLIPPAGE_PCT", () => {
      const { breaker } = setup();
      breaker.recordFillSlippage(15);
      expect(breaker.halt).toMatchObject({ reason: "slippage_spike" });
    });

    it("forgets fills older than RISK_WINDOW_MIN", () => {
      const { clock, breaker } = setup();
      breaker.recordFillSlippage(9);
      breaker.recordFillSlippage(9);
      clock.advance(10 * MIN);
      breaker.recordFillSlippage(1);
      breaker.recordFillSlippage(1);
      breaker.recordFillSlippage(1);
      expect(breaker.state).toBe("ARMED");
    });

    it("fails closed on non-finite slippage", () => {
      const { breaker } = setup();
      breaker.recordFillSlippage(Number.NaN);
      expect(breaker.halt?.reason).toBe("invalid_input");
    });
  });

  describe("halt is sticky and needs a manual reset", () => {
    it("keeps the first cause and ignores later good data", () => {
      const { clock, breaker } = setup({ MAX_CONSECUTIVE_LOSSES: 1 });
      breaker.recordTradeClose(-1);
      breaker.recordFillSlippage(50);
      clock.advance(24 * 60 * MIN);
      breaker.recordEquity(equity(1_000));
      breaker.recordTradeClose(100);
      expect(breaker.halt?.reason).toBe("consecutive_losses");
    });

    it("survives a restart via the store", () => {
      const { clock, store, breaker } = setup();
      breaker.recordFillSlippage(20);
      const restarted = new CircuitBreaker(risk, store, clock.now);
      expect(restarted.state).toBe("HALTED");
      expect(restarted.halt?.reason).toBe("slippage_spike");
    });

    it("re-arms with fresh counters after the reset CLI clears the store", () => {
      const { store, breaker } = setup();
      for (let i = 0; i < 4; i++) breaker.recordTradeClose(-1);
      expect(breaker.state).toBe("HALTED");

      const lines: string[] = [];
      expect(runReset(["--confirm"], store, (l) => lines.push(l))).toBe(0);
      expect(breaker.state).toBe("ARMED");
      expect(breaker.consecutiveLosses).toBe(0);
      breaker.recordTradeClose(-1);
      expect(breaker.state).toBe("ARMED");
    });

    it("halts if persisted state is unreadable, and keeps the file for inspection", () => {
      const store = new FlakyHaltStore();
      store.failLoad = true;
      const breaker = new CircuitBreaker(risk, store, fakeClock().now);
      expect(breaker.halt?.reason).toBe("corrupt_state");
      store.failLoad = false; // still no record written: it was not overwritten
      expect(breaker.state).toBe("ARMED"); // only because the store now reads as cleared
    });

    it("stays halted if the halt could not be saved, and retries the save", () => {
      const store = new FlakyHaltStore();
      store.failSave = true;
      const breaker = new CircuitBreaker(risk, store, fakeClock().now);
      breaker.recordFillSlippage(99);
      expect(breaker.state).toBe("HALTED");
      expect(store.record).toBeNull();
      store.failSave = false;
      expect(breaker.state).toBe("HALTED");
      expect(store.record?.reason).toBe("slippage_spike");
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe("reset CLI", () => {
  const run = (argv: string[], store: MemoryHaltStore | FlakyHaltStore) => {
    const lines: string[] = [];
    const code = runReset(argv, store, (l) => lines.push(l));
    return { code, out: lines.join("\n") };
  };
  const halted = () => {
    const store = new MemoryHaltStore();
    store.record = { reason: "daily_drawdown", detail: "daily drawdown 9.00% > 8%", haltedAt: new Date(T0).toISOString() };
    return store;
  };

  it("reports ARMED when there is nothing to reset", () => {
    expect(run([], new MemoryHaltStore())).toMatchObject({ code: 0, out: expect.stringContaining("ARMED") });
  });

  it("shows the halt and refuses to clear it without --confirm", () => {
    const store = halted();
    const { code, out } = run([], store);
    expect(code).toBe(1);
    expect(out).toContain("daily_drawdown");
    expect(out).toContain("--confirm");
    expect(store.record).not.toBeNull();
  });

  it("clears the halt with --confirm", () => {
    const store = halted();
    expect(run(["--confirm"], store).code).toBe(0);
    expect(store.record).toBeNull();
  });

  it("can clear unreadable state with --confirm", () => {
    const store = new FlakyHaltStore();
    store.failLoad = true;
    expect(run([], store).code).toBe(1);
    expect(run(["--confirm"], store)).toMatchObject({ code: 0, out: expect.stringContaining("Unreadable") });
  });
});

// ---------------------------------------------------------------------------------------------
describe("FileHaltStore", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const fileStore = () => {
    dir = mkdtempSync(join(tmpdir(), "risk-test-"));
    return new FileHaltStore(join(dir, "nested", "halt.json"));
  };

  it("round-trips a halt and clears it", () => {
    const store = fileStore();
    expect(store.load()).toBeNull();
    const rec = { reason: "rpc_error_rate", detail: "x", haltedAt: new Date(T0).toISOString() } as const;
    store.save(rec);
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual(rec);
    expect(store.load()).toEqual(rec);
    store.clear();
    expect(store.load()).toBeNull();
    store.clear(); // idempotent
  });

  it("throws on corrupt or unexpected content, which the breaker treats as halted", () => {
    const store = fileStore();
    store.save({ reason: "daily_drawdown", detail: "", haltedAt: "" });
    for (const bad of ["{not json", JSON.stringify({ reason: "nope", detail: "", haltedAt: "" })]) {
      writeFileSync(store.path, bad);
      expect(() => store.load()).toThrow();
      expect(new CircuitBreaker(risk, store, fakeClock().now).halt?.reason).toBe("corrupt_state");
    }
  });
});
