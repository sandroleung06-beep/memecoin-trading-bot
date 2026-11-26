import { z } from "zod";

/** Solana base58 public key (32-44 chars, no 0/O/I/l). */
const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 public key");
const percent = z.number().finite().min(0).max(100);

export const holderSchema = z
  .object({
    owner: pubkey,
    /** Share of total supply held, 0-100. */
    pct: percent,
    /** True for pool vaults/LP accounts, which are excluded from concentration checks. */
    isLiquidityPool: z.boolean(),
  })
  .strict();

/**
 * Everything the gate needs to judge a token. Produced by ingestion; validated again here
 * because the gate must not trust its input. Unknown keys are rejected.
 */
export const tokenCandidateSchema = z
  .object({
    mint: pubkey,
    symbol: z.string().max(32).optional(),
    /** null means the authority has been revoked. */
    mintAuthority: pubkey.nullable(),
    freezeAuthority: pubkey.nullable(),
    pool: z
      .object({
        address: pubkey,
        /** Total pool liquidity across both sides, in USD. */
        liquidityUsd: z.number().finite().nonnegative(),
        /** Raw reserves (smallest units) at `observedSlot`. */
        baseReserve: z.bigint().nonnegative(),
        quoteReserve: z.bigint().nonnegative(),
        observedSlot: z.number().int().nonnegative(),
      })
      .strict(),
    /** Largest holders, any order. Must include LP accounts flagged as such. */
    holders: z.array(holderSchema).min(1),
    /** Share of supply bought by wallets bundled into the launch slot, 0-100. */
    bundledLaunchPct: percent,
    /** Intended buy size in quote smallest units (e.g. lamports). */
    intendedPositionQuote: z.bigint().positive(),
  })
  .strict()
  .refine((c) => c.holders.reduce((sum, h) => sum + h.pct, 0) <= 100 + 1e-6, {
    path: ["holders"],
    message: "holder percentages sum to more than 100",
  });

export type TokenCandidate = z.output<typeof tokenCandidateSchema>;
export type Holder = z.output<typeof holderSchema>;

/** null means the metric was not evaluated (an earlier check rejected the token). */
export interface FilterMetrics {
  liquidityUsd: number | null;
  poolImpactPct: number | null;
  top10HolderPct: number | null;
  bundledLaunchPct: number | null;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  roundTripLossPct: number | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
}

export interface FilterVerdict {
  passed: boolean;
  /** Machine-readable `CODE: detail` strings. Empty only when passed. */
  reasons: string[];
  metrics: FilterMetrics;
  /** Names of the checks that ran, in order. */
  checksRun: string[];
  /** Name of the check that rejected the token, or null if it passed. */
  rejectedBy: string | null;
}

export interface CheckResult {
  passed: boolean;
  reasons: string[];
  metrics: Partial<FilterMetrics>;
}

export type CheckKind = "static" | "simulation";

export interface FilterCheck {
  readonly name: string;
  /** Static checks only read the candidate; simulation checks are slower and run last. */
  readonly kind: CheckKind;
  run(candidate: TokenCandidate): CheckResult | Promise<CheckResult>;
}

export const emptyMetrics = (): FilterMetrics => ({
  liquidityUsd: null,
  poolImpactPct: null,
  top10HolderPct: null,
  bundledLaunchPct: null,
  buyTaxBps: null,
  sellTaxBps: null,
  roundTripLossPct: null,
  mintAuthorityRevoked: null,
  freezeAuthorityRevoked: null,
});

/** Ratio of two bigints as a percentage, rounded to 4 decimals. Denominator must be > 0. */
export function bigintPct(numerator: bigint, denominator: bigint): number {
  return Number((numerator * 1_000_000n) / denominator) / 10_000;
}
