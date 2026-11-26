import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests must be deterministic: no network, no real wallets, no wall-clock dependence.
    restoreMocks: true,
  },
});
