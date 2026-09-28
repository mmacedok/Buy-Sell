import { DateTime } from "luxon";
import { TZ, isTradingDay, nyDate, sessionClose, sessionOpen, tradingDaysBetween } from "../lib/calendar.js";
import type { BarInput, Timeframe } from "../sim/prices.js";
import type { CorporateAction, NewsSource, PriceSource, RawArticle } from "./types.js";

/**
 * Fontes SINTÉTICAS para testar o fluxo sem chaves. Os preços são um passeio aleatório
 * determinístico, independente das notícias: não servem para avaliar a estratégia.
 */

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function rng(seed: string) {
  let a = hash(seed);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

const ANCHOR = "2025-01-02";
const round2 = (x: number) => Math.round(x * 100) / 100;

export class MockPrices implements PriceSource {
  name = "mock";
  feed = "mock";
  publishDelayMinutes = 1;
  private closeCache = new Map<string, Map<string, { open: number; close: number }>>();

  private days(ticker: string, until: string) {
    let m = this.closeCache.get(ticker);
    if (!m) this.closeCache.set(ticker, (m = new Map()));
    if (m.has(until)) return m;
    const days = tradingDaysBetween(ANCHOR, until);
    let prev = 50 + (hash(ticker) % 400);
    for (const d of days) {
      const cached = m.get(d);
      if (cached) { prev = cached.close; continue; }
      const r = rng(`${ticker}:${d}`);
      const open = prev * (1 + 0.004 * gauss(r));
      const close = open * (1 + 0.015 * gauss(r));
      m.set(d, { open, close });
      prev = close;
    }
    return m;
  }

  private minutePrice(day: { open: number; close: number }, ticker: string, date: string, t: Date) {
    const { open, close } = day;
    const o = sessionOpen(date).getTime(), c = sessionClose(date).getTime();
    const f = (t.getTime() - o) / (c - o);
    const noise = 0.0015 * gauss(rng(`${ticker}:${t.toISOString()}`));
    return open + (close - open) * f + open * noise;
  }

  async fetchBars(tickers: string[], timeframe: Timeframe, start: Date, end: Date) {
    const out: Record<string, BarInput[]> = {};
    const from = nyDate(start), to = nyDate(end);
    for (const tk of tickers) {
      const bars: BarInput[] = (out[tk] = []);
      for (const d of tradingDaysBetween(from < ANCHOR ? ANCHOR : from, to)) {
        if (timeframe === "1Day") {
          const ts = DateTime.fromISO(d, { zone: TZ }).toUTC().toJSDate();
          if (ts < start || sessionClose(d) > end) continue; // barra diária só depois do fechamento
          const { open, close } = this.days(tk, d).get(d)!;
          bars.push({ ts, open: round2(open), high: round2(Math.max(open, close) * 1.004), low: round2(Math.min(open, close) * 0.996), close: round2(close), volume: 1_000_000 + (hash(tk + d) % 500_000) });
        } else {
          const day = this.days(tk, d).get(d)!;
          for (let t = sessionOpen(d).getTime(); t < sessionClose(d).getTime(); t += 60_000) {
            if (t < start.getTime() || t + 60_000 > end.getTime()) continue;
            const ts = new Date(t);
            const p = round2(this.minutePrice(day, tk, d, ts));
            const p2 = round2(this.minutePrice(day, tk, d, new Date(t + 59_000)));
            bars.push({ ts, open: p, high: Math.max(p, p2), low: Math.min(p, p2), close: p2, volume: 1000 + (hash(tk + t) % 5000) });
          }
        }
      }
    }
    return out;
  }

  async fetchCorporateActions(): Promise<CorporateAction[]> {
    return [];
  }
}

const TEMPLATES: { title: string; summary: string }[] = [
  { title: "{name} beats quarterly estimates and raises full-year guidance", summary: "{name} reported revenue above analyst expectations and raised its outlook." },
  { title: "{name} announces new multi-year supply agreement with major customer", summary: "The agreement expands {name}'s revenue visibility over the next three years." },
  { title: "Regulators open investigation into {name} business practices", summary: "Authorities said they are reviewing {name}'s contracts; the company said it will cooperate." },
  { title: "{name} cuts outlook citing weaker demand", summary: "{name} lowered its guidance, pointing to softer orders in key markets." },
  { title: "{name} unveils product update at annual event", summary: "{name} showed incremental updates to its product line; analysts called it expected." },
  { title: "Analyst upgrades {name} to buy on margin expansion", summary: "The analyst cited improving margins at {name}." },
  { title: "{name} faces lawsuit over alleged patent infringement", summary: "A competitor filed suit against {name} seeking damages." },
  { title: "Markets wrap: stocks mixed as investors await data", summary: "Broad indexes traded in a narrow range." },
];
const OUTLETS = ["MockWire", "Exemplo News", "Fictício Markets", "Demo Finance"];

export class MockNews implements NewsSource {
  name = "mock";
  constructor(private names: Record<string, string>) {}

  async fetchCompanyNews(ticker: string, from: Date, to: Date): Promise<RawArticle[]> {
    const out: RawArticle[] = [];
    let d = DateTime.fromJSDate(from, { zone: TZ }).startOf("day");
    const end = DateTime.fromJSDate(to, { zone: TZ });
    const name = this.names[ticker] ?? ticker;
    while (d <= end) {
      const date = d.toISODate()!;
      const r = rng(`news:${ticker}:${date}`);
      const count = isTradingDay(date) ? Math.floor(r() * 2.2) : Math.floor(r() * 1.2);
      for (let k = 0; k < count; k++) {
        const tpl = TEMPLATES[Math.floor(r() * TEMPLATES.length)];
        const hour = 6 + Math.floor(r() * 12);
        const base = d.set({ hour, minute: Math.floor(r() * 60) }).toUTC().toJSDate();
        const copies = 1 + Math.floor(r() * 3); // republicações do mesmo fato
        for (let c = 0; c < copies; c++) {
          const publishedAt = new Date(base.getTime() + c * 17 * 60_000);
          if (publishedAt < from || publishedAt > to) continue;
          out.push({
            provider: "mock",
            externalId: `${ticker}-${date}-${k}-${c}`,
            outlet: OUTLETS[(k + c) % OUTLETS.length],
            url: `https://example.invalid/${ticker.toLowerCase()}/${date}/${k}-${c}`,
            title: (c > 0 ? "UPDATE: " : "") + tpl.title.replaceAll("{name}", name),
            summary: tpl.summary.replaceAll("{name}", name),
            publishedAt,
            related: [ticker],
            raw: { synthetic: true },
          });
        }
      }
      d = d.plus({ days: 1 });
    }
    return out;
  }
}
