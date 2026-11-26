/** Deterministic env fixtures. Values are fake and must never be real credentials. */
export const FAKE_RPC_URL = "https://rpc.fixture.invalid/solana";
export const FAKE_PRIVATE_KEY = "FIXTURE_FAKE_PRIVATE_KEY_NOT_REAL_000000000000";

export const paperEnv = {
  SOLANA_RPC_URL: FAKE_RPC_URL,
} as const satisfies Record<string, string>;

export const liveEnv = {
  EXECUTION_MODE: "LIVE",
  LIVE_TRADING_ENABLED: "true",
  MAX_POSITION_SOL: "0.5",
  SOLANA_RPC_URL: FAKE_RPC_URL,
  WALLET_PRIVATE_KEY: FAKE_PRIVATE_KEY,
} as const satisfies Record<string, string>;
