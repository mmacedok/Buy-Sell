import { useCallback, useEffect, useState } from "react";

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? res.statusText));
  return body as T;
}

export function post<T = any>(path: string, body?: unknown) {
  return api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
}

/** Busca com recarga periódica (o backend continua rodando mesmo com a aba fechada). */
export function useApi<T = any>(path: string | null, refreshMs = 60_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!path) return;
    api<T>(path).then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e.message ?? e)));
  }, [path]);
  useEffect(() => {
    setData(null);
    load();
    if (!refreshMs) return;
    const h = setInterval(load, refreshMs);
    return () => clearInterval(h);
  }, [load, refreshMs]);
  return { data, error, reload: load };
}
