// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAIProvider } from "./index.js";

describe("US-V5-002 AIProvider interface", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BYPASS_EXTERNAL_AI;
  });

  it("createAIProvider returns BypassProvider when BYPASS_EXTERNAL_AI=true", async () => {
    process.env.BYPASS_EXTERNAL_AI = "true";
    const provider = createAIProvider({ provider: "claude", apiKey: "sk-key" });
    const result = await provider.complete({ system: "s", userContent: "u" });
    expect(result).toContain("stub");
  });

  it("OpenAIProvider calls chat completions endpoint and returns text", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "response from openai" } }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = createAIProvider({ provider: "openai", apiKey: "sk-test" });
    const result = await provider.complete({ system: "system", userContent: "user" });
    expect(result).toBe("response from openai");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("GeminiProvider calls generateContent endpoint and returns text", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "gemini response" }] } }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = createAIProvider({ provider: "gemini", apiKey: "gkey" });
    const result = await provider.complete({ system: "sys", userContent: "u" });
    expect(result).toBe("gemini response");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com"),
      expect.anything(),
    );
  });

  it("OllamaProvider calls local generate endpoint and returns text", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "ollama says hi" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = createAIProvider({
      provider: "ollama",
      model: "llama3",
      ollamaUrl: "http://localhost:11434",
    });
    const result = await provider.complete({ system: "sys", userContent: "u" });
    expect(result).toBe("ollama says hi");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/generate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("OllamaProvider throws a clear error when Ollama is not running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const provider = createAIProvider({ provider: "ollama", ollamaUrl: "http://localhost:11434" });
    await expect(provider.complete({ system: "s", userContent: "u" })).rejects.toThrow(
      /Ollama not running/,
    );
  });

  it("createAIProvider throws when apiKey is missing for cloud providers", () => {
    expect(() => createAIProvider({ provider: "claude" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createAIProvider({ provider: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(() => createAIProvider({ provider: "gemini" })).toThrow(/GOOGLE_API_KEY/);
  });
});
