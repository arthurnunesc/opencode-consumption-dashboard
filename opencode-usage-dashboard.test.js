import { describe, it, expect } from "bun:test";
import {
  normalizeModelId,
  calculateCostFromPricing,
  calculateMessageCost,
  COMMANDCODE_PRICING,
  MODELS_JSON_PRICING,
} from "./opencode-usage-dashboard.js";

describe("normalizeModelId", () => {
  it("strips prefix for commandcode provider", () => {
    expect(normalizeModelId("commandcode", "deepseek/deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeModelId("commandcode", "Qwen/Qwen3.7-Max")).toBe("qwen-3.7-max");
    expect(normalizeModelId("commandcode", "moonshotai/Kimi-K2.6")).toBe("kimi-k2.6");
    expect(normalizeModelId("commandcode", "MiniMaxAI/MiniMax-M3")).toBe("minimax-m3");
    expect(normalizeModelId("commandcode", "xiaomi/mimo-v2.5-pro")).toBe("mimo-v2.5-pro");
    expect(normalizeModelId("commandcode", "deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("passes through for non-commandcode providers", () => {
    expect(normalizeModelId("opencode-go", "deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeModelId("openai", "gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeModelId("google", "gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeModelId("minimax", "MiniMax-M2.7")).toBe("minimax-m2.7");
    expect(normalizeModelId("opencode", "kimi-k2.6")).toBe("kimi-k2.6");
  });
});

describe("calculateCostFromPricing", () => {
  const pricing = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 };
  const tokens100 = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

  it("calculates input-only cost", () => {
    expect(calculateCostFromPricing(pricing, tokens100)).toBe(1);
  });

  it("calculates output-only cost", () => {
    const t = { input: 0, output: 1_000_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    expect(calculateCostFromPricing(pricing, t)).toBe(2);
  });

  it("includes reasoning as output cost", () => {
    const t = { input: 0, output: 0, reasoning: 500_000, cacheRead: 0, cacheWrite: 0 };
    expect(calculateCostFromPricing(pricing, t)).toBe(1);
  });

  it("includes cache read", () => {
    const t = { input: 0, output: 0, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0 };
    expect(calculateCostFromPricing(pricing, t)).toBe(0.1);
  });

  it("includes cache write", () => {
    const t = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 1_000_000 };
    expect(calculateCostFromPricing(pricing, t)).toBe(0.5);
  });

  it("handles missing cache fields", () => {
    const p = { input: 1, output: 2 };
    const t = { input: 500_000, output: 500_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    expect(calculateCostFromPricing(p, t)).toBe(1.5);
  });
});

describe("calculateMessageCost", () => {
  const defaultTokens = { input: 1_000_000, output: 1_000_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

  it("uses recordedCost when > 0", () => {
    const result = calculateMessageCost("openai", "gpt-5.5", defaultTokens, 0.05);
    expect(result.cost).toBe(0.05);
    expect(result.source).toBe("Recorded by OpenCode");
  });

  it("uses recordedCost over any pricing map", () => {
    const result = calculateMessageCost("commandcode", "deepseek-v4-pro", defaultTokens, 0.01);
    expect(result.cost).toBe(0.01);
    expect(result.source).toBe("Recorded by OpenCode");
  });

  it("uses recordedCost for minimax", () => {
    const result = calculateMessageCost("minimax", "MiniMax-M2.7", defaultTokens, 0.0049);
    expect(result.cost).toBe(0.0049);
    expect(result.source).toBe("Recorded by OpenCode");
  });

  it("uses recordedCost for anthropic", () => {
    const result = calculateMessageCost("anthropic", "claude-sonnet-4.6", defaultTokens, 0.123);
    expect(result.cost).toBe(0.123);
    expect(result.source).toBe("Recorded by OpenCode");
  });

  describe("CommandCode pricing (recordedCost = 0)", () => {
    it("deepseek-v4-pro", () => {
      const result = calculateMessageCost("commandcode", "deepseek/deepseek-v4-pro", defaultTokens, 0);
      expect(result.cost).toBeCloseTo(1.305, 4); // 0.435 + 0.87
      expect(result.source).toBe("CommandCode pricing");
    });

    it("qwen3.7-max (no deal price)", () => {
      const result = calculateMessageCost("commandcode", "Qwen/Qwen3.7-Max", defaultTokens, 0);
      expect(result.cost).toBeCloseTo(10, 4); // 2.50 + 7.50
      expect(result.source).toBe("CommandCode pricing");
    });

    it("mimo-v2.5-pro with cache read", () => {
      const t = { input: 1_000_000, output: 1_000_000, reasoning: 0, cacheRead: 500_000, cacheWrite: 0 };
      const result = calculateMessageCost("commandcode", "xiaomi/mimo-v2.5-pro", t, 0);
      expect(result.cost).toBeCloseTo(1.3068, 4); // 0.435 + 0.87 + 500K*0.0036/1M
      expect(result.source).toBe("CommandCode pricing");
    });

    it("gpt-5.5-fast (2.5x GPT-5.5)", () => {
      const result = calculateMessageCost("openai", "gpt-5.5-fast", defaultTokens, 0);
      expect(result.cost).toBeCloseTo(87.5, 4); // 12.50 + 75
      expect(result.source).toBe("CommandCode pricing");
    });
  });

  describe("models.json pricing (recordedCost = 0, not in COMMANDCODE_PRICING)", () => {
    it("openai gpt-5.4-nano", () => {
      const result = calculateMessageCost("openai", "gpt-5.4-nano", defaultTokens, 0);
      expect(result.source).toBe("Provider pricing (models.json)");
      expect(result.cost).toBeGreaterThan(0);
    });

    it("google gemini-3.1-pro-preview", () => {
      const result = calculateMessageCost("google", "gemini-3.1-pro-preview", defaultTokens, 0);
      expect(result.source).toBe("Provider pricing (models.json)");
      expect(result.cost).toBeGreaterThan(0);
    });

    it("opencode gpt-5.1", () => {
      const result = calculateMessageCost("opencode", "gpt-5.1", defaultTokens, 0);
      expect(result.source).toBe("Provider pricing (models.json)");
      expect(result.cost).toBeGreaterThan(0);
    });
  });

  it("returns unavailable when no pricing found", () => {
    const result = calculateMessageCost("unknown", "nonexistent-model-xyz", defaultTokens, 0);
    expect(result.cost).toBe(0);
    expect(result.source).toBe("Unavailable");
  });
});

describe("COMMANDCODE_PRICING map", () => {
  it("has all 32 models", () => {
    expect(Object.keys(COMMANDCODE_PRICING).length).toBe(32);
  });

  it("has permanent deal prices for deepseek-v4-pro", () => {
    expect(COMMANDCODE_PRICING["deepseek-v4-pro"].input).toBe(0.435);
    expect(COMMANDCODE_PRICING["deepseek-v4-pro"].output).toBe(0.87);
    expect(COMMANDCODE_PRICING["deepseek-v4-pro"].cacheRead).toBe(0.003625);
  });

  it("has permanent deal prices for minimax-m3", () => {
    expect(COMMANDCODE_PRICING["minimax-m3"].input).toBe(0.30);
    expect(COMMANDCODE_PRICING["minimax-m3"].output).toBe(1.20);
  });

  it("has no deal prices for qwen-3.7-max (non-permanent)", () => {
    expect(COMMANDCODE_PRICING["qwen-3.7-max"].input).toBe(2.50);
    expect(COMMANDCODE_PRICING["qwen-3.7-max"].output).toBe(7.50);
  });

  it("has gpt-5.5-fast at 2.5x GPT-5.5", () => {
    expect(COMMANDCODE_PRICING["gpt-5.5-fast"].input).toBe(12.50);
    expect(COMMANDCODE_PRICING["gpt-5.5-fast"].output).toBe(75);
    expect(COMMANDCODE_PRICING["gpt-5.5-fast"].cacheRead).toBe(1.25);
  });

  it("has permanent deal prices for nemotron-3-ultra", () => {
    expect(COMMANDCODE_PRICING["nemotron-3-ultra"].input).toBe(0.37);
    expect(COMMANDCODE_PRICING["nemotron-3-ultra"].output).toBe(1.08);
  });
});

describe("MODELS_JSON_PRICING", () => {
  it("loads pricing map", () => {
    expect(MODELS_JSON_PRICING).not.toBeNull();
    expect(MODELS_JSON_PRICING instanceof Map).toBe(true);
    expect(MODELS_JSON_PRICING.size).toBeGreaterThan(0);
  });

  it("contains openai models", () => {
    expect(MODELS_JSON_PRICING.has("gpt-5.5")).toBe(true);
  });

  it("contains google models", () => {
    expect(MODELS_JSON_PRICING.has("gemini-3.1-pro-preview")).toBe(true);
  });
});
