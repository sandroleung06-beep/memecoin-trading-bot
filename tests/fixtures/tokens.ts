import type { TokenCandidate } from "../../src/filters/index.js";
import type { RoundTripRequest, RoundTripResult, SwapSimulator } from "../../src/filters/index.js";

/** Deterministic fake base58 address: label padded with '1' to 44 chars. Labels must be base58. */
export const addr = (label: string): string => label.padEnd(44, "1");

export const MINT = addr("GoodMint");
export const POOL = addr("Poo1");

/** 1,000 SOL quote reserve; a 5 SOL buy is 0.5% impact. */
const LAMPORTS = 1_000_000_000n;

/** A healthy token that every default check passes. */
export function goodCandidate(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    mint: MINT,
    symbol: "GOOD",
    mintAuthority: null,
    freezeAuthority: null,
    pool: {
      address: POOL,
      liquidityUsd: 250_000,
      baseReserve: 400_000_000n * 1_000_000n,
      quoteReserve: 1_000n * LAMPORTS,
      observedSlot: 300_000_000,
    },
    holders: [
      { owner: addr("LpVau1t"), pct: 40, isLiquidityPool: true },
      ...Array.from({ length: 12 }, (_, i) => ({
        owner: addr(`Ho1der${"ABCDEFGHJKMN"[i]}`),
        pct: 2,
        isLiquidityPool: false,
      })),
    ],
    bundledLaunchPct: 3,
    intendedPositionQuote: 5n * LAMPORTS,
    ...overrides,
  };
}

/** Round trip losing `lossBps` of the input, with the given taxes. */
export function okRoundTrip(request: RoundTripRequest, lossBps: bigint, taxBps = { buy: 0, sell: 0 }): RoundTripResult {
  return {
    status: "ok",
    quoteIn: request.quoteIn,
    quoteOut: request.quoteIn - (request.quoteIn * lossBps) / 10_000n,
    buyTaxBps: taxBps.buy,
    sellTaxBps: taxBps.sell,
  };
}

/** Simulator that records calls and answers with `respond`. */
export function fakeSimulator(respond: (request: RoundTripRequest, signal: AbortSignal) => Promise<RoundTripResult>) {
  const calls: RoundTripRequest[] = [];
  const simulator: SwapSimulator = {
    simulateRoundTrip(request, signal) {
      calls.push(request);
      return respond(request, signal);
    },
  };
  return { simulator, calls };
}

/** Normal AMM round trip: ~1.2% loss from fees and slippage. */
export const healthySimulator = () => fakeSimulator(async (req) => okRoundTrip(req, 120n));
