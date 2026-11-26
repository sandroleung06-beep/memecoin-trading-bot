import { z } from "zod";
import type { FilterConfig } from "../../config/filters.js";
import { bigintPct, type CheckResult, type FilterCheck, type TokenCandidate } from "../types.js";

export interface RoundTripRequest {
  mint: string;
  poolAddress: string;
  /** Quote amount to buy with, in smallest units. */
  quoteIn: bigint;
  /** Simulate against this reserve snapshot. */
  baseReserve: bigint;
  quoteReserve: bigint;
  observedSlot: number;
}

const bps = z.number().int().min(0).max(10_000);

export const roundTripResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      quoteIn: z.bigint().positive(),
      /** Quote received after selling every token the buy produced. */
      quoteOut: z.bigint().nonnegative(),
      buyTaxBps: bps,
      sellTaxBps: bps,
    })
    .strict(),
  z.object({ status: z.literal("buy_reverted"), error: z.string() }).strict(),
  z.object({ status: z.literal("sell_reverted"), error: z.string() }).strict(),
]);

export type RoundTripResult = z.output<typeof roundTripResultSchema>;

/**
 * Simulates a buy followed immediately by selling the full output, against current on-chain
 * state (e.g. via simulateTransaction). Implementations must honour `signal` and must not
 * submit anything. Lives behind an interface so tests and backtests can inject fixtures.
 */
export interface SwapSimulator {
  simulateRoundTrip(request: RoundTripRequest, signal: AbortSignal): Promise<RoundTripResult>;
}

class SimulationTimeoutError extends Error {}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SimulationTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Honeypot gate. Fails closed: a revert, a timeout, a thrown error or a malformed result all
 * reject the token, as does a round-trip loss above MAX_ROUNDTRIP_LOSS_PCT.
 */
export function sellSimulationCheck(
  config: Pick<FilterConfig, "MAX_ROUNDTRIP_LOSS_PCT" | "SELL_SIMULATION_TIMEOUT_MS">,
  simulator: SwapSimulator,
): FilterCheck {
  return {
    name: "sellSimulation",
    kind: "simulation",
    async run(candidate: TokenCandidate): Promise<CheckResult> {
      const request: RoundTripRequest = {
        mint: candidate.mint,
        poolAddress: candidate.pool.address,
        quoteIn: candidate.intendedPositionQuote,
        baseReserve: candidate.pool.baseReserve,
        quoteReserve: candidate.pool.quoteReserve,
        observedSlot: candidate.pool.observedSlot,
      };

      let raw: unknown;
      try {
        raw = await withTimeout(config.SELL_SIMULATION_TIMEOUT_MS, (signal) =>
          simulator.simulateRoundTrip(request, signal),
        );
      } catch (err) {
        const reason =
          err instanceof SimulationTimeoutError
            ? `SIMULATION_TIMEOUT: exceeded ${config.SELL_SIMULATION_TIMEOUT_MS}ms`
            : `SIMULATION_ERROR: ${err instanceof Error ? err.message : String(err)}`;
        return { passed: false, reasons: [reason], metrics: {} };
      }

      const parsed = roundTripResultSchema.safeParse(raw);
      if (!parsed.success) {
        return { passed: false, reasons: ["SIMULATION_RESULT_INVALID: simulator returned a malformed result"], metrics: {} };
      }
      const result = parsed.data;

      if (result.status === "buy_reverted") {
        return { passed: false, reasons: [`BUY_REVERTED: ${result.error}`], metrics: {} };
      }
      if (result.status === "sell_reverted") {
        return { passed: false, reasons: [`SELL_REVERTED: ${result.error}`], metrics: {} };
      }
      if (result.quoteIn !== request.quoteIn) {
        return {
          passed: false,
          reasons: [`SIMULATION_SIZE_MISMATCH: simulated=${result.quoteIn} requested=${request.quoteIn}`],
          metrics: {},
        };
      }

      const lossQuote = result.quoteIn - result.quoteOut;
      const roundTripLossPct = lossQuote <= 0n ? 0 : bigintPct(lossQuote, result.quoteIn);
      const metrics = { buyTaxBps: result.buyTaxBps, sellTaxBps: result.sellTaxBps, roundTripLossPct };

      if (roundTripLossPct > config.MAX_ROUNDTRIP_LOSS_PCT) {
        return {
          passed: false,
          reasons: [`ROUNDTRIP_LOSS_TOO_HIGH: lossPct=${roundTripLossPct} max=${config.MAX_ROUNDTRIP_LOSS_PCT}`],
          metrics,
        };
      }
      return { passed: true, reasons: [], metrics };
    },
  };
}
