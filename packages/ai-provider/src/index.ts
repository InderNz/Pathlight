import Anthropic from "@anthropic-ai/sdk";

export interface AIProvider {
  complete(params: { system: string; userContent: string }): Promise<string>;
  isConfigured(): boolean;
  providerName(): string;
  modelName(): string;
  validateConfig(): Promise<{ ok: boolean; error?: string }>;
}

interface AIProviderConfig {
  provider: "claude" | "openai" | "gemini" | "ollama";
  apiKey?: string;
  model?: string;
  ollamaUrl?: string;
}

class ClaudeProvider implements AIProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(
    private readonly apiKey: string,
    model = "claude-sonnet-4-6",
  ) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete({ system, userContent }: { system: string; userContent: string }) {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: userContent }],
    });
    return msg.content.find((b) => b.type === "text")?.text ?? "";
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }
  providerName() {
    return "claude";
  }
  modelName() {
    return this.model;
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class OpenAIProvider implements AIProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-4o",
  ) {}

  async complete({ system, userContent }: { system: string; userContent: string }) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: 4096,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI API error ${response.status}`);
    }
    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message.content ?? "";
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }
  providerName() {
    return "openai";
  }
  modelName() {
    return this.model;
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!r.ok) return { ok: false, error: `OpenAI API error ${r.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class GeminiProvider implements AIProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-1.5-pro",
  ) {}

  async complete({ system, userContent }: { system: string; userContent: string }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      // Pass the key via header, never in the URL query string (avoids leaking
      // through server/proxy logs and browser history).
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: userContent }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
      }),
    });
    if (!response.ok) {
      throw new Error(`Gemini API error ${response.status}`);
    }
    const data = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    return data.candidates[0]?.content.parts[0]?.text ?? "";
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }
  providerName() {
    return "gemini";
  }
  modelName() {
    return this.model;
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1/models", {
        headers: { "x-goog-api-key": this.apiKey },
      });
      if (!r.ok) return { ok: false, error: `Gemini API error ${r.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class OllamaProvider implements AIProvider {
  private readonly url: string;
  private readonly base: string;

  constructor(
    private readonly model = "llama3",
    baseUrl = "http://localhost:11434",
  ) {
    this.base = baseUrl;
    this.url = `${baseUrl}/api/generate`;
  }

  async complete({ system, userContent }: { system: string; userContent: string }) {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: `${system}\n\n${userContent}`,
          stream: false,
          options: { temperature: 0.2, num_predict: 4096 },
        }),
      });
    } catch {
      throw new Error(`Ollama not running at ${this.base}. Start with: ollama serve`);
    }
    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}`);
    }
    const data = (await response.json()) as { response: string };
    return data.response ?? "";
  }

  isConfigured() {
    return true;
  }
  providerName() {
    return "ollama";
  }
  modelName() {
    return this.model;
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    let r: Response;
    try {
      r = await fetch(`${this.base}/api/tags`);
    } catch {
      return { ok: false, error: `Ollama not running at ${this.base}. Start with: ollama serve` };
    }
    try {
      if (!r.ok) return { ok: false, error: `Ollama error ${r.status}` };
      const data = (await r.json()) as { models?: Array<{ name: string }> };
      const found = (data.models ?? []).some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );
      if (!found)
        return {
          ok: false,
          error: `Model ${this.model} not found. Pull with: ollama pull ${this.model}`,
        };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class BypassProvider implements AIProvider {
  async complete(_params: { system: string; userContent: string }) {
    return '{"stub":true}';
  }
  isConfigured() {
    return true;
  }
  providerName() {
    return "bypass";
  }
  modelName() {
    return "stub";
  }
  async validateConfig() {
    return { ok: true };
  }
}

export function createAIProvider(config: AIProviderConfig): AIProvider {
  if (process.env.BYPASS_EXTERNAL_AI === "true") {
    return new BypassProvider();
  }
  switch (config.provider) {
    case "claude":
      if (!config.apiKey) throw new Error("ANTHROPIC_API_KEY is required for Claude provider.");
      return new ClaudeProvider(config.apiKey, config.model);
    case "openai":
      if (!config.apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI provider.");
      return new OpenAIProvider(config.apiKey, config.model);
    case "gemini":
      if (!config.apiKey) throw new Error("GOOGLE_API_KEY is required for Gemini provider.");
      return new GeminiProvider(config.apiKey, config.model);
    case "ollama":
      return new OllamaProvider(config.model ?? "llama3", config.ollamaUrl);
  }
}
