# MemeCoin Trading Bot

TypeScript (Node.js 22+, ESM, strict) modular trading bot. Paper trading by default.

## Non-negotiable rules

1. **No hardcoded secrets.** Private keys, RPC URLs and API keys come only from `.env` via `src/config`. Startup must fail fast (`ConfigError`) if a required value is missing or invalid. Never log or echo secret values. Never commit `.env`; keep `.env.example` placeholder-only.
2. **Paper by default.** `EXECUTION_MODE` defaults to `PAPER`. `LIVE` requires `LIVE_TRADING_ENABLED=true` (literal string) **and** a non-zero `MAX_POSITION_SOL` or `MAX_POSITION_USD` cap. Do not weaken these checks in `src/config/schema.ts`.
3. **Deterministic gates beat probabilistic signals.** On-chain safety gates (`src/filters`: contract, liquidity, sell-simulation checks) are deterministic and mandatory. LLM/social signals (`src/signals`) may only rank or veto candidates that already passed every gate; they can never bypass, override or skip a gate.
4. **Tested and verified.** Every module has unit tests in `tests/` using deterministic fixtures (`tests/fixtures/`): no network, no real wallets, no wall-clock or randomness without injection. Run `npm test` and `npm run typecheck` before finishing any task; both must pass.

## Layout

- `src/config/` env loading + zod validation (`parseConfig` is pure; `loadConfig` reads `.env`)
- `src/ingestion/` market/on-chain data intake
- `src/filters/` deterministic safety gates
- `src/signals/` probabilistic LLM/social signals (advisory only)
- `src/execution/` order routing (paper and live)
- `src/risk/` position sizing, caps, kill switches
- `src/backtest_sim/` backtesting and simulation
- `tests/` mirrors `src/`; fixtures in `tests/fixtures/`

## Commands

`npm test` · `npm run typecheck` · `npm run build` · `npm start`
