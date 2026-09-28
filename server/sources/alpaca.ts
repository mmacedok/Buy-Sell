import { z } from "zod";
import { fetchJson } from "../lib/http.js";
import type { BarInput, Timeframe } from "../sim/prices.js";
import type { CorporateAction, PriceSource } from "./types.js";

const BarSchema = z.object({ t: z.string(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() });
const BarsResponse = z.object({
  bars: z.record(z.string(), z.array(BarSchema)).nullable(),
  next_page_token: z.string().nullish(),
});

/**
 * Alpaca Market Data. No plano Basic o feed "iex" é em tempo real, mas cobre só parte do mercado;
 * o preço de execução é, portanto, uma aproximação.
 */
export class AlpacaPrices implements PriceSource {
  name = "alpaca";
  publishDelayMinutes = 2;
  constructor(
    private keyId: string,
    private secret: string,
    readonly feed: string = "iex",
    private base = "https://data.alpaca.markets",
  ) {}

  private headers() {
    return { "APCA-API-KEY-ID": this.keyId, "APCA-API-SECRET-KEY": this.secret, accept: "application/json" };
  }

  async fetchBars(tickers: string[], timeframe: Timeframe, start: Date, end: Date, adjusted: boolean) {
    const out: Record<string, BarInput[]> = Object.fromEntries(tickers.map((t) => [t, []]));
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        symbols: tickers.join(","),
        timeframe,
        start: start.toISOString(),
        end: end.toISOString(),
        limit: "10000",
        adjustment: adjusted ? "all" : "raw",
        feed: this.feed,
        sort: "asc",
      });
      if (pageToken) q.set("page_token", pageToken);
      const data = BarsResponse.parse(await fetchJson(`${this.base}/v2/stocks/bars?${q}`, { headers: this.headers() }));
      for (const [sym, bars] of Object.entries(data.bars ?? {})) {
        (out[sym] ??= []).push(...bars.map((b) => ({ ts: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
      }
      pageToken = data.next_page_token ?? undefined;
    } while (pageToken);
    return out;
  }

  async fetchCorporateActions(tickers: string[], from: string, to: string): Promise<CorporateAction[]> {
    const out: CorporateAction[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        symbols: tickers.join(","),
        types: "forward_split,reverse_split,cash_dividend",
        start: from,
        end: to,
        limit: "1000",
      });
      if (pageToken) q.set("page_token", pageToken);
      const data = await fetchJson<any>(`${this.base}/v1/corporate-actions?${q}`, { headers: this.headers() });
      const ca = data?.corporate_actions ?? {};
      for (const s of [...(ca.forward_splits ?? []), ...(ca.reverse_splits ?? [])]) {
        out.push({ ticker: s.symbol, kind: "split", exDate: s.ex_date, ratio: String(s.new_rate / s.old_rate) });
      }
      for (const d of ca.cash_dividends ?? []) {
        out.push({ ticker: d.symbol, kind: "cash_dividend", exDate: d.ex_date, amountPerShare: String(d.rate) });
      }
      pageToken = data?.next_page_token ?? undefined;
    } while (pageToken);
    return out;
  }
}
