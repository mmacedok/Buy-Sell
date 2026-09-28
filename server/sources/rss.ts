import type { NewsSource, RawArticle } from "./types.js";

/** Leitor RSS mínimo para páginas de relações com investidores (complemento). */
export class IrRss implements NewsSource {
  name = "rss";
  constructor(private feeds: Record<string, string>) {}

  async fetchCompanyNews(ticker: string, from: Date, to: Date): Promise<RawArticle[]> {
    const url = this.feeds[ticker];
    if (!url) return [];
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`RSS ${ticker}: HTTP ${res.status}`);
    return parseRss(await res.text(), ticker).filter((a) => a.publishedAt >= from && a.publishedAt <= to);
  }
}

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").trim()) : null;
};

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ");

export function parseRss(xml: string, ticker: string): RawArticle[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  return items.flatMap((it) => {
    const title = tag(it, "title");
    const pub = tag(it, "pubDate") ?? tag(it, "dc:date");
    if (!title || !pub || isNaN(Date.parse(pub))) return [];
    const link = tag(it, "link");
    return [{
      provider: "rss",
      externalId: tag(it, "guid") ?? link ?? title,
      outlet: "Relações com investidores",
      url: link,
      title,
      summary: tag(it, "description"),
      publishedAt: new Date(pub),
      related: [ticker],
      raw: null,
    }];
  });
}
