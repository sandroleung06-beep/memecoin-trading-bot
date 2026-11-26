import { pathToFileURL } from "node:url";
import { ConfigError, parseRiskConfig } from "../config/index.js";
import { FileHaltStore, type HaltStore } from "./haltStore.js";

/**
 * Manual circuit-breaker reset: `npm run risk:reset` shows the halt, and
 * `npm run risk:reset -- --confirm` clears it. A running bot re-arms on its next state check.
 * Returns the process exit code. Pure apart from the injected store and output sink.
 */
export function runReset(argv: readonly string[], store: HaltStore, out: (line: string) => void): number {
  const confirm = argv.includes("--confirm");
  let unreadable = false;
  try {
    const halt = store.load();
    if (halt === null) {
      out("Circuit breaker is ARMED. Nothing to reset.");
      return 0;
    }
    out(`Circuit breaker is HALTED since ${halt.haltedAt}: ${halt.reason} (${halt.detail})`);
  } catch {
    unreadable = true;
    out("Circuit breaker state is unreadable, so the bot treats it as HALTED.");
  }
  if (!confirm) {
    out("Review the cause first, then re-run with --confirm to resume trading.");
    return 1;
  }
  store.clear();
  out(unreadable ? "Unreadable halt state removed. Trading may resume." : "Halt cleared. Trading may resume.");
  return 0;
}

async function main(): Promise<void> {
  const dotenv = await import("dotenv");
  dotenv.config({ quiet: true });
  const { HALT_STATE_FILE } = parseRiskConfig(process.env);
  process.exitCode = runReset(process.argv.slice(2), new FileHaltStore(HALT_STATE_FILE), console.log);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exitCode = 1;
  });
}
