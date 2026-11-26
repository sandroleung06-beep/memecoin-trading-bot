import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const HALT_REASONS = [
  "daily_drawdown",
  "consecutive_losses",
  "rpc_error_rate",
  "slippage_spike",
  "invalid_input",
  "corrupt_state",
] as const;
export type HaltReason = (typeof HALT_REASONS)[number];

export const haltRecordSchema = z
  .object({
    reason: z.enum(HALT_REASONS),
    detail: z.string(),
    /** ISO-8601 time the breaker tripped. */
    haltedAt: z.string(),
  })
  .strict();
export type HaltRecord = Readonly<z.output<typeof haltRecordSchema>>;

/**
 * Durable halt flag. A halt is written here when the breaker trips and only removed by the
 * manual reset CLI, so restarting the bot never clears a halt by itself.
 * `load` throws if the stored state is unreadable; callers must treat that as halted.
 */
export interface HaltStore {
  load(): HaltRecord | null;
  save(record: HaltRecord): void;
  clear(): void;
}

export class FileHaltStore implements HaltStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  load(): HaltRecord | null {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return haltRecordSchema.parse(JSON.parse(text));
  }

  save(record: HaltRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path); // atomic replace: a crash never leaves a half-written file
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

/** In-memory store for tests and simulations. */
export class MemoryHaltStore implements HaltStore {
  record: HaltRecord | null = null;
  load(): HaltRecord | null {
    return this.record;
  }
  save(record: HaltRecord): void {
    this.record = record;
  }
  clear(): void {
    this.record = null;
  }
}
