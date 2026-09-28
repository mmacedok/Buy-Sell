import { fetchJson } from "../lib/http.js";

export interface ChatResult {
  content: string;
  costUsd: number | null;
  tokensIn?: number;
  tokensOut?: number;
  raw: unknown;
}

/** Cliente mínimo da OpenRouter (Chat Completions compatível com OpenAI). Chave só no backend. */
export class OpenRouter {
  constructor(private apiKey: string, private base = "https://openrouter.ai/api/v1") {}

  get configured() {
    return !!this.apiKey;
  }

  headers() {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      "X-Title": "Dashboard de investimentos ficticios",
    };
  }

  async chatJson(args: {
    model: string;
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<ChatResult> {
    const body = {
      model: args.model,
      temperature: 0,
      max_tokens: args.maxTokens ?? 1500,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      response_format: { type: "json_schema", json_schema: { name: args.schemaName, strict: true, schema: args.schema } },
      usage: { include: true },
    };
    const raw = await fetchJson<any>(`${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: 120_000,
      retries: 1,
    });
    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`Resposta sem conteúdo da OpenRouter: ${JSON.stringify(raw).slice(0, 300)}`);
    return {
      content,
      costUsd: typeof raw?.usage?.cost === "number" ? raw.usage.cost : null,
      tokensIn: raw?.usage?.prompt_tokens,
      tokensOut: raw?.usage?.completion_tokens,
      raw,
    };
  }

  async listModels(): Promise<{ id: string; pricing?: unknown }[]> {
    const r = await fetchJson<any>(`${this.base}/models`, { headers: this.headers() });
    return r?.data ?? [];
  }
}
