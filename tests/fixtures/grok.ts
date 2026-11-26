/** Deterministic xAI Responses API fixtures. No network; values are fake. */
import type { GrokCandidate, GrokSignal } from "../../src/signals/grokAnalyzer.js";

export const FAKE_XAI_API_KEY = "xai-FIXTURE_FAKE_KEY_NOT_REAL_0000";

/** 2026-11-26T15:30:00Z */
export const FIXED_NOW = Date.UTC(2026, 10, 26, 15, 30, 0);

export const FAKE_MINT = "FixtureMint1111111111111111111111111111111";
export const OTHER_MINT = "FixtureMint2222222222222222222222222222222";

export const triageCandidate: GrokCandidate = {
  contractAddress: FAKE_MINT,
  cashtag: "$fixt",
  passedOnChainGates: false,
  volume24hUsd: 1_000,
};

export const escalationCandidate: GrokCandidate = {
  contractAddress: FAKE_MINT,
  cashtag: "FIXT",
  passedOnChainGates: true,
  volume24hUsd: 250_000,
};

export const validSignal: GrokSignal = {
  narrativeStage: "accelerating",
  organicScore: 72,
  botShillRisk: "low",
  catalystSummary: "CEX listing rumour plus organic meme spread from mid-size accounts.",
  redFlags: ["top holder 9%"],
  actionBias: "strong_interest",
  confidence: 0.64,
};

export const fixtureUsage = {
  input_tokens: 1200,
  output_tokens: 180,
  total_tokens: 1380,
  num_sources_used: 14,
  num_server_side_tools_used: 2,
  cost_in_usd_ticks: 123_450_000,
  server_side_tool_usage_details: {
    web_search_calls: 0,
    x_search_calls: 2,
    x_posts_fetched: 37,
    x_users_fetched: 5,
    code_interpreter_calls: 0,
    file_search_calls: 0,
    mcp_calls: 0,
    document_search_calls: 0,
    image_generation_calls: 0,
  },
};

/** Responses API body shaped like docs.x.ai: tool call items, then the assistant message. */
export function responseBody(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp_fixture",
    object: "response",
    model: "grok-fixture",
    status: "completed",
    output: [
      { type: "custom_tool_call", name: "x_keyword_search", input: "{}", call_id: "c1", status: "completed" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "..." }] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
      },
    ],
    usage: fixtureUsage,
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
