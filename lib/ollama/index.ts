// Thin client for a local Ollama server (default http://localhost:11434).
// Used both by the signal-scanning pipeline and (via helpers below) as a
// drop-in replacement for the previous Gemini calls in the email jobs.

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';

interface OllamaGenerateOptions {
  /** Model tag, e.g. "llama3.1:8b". Defaults to OLLAMA_MODEL. */
  model?: string;
  /** System prompt (optional). */
  system?: string;
  /** Sampling temperature. Lower = more deterministic. */
  temperature?: number;
  /** Ask Ollama to constrain output to valid JSON. */
  json?: boolean;
  /** Abort the request after this many ms (default 120s). */
  timeoutMs?: number;
}

/**
 * Send a single prompt to Ollama's /api/generate and return the raw text.
 * Streaming is disabled so we get one JSON response back.
 */
export async function ollamaGenerate(
  prompt: string,
  options: OllamaGenerateOptions = {}
): Promise<string> {
  const {
    model = OLLAMA_MODEL,
    system,
    temperature = 0.4,
    json = false,
    timeoutMs = 120_000,
  } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        system,
        stream: false,
        ...(json ? { format: 'json' } : {}),
        options: { temperature },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama request failed ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { response?: string };
    return (data.response ?? '').trim();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convenience wrapper that parses a JSON object out of the model's response.
 * Falls back to null if the model returns something unparseable.
 */
export async function ollamaGenerateJSON<T = unknown>(
  prompt: string,
  options: Omit<OllamaGenerateOptions, 'json'> = {}
): Promise<T | null> {
  const raw = await ollamaGenerate(prompt, { ...options, json: true });
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Some models wrap JSON in prose or code fences despite format:'json'.
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Quick health check so callers can degrade gracefully if Ollama is down. */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
