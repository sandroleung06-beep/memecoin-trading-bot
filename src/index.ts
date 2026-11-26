import { ConfigError, loadConfig, parseFilterConfig } from "./config/index.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  parseFilterConfig(process.env); // fail fast on bad filter thresholds too
  console.log(`Starting in ${config.EXECUTION_MODE} mode`);
}

main().catch((err: unknown) => {
  // Fail fast: never continue with a partial or invalid configuration.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
