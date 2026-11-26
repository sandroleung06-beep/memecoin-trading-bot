import type { HaltRecord, HaltStore } from "../../src/risk/index.js";

/** Fixed epoch for deterministic clocks: 2026-01-01T00:00:00Z. */
export const T0 = Date.UTC(2026, 0, 1);
export const MIN = 60_000;

/** Manually advanced clock. */
export function fakeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Store whose reads and/or writes can be made to fail. */
export class FlakyHaltStore implements HaltStore {
  record: HaltRecord | null = null;
  failLoad = false;
  failSave = false;
  load(): HaltRecord | null {
    if (this.failLoad) throw new Error("fixture: unreadable");
    return this.record;
  }
  save(record: HaltRecord): void {
    if (this.failSave) throw new Error("fixture: disk full");
    this.record = record;
  }
  clear(): void {
    this.record = null;
  }
}
