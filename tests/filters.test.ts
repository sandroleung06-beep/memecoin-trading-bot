import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, parseFilterConfig, type FilterConfig } from "../src/config/index.js";
import {
  createDefaultFilterPipeline,
  createFilterPipeline,
  top10NonLpPct,
  type FilterCheck,
  type FilterLogEvent,
  type FilterLogger,
  type SwapSimulator,
} from "../src/filters/index.js";
import { addr, fakeSimulator, goodCandidate, healthySimulator, okRoundTrip } from "./fixtures/tokens.js";

const config: FilterConfig = parseFilterConfig({});

function captureLogger() {
  const events: FilterLogEvent[] = [];
  const logger: FilterLogger = { info: (e) => events.push(e), warn: (e) => events.push(e) };
  return { logger, events };
}

function pipelineWith(simulator: SwapSimulator, overrides: Partial<FilterConfig> = {}) {
  const { logger, events } = captureLogger();
  const pipeline = createDefaultFilterPipeline({ config: { ...config, ...overrides }, simulator, logger });
  return { pipeline, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("filter config", () => {
  it("has conservative defaults", () => {
    expect(config).toMatchObject({
      REQUIRE_MINT_AUTHORITY_REVOKED: true,
      REQUIRE_FREEZE_AUTHORITY_REVOKED: true,
      MIN_LIQUIDITY_USD: 20_000,
      MAX_POOL_IMPACT_PCT: 1.5,
      MAX_TOP10_PCT: 30,
      MAX_BUNDLED_PCT: 15,
      MAX_ROUNDTRIP_LOSS_PCT: 10,
      SELL_SIMULATION_TIMEOUT_MS: 5_000,
    });
  });

  it.each([
    ["MAX_TOP10_PCT", "0"],
    ["MAX_TOP10_PCT", "150"],
    ["MIN_LIQUIDITY_USD", "0"],
    ["MAX_ROUNDTRIP_LOSS_PCT", "abc"],
    ["REQUIRE_MINT_AUTHORITY_REVOKED", "no"],
  ])("rejects %s=%j (thresholds cannot be disabled)", (key, value) => {
    expect(() => parseFilterConfig({ [key]: value })).toThrow(ConfigError);
  });
});

describe("passing token", () => {
  it("passes every check and reports all metrics", async () => {
    const { simulator, calls } = healthySimulator();
    const { pipeline, events } = pipelineWith(simulator);

    const verdict = await pipeline.evaluate(goodCandidate());

    expect(verdict).toEqual({
      passed: true,
      reasons: [],
      rejectedBy: null,
      checksRun: ["authority", "liquidity", "holderConcentration", "sellSimulation"],
      metrics: {
        liquidityUsd: 250_000,
        poolImpactPct: 0.5,
        top10HolderPct: 20,
        bundledLaunchPct: 3,
        buyTaxBps: 0,
        sellTaxBps: 0,
        roundTripLossPct: 1.2,
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ quoteIn: 5_000_000_000n, observedSlot: 300_000_000 });
    expect(events).toEqual([expect.objectContaining({ event: "filter.passed", mint: goodCandidate().mint })]);
  });
});

describe("honeypot sell failures", () => {
  it("rejects when the sell reverts", async () => {
    const { simulator } = fakeSimulator(async () => ({ status: "sell_reverted", error: "custom program error: 0x1771" }));
    const { pipeline, events } = pipelineWith(simulator);

    const verdict = await pipeline.evaluate(goodCandidate());

    expect(verdict.passed).toBe(false);
    expect(verdict.rejectedBy).toBe("sellSimulation");
    expect(verdict.reasons).toEqual(["SELL_REVERTED: custom program error: 0x1771"]);
    expect(events[0]).toMatchObject({ event: "filter.rejected", rejectedBy: "sellSimulation" });
  });

  it("rejects when the buy reverts", async () => {
    const { simulator } = fakeSimulator(async () => ({ status: "buy_reverted", error: "slippage" }));
    const verdict = await pipelineWith(simulator).pipeline.evaluate(goodCandidate());
    expect(verdict.reasons).toEqual(["BUY_REVERTED: slippage"]);
  });

  it("rejects a sell tax that eats the round trip", async () => {
    const { simulator } = fakeSimulator(async (req) => okRoundTrip(req, 9_900n, { buy: 0, sell: 9_900 }));
    const verdict = await pipelineWith(simulator).pipeline.evaluate(goodCandidate());

    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toEqual(["ROUNDTRIP_LOSS_TOO_HIGH: lossPct=99 max=10"]);
    expect(verdict.metrics).toMatchObject({ sellTaxBps: 9_900, roundTripLossPct: 99 });
  });

  it("rejects a loss just above the threshold and accepts one exactly at it", async () => {
    const over = fakeSimulator(async (req) => okRoundTrip(req, 1_001n));
    const at = fakeSimulator(async (req) => okRoundTrip(req, 1_000n));
    expect((await pipelineWith(over.simulator).pipeline.evaluate(goodCandidate())).passed).toBe(false);
    expect((await pipelineWith(at.simulator).pipeline.evaluate(goodCandidate())).passed).toBe(true);
  });

  it("fails closed when the simulator throws", async () => {
    const { simulator } = fakeSimulator(async () => {
      throw new Error("RPC 503");
    });
    const verdict = await pipelineWith(simulator).pipeline.evaluate(goodCandidate());
    expect(verdict.reasons).toEqual(["SIMULATION_ERROR: RPC 503"]);
  });

  it("fails closed and aborts when the simulator hangs past the timeout", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const { simulator } = fakeSimulator(
      (_req, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const pending = pipelineWith(simulator, { SELL_SIMULATION_TIMEOUT_MS: 1_000 }).pipeline.evaluate(goodCandidate());

    await vi.advanceTimersByTimeAsync(1_000);
    const verdict = await pending;

    expect(verdict.reasons).toEqual(["SIMULATION_TIMEOUT: exceeded 1000ms"]);
    expect(aborted).toBe(true);
  });

  it("fails closed on a malformed simulator result", async () => {
    const { simulator } = fakeSimulator(async () => ({ status: "ok", quoteIn: 1, quoteOut: "lots" }) as never);
    const verdict = await pipelineWith(simulator).pipeline.evaluate(goodCandidate());
    expect(verdict.reasons).toEqual(["SIMULATION_RESULT_INVALID: simulator returned a malformed result"]);
  });

  it("rejects a simulation run at a different size than requested", async () => {
    const { simulator } = fakeSimulator(async (req) => okRoundTrip({ ...req, quoteIn: 1_000n }, 0n));
    const verdict = await pipelineWith(simulator).pipeline.evaluate(goodCandidate());
    expect(verdict.reasons[0]).toMatch(/^SIMULATION_SIZE_MISMATCH/);
  });
});

describe("active mint or freeze authority", () => {
  it("rejects an active mint authority before running the simulation", async () => {
    const { simulator, calls } = healthySimulator();
    const authority = addr("Dev");
    const verdict = await pipelineWith(simulator).pipeline.evaluate(goodCandidate({ mintAuthority: authority }));

    expect(verdict.passed).toBe(false);
    expect(verdict.rejectedBy).toBe("authority");
    expect(verdict.reasons).toEqual([`MINT_AUTHORITY_ACTIVE: authority=${authority}`]);
    expect(verdict.checksRun).toEqual(["authority"]);
    expect(verdict.metrics.mintAuthorityRevoked).toBe(false);
    expect(verdict.metrics.liquidityUsd).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("reports both authorities when both are active", async () => {
    const verdict = await pipelineWith(healthySimulator().simulator).pipeline.evaluate(
      goodCandidate({ mintAuthority: addr("Dev"), freezeAuthority: addr("Dev") }),
    );
    expect(verdict.reasons.map((r) => r.split(":")[0])).toEqual(["MINT_AUTHORITY_ACTIVE", "FREEZE_AUTHORITY_ACTIVE"]);
  });

  it("allows an active freeze authority only when configured to", async () => {
    const candidate = goodCandidate({ freezeAuthority: addr("Dev") });
    const strict = await pipelineWith(healthySimulator().simulator).pipeline.evaluate(candidate);
    const relaxed = await pipelineWith(healthySimulator().simulator, {
      REQUIRE_FREEZE_AUTHORITY_REVOKED: false,
    }).pipeline.evaluate(candidate);

    expect(strict.passed).toBe(false);
    expect(relaxed.passed).toBe(true);
    expect(relaxed.metrics.freezeAuthorityRevoked).toBe(false);
  });
});

describe("insider wallet clustering", () => {
  it("rejects when the top 10 non-LP holders exceed the cap", async () => {
    const { simulator, calls } = healthySimulator();
    const holders = [
      { owner: addr("LpVau1t"), pct: 30, isLiquidityPool: true },
      { owner: addr("WhaLeA"), pct: 20, isLiquidityPool: false },
      { owner: addr("WhaLeB"), pct: 15, isLiquidityPool: false },
      { owner: addr("Retai1"), pct: 1, isLiquidityPool: false },
    ];
    const verdict = await pipelineWith(simulator).pipeline.evaluate(goodCandidate({ holders }));

    expect(verdict.rejectedBy).toBe("holderConcentration");
    expect(verdict.reasons).toEqual(["TOP10_CONCENTRATION_TOO_HIGH: top10Pct=36 max=30"]);
    expect(calls).toHaveLength(0);
  });

  it("rejects when launch-slot bundled wallets hold too much supply", async () => {
    const verdict = await pipelineWith(healthySimulator().simulator).pipeline.evaluate(
      goodCandidate({ bundledLaunchPct: 42.5 }),
    );
    expect(verdict.reasons).toEqual(["BUNDLED_LAUNCH_TOO_HIGH: bundledPct=42.5 max=15"]);
    expect(verdict.metrics.bundledLaunchPct).toBe(42.5);
  });

  it("excludes LP accounts and only counts the ten largest holders", () => {
    const pcts = [1, 5, 8, 5, 5, 7, 5, 1, 5, 6, 5, 5]; // unsorted on purpose
    const holders = [
      { owner: addr("LpVau1t"), pct: 30, isLiquidityPool: true },
      ...pcts.map((pct, i) => ({ owner: addr(`H${"ABCDEFGHJKMN"[i]}`), pct, isLiquidityPool: false })),
    ];
    expect(top10NonLpPct(holders)).toBe(56); // 8+7+6+5*7, ignoring the LP's 30 and the two 1s
  });
});

describe("thin liquidity", () => {
  it("rejects a pool below the liquidity floor", async () => {
    const { simulator, calls } = healthySimulator();
    const candidate = goodCandidate();
    const verdict = await pipelineWith(simulator).pipeline.evaluate({
      ...candidate,
      pool: { ...candidate.pool, liquidityUsd: 4_000 },
    });

    expect(verdict.rejectedBy).toBe("liquidity");
    expect(verdict.reasons).toEqual(["LIQUIDITY_BELOW_MIN: liquidityUsd=4000 min=20000"]);
    expect(calls).toHaveLength(0);
  });

  it("rejects a position larger than the max pool impact", async () => {
    const verdict = await pipelineWith(healthySimulator().simulator).pipeline.evaluate(
      goodCandidate({ intendedPositionQuote: 20_000_000_000n }), // 20 SOL into 1,000 SOL = 2%
    );
    expect(verdict.reasons).toEqual(["POOL_IMPACT_TOO_HIGH: impactPct=2 max=1.5"]);
    expect(verdict.metrics.poolImpactPct).toBe(2);
  });

  it("rejects an empty pool", async () => {
    const candidate = goodCandidate();
    const verdict = await pipelineWith(healthySimulator().simulator).pipeline.evaluate({
      ...candidate,
      pool: { ...candidate.pool, quoteReserve: 0n },
    });
    expect(verdict.reasons).toContain("POOL_RESERVES_EMPTY: cannot size against an empty pool");
  });
});

describe("fail-closed pipeline behaviour", () => {
  it.each([
    ["null", null],
    ["a missing field", (({ holders: _h, ...rest }) => rest)(goodCandidate())],
    ["an unknown field", { ...goodCandidate(), llmSaysSafe: true }],
    ["NaN liquidity", { ...goodCandidate(), pool: { ...goodCandidate().pool, liquidityUsd: Number.NaN } }],
    ["a bad mint address", goodCandidate({ mint: "not-base58-0OIl" })],
    ["holders summing past 100%", goodCandidate({ holders: [
      { owner: addr("A"), pct: 70, isLiquidityPool: true },
      { owner: addr("B"), pct: 40, isLiquidityPool: false },
    ] })],
  ])("rejects %s without running any check", async (_label, input) => {
    const { simulator, calls } = healthySimulator();
    const verdict = await pipelineWith(simulator).pipeline.evaluate(input);

    expect(verdict.passed).toBe(false);
    expect(verdict.rejectedBy).toBe("inputValidation");
    expect(verdict.reasons[0]).toMatch(/^INVALID_CANDIDATE/);
    expect(verdict.checksRun).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("runs static checks before simulation checks regardless of registration order", async () => {
    const order: string[] = [];
    const check = (name: string, kind: FilterCheck["kind"]): FilterCheck => ({
      name,
      kind,
      run: () => {
        order.push(name);
        return { passed: true, reasons: [], metrics: {} };
      },
    });
    const pipeline = createFilterPipeline(
      [check("sim1", "simulation"), check("static1", "static"), check("sim2", "simulation"), check("static2", "static")],
      captureLogger().logger,
    );
    await pipeline.evaluate(goodCandidate());
    expect(order).toEqual(["static1", "static2", "sim1", "sim2"]);
  });

  it("rejects when a check throws", async () => {
    const boom: FilterCheck = { name: "boom", kind: "static", run: () => { throw new Error("bad data"); } };
    const verdict = await createFilterPipeline([boom], captureLogger().logger).evaluate(goodCandidate());
    expect(verdict).toMatchObject({ passed: false, rejectedBy: "boom", reasons: ["CHECK_THREW: bad data"] });
  });

  it("rejects when a check fails without giving a reason", async () => {
    const silent: FilterCheck = { name: "silent", kind: "static", run: () => ({ passed: false, reasons: [], metrics: {} }) };
    const verdict = await createFilterPipeline([silent], captureLogger().logger).evaluate(goodCandidate());
    expect(verdict.reasons).toEqual(["CHECK_FAILED: silent gave no reason"]);
  });

  it("never passes with zero checks configured", async () => {
    const verdict = await createFilterPipeline([], captureLogger().logger).evaluate(goodCandidate());
    expect(verdict).toMatchObject({ passed: false, reasons: ["NO_CHECKS_CONFIGURED"] });
  });

  it("keeps the verdict when the logger throws", async () => {
    const broken: FilterLogger = { info: () => { throw new Error("disk full"); }, warn: () => { throw new Error("disk full"); } };
    const pipeline = createDefaultFilterPipeline({ config, simulator: healthySimulator().simulator, logger: broken });
    expect((await pipeline.evaluate(goodCandidate())).passed).toBe(true);
    expect((await pipeline.evaluate(goodCandidate({ mintAuthority: addr("Dev") }))).passed).toBe(false);
  });

  it("logs structured rejection reasons with metrics", async () => {
    const { pipeline, events } = pipelineWith(healthySimulator().simulator);
    await pipeline.evaluate(goodCandidate({ bundledLaunchPct: 50 }));
    expect(events).toEqual([
      {
        event: "filter.rejected",
        mint: goodCandidate().mint,
        rejectedBy: "holderConcentration",
        reasons: ["BUNDLED_LAUNCH_TOO_HIGH: bundledPct=50 max=15"],
        checksRun: ["authority", "liquidity", "holderConcentration"],
        metrics: expect.objectContaining({ mintAuthorityRevoked: true, liquidityUsd: 250_000, bundledLaunchPct: 50 }),
      },
    ]);
    expect(() => JSON.stringify(events[0])).not.toThrow();
  });
});
