import { z } from "zod";
import { fetchJson } from "../lib/http.js";
import { DateTime } from "luxon";
import type { NewsSource, RawArticle } from "./types.js";

const ItemSchema = z.object({
  id: z.union([z.number(), z.string()]),
  datetime: z.number(),
  headline: z.string(),
  summary: z.string().nullish(),
  source: z.string().nullish(),
  url: z.string().nullish(),
  related: z.string().nullish(),
  category: z.string().nullish(),
});

/** Finnhub Company News: título, resumo, origem, horário e link (não o texto completo). */
export class FinnhubNews implements NewsSource {
  name = "finnhub";
  constructor(private apiKey: string, private base = "https://finnhub.io/api/v1") {}

  async fetchCompanyNews(ticker: string, from: Date, to: Date): Promise<RawArticle[]> {
    const f = DateTime.fromJSDate(from, { zone: "UTC" }).toISODate();
    const t = DateTime.fromJSDate(to, { zone: "UTC" }).toISODate();
    const url = `${this.base}/company-news?symbol=${encodeURIComponent(ticker)}&from=${f}&to=${t}&token=${this.apiKey}`;
    const data = await fetchJson<unknown[]>(url);
    const out: RawArticle[] = [];
    for (const raw of data ?? []) {
      const p = ItemSchema.safeParse(raw);
      if (!p.success || !p.data.headline.trim()) continue;
      const publishedAt = new Date(p.data.datetime * 1000);
      if (publishedAt > to) continue;
      out.push({
        provider: "finnhub",
        externalId: String(p.data.id),
        outlet: p.data.source ?? null,
        url: p.data.url ?? null,
        title: p.data.headline.trim(),
        summary: p.data.summary?.trim() || null,
        publishedAt,
        related: (p.data.related ?? ticker).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean),
        raw,
      });
    }
    return out;
  }
}
