import { ConfigError, loadConfig, parseFilterConfig, parseRiskConfig } from "./config/index.js";
import { CircuitBreaker, FileHaltStore } from "./risk/index.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  parseFilterConfig(process.env); // fail fast on bad filter thresholds too
  const risk = parseRiskConfig(process.env); // and on bad risk limits
  console.log(`Starting in ${config.EXECUTION_MODE} mode`);

  const breaker = new CircuitBreaker(risk, new FileHaltStore(risk.HALT_STATE_FILE), Date.now);
  const halt = breaker.halt;
  if (halt !== null) {
    console.warn(
      `Circuit breaker HALTED since ${halt.haltedAt} (${halt.reason}). No new entries until \`npm run risk:reset -- --confirm\`.`,
    );
  }
}

main().catch((err: unknown) => {
  // Fail fast: never continue with a partial or invalid configuration.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
