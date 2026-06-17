// Open-source LLM router — Qwen 2.5 72B with multi-provider failover.
//
// "No downtime" goal: every provider here is OpenAI-compatible and serves the
// SAME model (Qwen 2.5 72B Instruct), so failover keeps Blak's voice and
// behavior identical — only the host changes. We try providers in priority
// order; on network error, 5xx, or 429 we fall through to the next. Only when
// ALL providers fail do we surface an error.
//
// Keys live in Edge secrets. A provider with no key is silently skipped, so you
// can start with one and add the rest later without touching code.

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface Provider {
  id: string;
  endpoint: string;
  model: string;
  apiKey: string | undefined;
}

/**
 * Priority-ordered. First with a key + healthy response wins. A provider with
 * no key is silently skipped, so the SAME router serves both "free today" and
 * "premium later" without code changes:
 *   - Today (only GROQ_API_KEY set): Blak runs FREE on Groq + Llama 3.3 70B.
 *   - Add a Together/Fireworks/DeepInfra key later → the router automatically
 *     prefers Qwen 2.5 72B, with Groq kept as the always-free downtime floor.
 * Groq is intentionally LAST so the premium Qwen hosts take precedence once set.
 */
function providers(): Provider[] {
  return [
    {
      // Gemini via the ADC Cloud Run proxy (services/gemini-proxy) — set
      // GEMINI_BASE_URL to the proxy; GEMINI_API_KEY is the proxy's shared
      // secret (org bans Google API keys). No GEMINI_API_KEY → OSS floor below.
      id: "gemini",
      endpoint: Deno.env.get("GEMINI_BASE_URL") ??
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: Deno.env.get("GEMINI_CHAT_MODEL") ?? "gemini-2.5-flash",
      apiKey: Deno.env.get("GEMINI_API_KEY"),
    },
    {
      id: "together",
      endpoint: "https://api.together.xyz/v1/chat/completions",
      model: "Qwen/Qwen2.5-72B-Instruct-Turbo",
      apiKey: Deno.env.get("TOGETHER_API_KEY"),
    },
    {
      id: "fireworks",
      endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
      model: "accounts/fireworks/models/qwen2p5-72b-instruct",
      apiKey: Deno.env.get("FIREWORKS_API_KEY"),
    },
    {
      id: "deepinfra",
      endpoint: "https://api.deepinfra.com/v1/openai/chat/completions",
      model: "Qwen/Qwen2.5-72B-Instruct",
      apiKey: Deno.env.get("DEEPINFRA_API_KEY"),
    },
    {
      // Free tier, no card. Stable production model (Groq's Qwen builds are
      // preview-only and churn). Open-source, strong Hindi/Telugu.
      id: "groq",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      model: "llama-3.3-70b-versatile",
      apiKey: Deno.env.get("GROQ_API_KEY"),
    },
  ];
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Force a JSON object response (used by the learning pipeline). */
  json?: boolean;
  /** Per-request timeout before failing over to the next provider. */
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Run a chat completion against the first healthy provider.
 * Throws only if every configured provider fails.
 */
export async function chat(
  messages: LlmMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const {
    temperature = 0.6,
    maxTokens = 600,
    json = false,
    timeoutMs = 25_000,
  } = opts;

  const configured = providers().filter((p) => !!p.apiKey);
  if (configured.length === 0) {
    throw new Error("No LLM provider keys configured (TOGETHER/FIREWORKS/DEEPINFRA)");
  }

  const errors: string[] = [];

  for (const p of configured) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(p.endpoint, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.apiKey}`,
        },
        body: JSON.stringify({
          model: p.model,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        errors.push(`${p.id}:${res.status}`);
        // Retryable → try next provider; non-retryable (e.g. 400) → also try
        // next, since another host may accept the same payload.
        if (RETRYABLE.has(res.status) || res.status >= 400) continue;
        throw new Error(`${p.id} ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json();
      const text: string = data?.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) {
        errors.push(`${p.id}:empty`);
        continue;
      }
      return { text: text.trim(), provider: p.id, model: p.model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${p.id}:${msg.slice(0, 60)}`);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`All LLM providers failed → ${errors.join(", ")}`);
}

/**
 * Convenience for the learning pipeline: chat in JSON mode and parse. Returns
 * null (never throws) on any failure so a learning hiccup never breaks a reply.
 */
export async function chatJson<T>(
  messages: LlmMessage[],
  opts: Omit<ChatOptions, "json"> = {},
): Promise<T | null> {
  try {
    const { text } = await chat(messages, { ...opts, json: true, temperature: 0 });
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
