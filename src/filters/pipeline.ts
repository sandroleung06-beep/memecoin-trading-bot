import type { FilterConfig } from "../config/filters.js";
import { authorityCheck } from "./checks/authorityCheck.js";
import { holderConcentrationCheck } from "./checks/holderConcentrationCheck.js";
import { liquidityCheck } from "./checks/liquidityCheck.js";
import { sellSimulationCheck, type SwapSimulator } from "./checks/sellSimulationCheck.js";
import {
  emptyMetrics,
  tokenCandidateSchema,
  type CheckResult,
  type FilterCheck,
  type FilterMetrics,
  type FilterVerdict,
} from "./types.js";

export type FilterLogEvent =
  | { event: "filter.passed"; mint: string; checksRun: string[]; metrics: FilterMetrics }
  | {
      event: "filter.rejected";
      mint: string | null;
      rejectedBy: string;
      reasons: string[];
      checksRun: string[];
      metrics: FilterMetrics;
    };

export interface FilterLogger {
  info(event: FilterLogEvent): void;
  warn(event: FilterLogEvent): void;
}

/** One JSON object per line, ready for a log pipeline. */
export const jsonLogger: FilterLogger = {
  info: (e) => console.log(JSON.stringify(e)),
  warn: (e) => console.warn(JSON.stringify(e)),
};

export interface FilterPipeline {
  /** Never throws. Anything unexpected becomes a rejection. */
  evaluate(input: unknown): Promise<FilterVerdict>;
}

export interface PipelineOptions {
  config: FilterConfig;
  simulator: SwapSimulator;
  logger?: FilterLogger;
}

export function defaultChecks(config: FilterConfig, simulator: SwapSimulator): FilterCheck[] {
  return [
    authorityCheck(config),
    liquidityCheck(config),
    holderConcentrationCheck(config),
    sellSimulationCheck(config, simulator),
  ];
}

/** Static checks first (in given order), then simulation checks. */
export function orderChecks(checks: readonly FilterCheck[]): FilterCheck[] {
  return [...checks.filter((c) => c.kind === "static"), ...checks.filter((c) => c.kind === "simulation")];
}

/**
 * Fail-closed gate. Runs checks in order and stops at the first failure. A token passes only
 * if the input is valid, at least one check ran, and every check passed.
 */
export function createFilterPipeline(checks: readonly FilterCheck[], logger: FilterLogger = jsonLogger): FilterPipeline {
  const ordered = orderChecks(checks);

  return {
    async evaluate(input: unknown): Promise<FilterVerdict> {
      const metrics = emptyMetrics();
      const checksRun: string[] = [];

      const reject = (rejectedBy: string, reasons: string[], mint: string | null): FilterVerdict => {
        const safeReasons = reasons.length > 0 ? reasons : [`CHECK_FAILED: ${rejectedBy} gave no reason`];
        safeLog(() =>
          logger.warn({ event: "filter.rejected", mint, rejectedBy, reasons: safeReasons, checksRun, metrics }),
        );
        return { passed: false, reasons: safeReasons, metrics, checksRun, rejectedBy };
      };

      const parsed = tokenCandidateSchema.safeParse(input);
      if (!parsed.success) {
        const reasons = parsed.error.issues.map(
          (i) => `INVALID_CANDIDATE: ${i.path.join(".") || "(root)"} ${i.message}`,
        );
        return reject("inputValidation", reasons, mintOf(input));
      }
      const candidate = parsed.data;

      if (ordered.length === 0) return reject("pipeline", ["NO_CHECKS_CONFIGURED"], candidate.mint);

      for (const check of ordered) {
        checksRun.push(check.name);
        let result: CheckResult;
        try {
          result = await check.run(candidate);
        } catch (err) {
          return reject(check.name, [`CHECK_THREW: ${err instanceof Error ? err.message : String(err)}`], candidate.mint);
        }
        Object.assign(metrics, result.metrics);
        if (result.passed !== true) return reject(check.name, result.reasons, candidate.mint);
      }

      safeLog(() => logger.info({ event: "filter.passed", mint: candidate.mint, checksRun, metrics }));
      return { passed: true, reasons: [], metrics, checksRun, rejectedBy: null };
    },
  };
}

/** Convenience: the standard four-check gate. */
export function createDefaultFilterPipeline(options: PipelineOptions): FilterPipeline {
  return createFilterPipeline(defaultChecks(options.config, options.simulator), options.logger);
}

/** A broken logger must never change a verdict. */
function safeLog(write: () => void): void {
  try {
    write();
  } catch {
    // Swallow: logging is best-effort, the verdict is not.
  }
}

function mintOf(input: unknown): string | null {
  if (typeof input === "object" && input !== null && "mint" in input) {
    const { mint } = input as { mint: unknown };
    return typeof mint === "string" ? mint.slice(0, 64) : null;
  }
  return null;
}
