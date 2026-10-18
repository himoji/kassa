import { describe, expect, it } from "vitest";

import { isAiConfigError } from "../../src/modules/ai/errors.ts";
import { getPlannerModel, getReaderModel, plannerSpec, readerSpec, readerSupportsVision } from "../../src/modules/ai/models.ts";
import { parseModelSpec } from "../../src/modules/ai/registry.ts";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return isAiConfigError(e) ? e.code : String(e);
  }
};

describe("provider registry: provider:model strings", () => {
  it("parses provider and model, splitting on the first ':' only", () => {
    expect(parseModelSpec("google:gemini-3-pro")).toEqual({ provider: "google", modelId: "gemini-3-pro", id: "google:gemini-3-pro" });
    expect(parseModelSpec("local:llama3.1:8b").modelId).toBe("llama3.1:8b");
    expect(parseModelSpec(" openai:gpt-6-luna ").provider).toBe("openai");
  });

  it("rejects malformed specs and unknown providers with clear codes", () => {
    expect(codeOf(() => parseModelSpec("gpt"))).toBe("AI_MODEL_SPEC_INVALID");
    expect(codeOf(() => parseModelSpec(":x"))).toBe("AI_MODEL_SPEC_INVALID");
    expect(codeOf(() => parseModelSpec("openai:"))).toBe("AI_MODEL_SPEC_INVALID");
    expect(codeOf(() => parseModelSpec("mistral:large"))).toBe("AI_PROVIDER_UNKNOWN");
  });

  it("defaults and bare model ids map to openrouter", () => {
    expect(plannerSpec({}).id).toBe("openrouter:deepseek/deepseek-v4.1-flash");
    expect(readerSpec({}).id).toBe("openrouter:deepseek/deepseek-v4.1-flash");
    expect(plannerSpec({ PLANNER_MODEL: "deepseek/deepseek-v4.1-flash" }).id).toBe("openrouter:deepseek/deepseek-v4.1-flash");
  });

  it("missing provider keys fail with AI_PROVIDER_KEY_MISSING naming the variable", () => {
        expect(codeOf(() => getPlannerModel({ PLANNER_MODEL: "openai:gpt-6-luna" }))).toBe("AI_PROVIDER_KEY_MISSING");
    expect(codeOf(() => getReaderModel({ READER_MODEL: "google:gemini-3-flash" }))).toBe("AI_PROVIDER_KEY_MISSING");
    try {
      getPlannerModel({ PLANNER_MODEL: "google:gemini-3-pro" });
    } catch (e) {
      expect((e as Error).message).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    }
  });

  it("resolves models for every provider when configured (no network at construction)", () => {
    const openai = getPlannerModel({ PLANNER_MODEL: "openai:gpt-6-luna", OPENAI_API_KEY: "k" });
    const google = getPlannerModel({ PLANNER_MODEL: "google:gemini-3-pro", GOOGLE_GENERATIVE_AI_API_KEY: "k" });
    const local = getPlannerModel({ PLANNER_MODEL: "local:qwen3:8b", LOCAL_BASE_URL: "http://localhost:1234/v1" });
    const ollama = getPlannerModel({ PLANNER_MODEL: "ollama:llama3.1:8b" });
    for (const [m, id] of [
      [openai, "gpt-6-luna"],
      [google, "gemini-3-pro"],
      [local, "qwen3:8b"],
      [ollama, "llama3.1:8b"],
    ] as const) {
      expect(typeof m === "object" && m.modelId).toBe(id);
    }
  });

  it("vision capability: local is text-only unless LOCAL_VISION=true; READER_VISION=false disables", () => {
    expect(readerSupportsVision({ READER_MODEL: "local:llava" })).toBe(false);
    expect(readerSupportsVision({ READER_MODEL: "local:llava", LOCAL_VISION: "true" })).toBe(true);
    expect(readerSupportsVision({ READER_MODEL: "google:gemini-3-flash" })).toBe(true);
    expect(readerSupportsVision({ READER_MODEL: "openai:x", READER_VISION: "false" })).toBe(false);
  });

  it("openrouter alias: needs OPENROUTER_API_KEY, talks to openrouter.ai's OpenAI-compatible endpoint", () => {
    expect(parseModelSpec("openrouter:inclusionai/ling-3.1-flash")).toEqual({ provider: "openrouter", modelId: "inclusionai/ling-3.1-flash", id: "openrouter:inclusionai/ling-3.1-flash" });
    expect(codeOf(() => getPlannerModel({ PLANNER_MODEL: "openrouter:inclusionai/ling-3.1-flash" }))).toBe("AI_PROVIDER_KEY_MISSING");
    const m = getPlannerModel({ PLANNER_MODEL: "openrouter:inclusionai/ling-3.1-flash", OPENROUTER_API_KEY: "k" });
    expect(typeof m === "object" && [m.provider, m.modelId]).toEqual(["openrouter.chat", "inclusionai/ling-3.1-flash"]);
    // LOCAL_API_KEY is accepted only when LOCAL_BASE_URL already points at OpenRouter.
    expect(codeOf(() => getPlannerModel({ PLANNER_MODEL: "openrouter:x/y", LOCAL_BASE_URL: "https://openrouter.ai/api/v1", LOCAL_API_KEY: "k" }))).toBeNull();
    expect(codeOf(() => getPlannerModel({ PLANNER_MODEL: "openrouter:x/y", LOCAL_BASE_URL: "http://localhost:11434/v1", LOCAL_API_KEY: "k" }))).toBe("AI_PROVIDER_KEY_MISSING");
  });
});
