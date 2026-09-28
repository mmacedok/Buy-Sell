import type { BarInput, Timeframe } from "../sim/prices.js";

export interface RawArticle {
  provider: string;
  externalId: string;
  outlet: string | null;
  url: string | null;
  title: string;
  summary: string | null;
  publishedAt: Date;
  /** Tickers que a fonte associou à notícia. */
  related: string[];
  raw: unknown;
}

export interface NewsSource {
  name: string;
  fetchCompanyNews(ticker: string, from: Date, to: Date): Promise<RawArticle[]>;
}

export interface CorporateAction {
  ticker: string;
  kind: "split" | "cash_dividend";
  exDate: string;
  ratio?: string;
  amountPerShare?: string;
}

export interface PriceSource {
  name: string;
  feed: string;
  /** Atraso (min) entre o fim de uma barra e sua publicação confiável pela fonte. */
  publishDelayMinutes: number;
  fetchBars(tickers: string[], timeframe: Timeframe, start: Date, end: Date, adjusted: boolean): Promise<Record<string, BarInput[]>>;
  fetchCorporateActions(tickers: string[], from: string, to: string): Promise<CorporateAction[]>;
}
