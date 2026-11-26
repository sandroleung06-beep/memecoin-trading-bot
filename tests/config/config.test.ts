import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/config/index.js";
import { FAKE_PRIVATE_KEY, FAKE_RPC_URL, liveEnv, paperEnv } from "../fixtures/env.js";

function expectConfigError(env: Record<string, string | undefined>, pattern: RegExp): ConfigError {
  try {
    parseConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toMatch(pattern);
    return err as ConfigError;
  }
  throw new Error("expected parseConfig to throw");
}

describe("parseConfig: defaults", () => {
  it("defaults to PAPER mode with live trading disabled and zero caps", () => {
    const config = parseConfig(paperEnv);
    expect(config.EXECUTION_MODE).toBe("PAPER");
    expect(config.LIVE_TRADING_ENABLED).toBe(false);
    expect(config.MAX_POSITION_SOL).toBe(0);
    expect(config.MAX_POSITION_USD).toBe(0);
    expect(config.WALLET_PRIVATE_KEY).toBeUndefined();
  });

  it("returns a frozen config", () => {
    expect(Object.isFrozen(parseConfig(paperEnv))).toBe(true);
  });

  it("treats an empty secret as unset", () => {
    expect(parseConfig({ ...paperEnv, WALLET_PRIVATE_KEY: "" }).WALLET_PRIVATE_KEY).toBeUndefined();
  });
});

describe("parseConfig: fail fast on missing or invalid values", () => {
  it("throws when SOLANA_RPC_URL is missing", () => {
    expectConfigError({}, /SOLANA_RPC_URL/);
  });

  it("throws when SOLANA_RPC_URL is not a URL", () => {
    expectConfigError({ SOLANA_RPC_URL: "not-a-url" }, /SOLANA_RPC_URL/);
  });

  it("rejects an unknown EXECUTION_MODE", () => {
    expectConfigError({ ...paperEnv, EXECUTION_MODE: "live" }, /EXECUTION_MODE/);
  });

  it("rejects negative caps", () => {
    expectConfigError({ ...paperEnv, MAX_POSITION_SOL: "-1" }, /MAX_POSITION_SOL/);
  });

  it.each(["1", "yes", "TRUE", " true"])("rejects non-literal boolean %j", (value) => {
    expectConfigError({ ...paperEnv, LIVE_TRADING_ENABLED: value }, /LIVE_TRADING_ENABLED/);
  });
});

describe("parseConfig: LIVE mode guardrails", () => {
  it("accepts a fully specified LIVE config", () => {
    const config = parseConfig(liveEnv);
    expect(config.EXECUTION_MODE).toBe("LIVE");
    expect(config.LIVE_TRADING_ENABLED).toBe(true);
    expect(config.MAX_POSITION_SOL).toBe(0.5);
  });

  it("accepts a USD-only cap", () => {
    const { MAX_POSITION_SOL: _omit, ...rest } = liveEnv;
    expect(parseConfig({ ...rest, MAX_POSITION_USD: "100" }).MAX_POSITION_USD).toBe(100);
  });

  it("requires LIVE_TRADING_ENABLED=true", () => {
    expectConfigError({ ...liveEnv, LIVE_TRADING_ENABLED: "false" }, /LIVE_TRADING_ENABLED/);
  });

  it("requires a non-zero position cap", () => {
    expectConfigError({ ...liveEnv, MAX_POSITION_SOL: "0", MAX_POSITION_USD: "0" }, /non-zero/);
  });

  it("requires a wallet private key", () => {
    expectConfigError({ ...liveEnv, WALLET_PRIVATE_KEY: "" }, /WALLET_PRIVATE_KEY/);
  });

  it("does not enable live trading in PAPER mode even if the flag is set", () => {
    const config = parseConfig({ ...paperEnv, LIVE_TRADING_ENABLED: "true" });
    expect(config.EXECUTION_MODE).toBe("PAPER");
  });
});

describe("parseConfig: secret hygiene", () => {
  it("never echoes secret values in error messages", () => {
    const err = expectConfigError(
      { ...liveEnv, LIVE_TRADING_ENABLED: "false", SOLANA_RPC_URL: "ftp://secret-host.invalid" },
      /LIVE_TRADING_ENABLED/,
    );
    expect(err.message).not.toContain(FAKE_PRIVATE_KEY);
    expect(err.message).not.toContain("secret-host");
    expect(err.message).not.toContain(FAKE_RPC_URL);
  });
});
