/** fetch com tempo limite e número limitado de tentativas (backoff exponencial). */
export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  const { timeoutMs = 20_000, retries = 2, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        const err = new HttpError(`HTTP ${res.status} em ${redact(url)}: ${text.slice(0, 300)}`, res.status, text);
        // Só repete erros transitórios.
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
        } else {
          throw err;
        }
      } else {
        return (text ? JSON.parse(text) : null) as T;
      }
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Remove chaves de URLs antes de registrar em log. */
export function redact(url: string) {
  return url.replace(/(token|apikey|api_key|key)=[^&]+/gi, "$1=***");
}
