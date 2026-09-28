import type { RawArticle } from "./types.js";
import type { BarInput } from "../sim/prices.js";

/** CSV simples com aspas duplas. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** Colunas: ticker,published_at,title,summary,url,source */
export function csvToArticles(text: string): RawArticle[] {
  return parseCsv(text).map((r, i) => {
    if (!r.ticker || !r.title || isNaN(Date.parse(r.published_at))) throw new Error(`Linha ${i + 2} inválida no CSV de notícias`);
    return {
      provider: "csv",
      externalId: r.url || `${r.ticker}:${r.published_at}:${r.title}`,
      outlet: r.source || "CSV",
      url: r.url || null,
      title: r.title,
      summary: r.summary || null,
      publishedAt: new Date(r.published_at),
      related: r.ticker.split(/[;|]/).map((x) => x.trim().toUpperCase()),
      raw: r,
    };
  });
}

/** Colunas: ticker,timeframe,ts,open,high,low,close,volume,adjusted */
export function csvToBars(text: string) {
  const groups = new Map<string, { ticker: string; timeframe: "1Min" | "1Day"; adjusted: boolean; bars: BarInput[] }>();
  for (const r of parseCsv(text)) {
    const tf = r.timeframe === "1Day" ? "1Day" : "1Min";
    const adjusted = r.adjusted === "1" || r.adjusted === "true";
    const key = `${r.ticker}|${tf}|${adjusted}`;
    if (!groups.has(key)) groups.set(key, { ticker: r.ticker.toUpperCase(), timeframe: tf, adjusted, bars: [] });
    groups.get(key)!.bars.push({ ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume || "0" });
  }
  return [...groups.values()];
}
