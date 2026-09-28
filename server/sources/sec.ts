import { fetchJson } from "../lib/http.js";
import type { NewsSource, RawArticle } from "./types.js";

const ITEMS: Record<string, string> = {
  "1.01": "Acordo material relevante",
  "1.02": "Encerramento de acordo material",
  "1.03": "Falência ou recuperação judicial",
  "2.01": "Aquisição ou venda de ativos",
  "2.02": "Resultados operacionais e financeiros",
  "2.05": "Custos de reestruturação",
  "2.06": "Baixa contábil (impairment)",
  "3.01": "Aviso de deslistagem",
  "4.02": "Demonstrações anteriores não confiáveis",
  "5.02": "Mudança de diretores ou executivos",
  "7.01": "Divulgação Reg FD",
  "8.01": "Outros eventos",
};

/**
 * SEC/EDGAR (sem chave, exige User-Agent identificável). Converte formulários 8-K recentes em
 * "notícias" oficiais. O conteúdo enviado à IA é só a descrição dos itens — marcado como title_only.
 */
export class SecFilings implements NewsSource {
  name = "sec";
  constructor(private userAgent: string, private ciks: Record<string, string>) {}

  async fetchCompanyNews(ticker: string, from: Date, to: Date): Promise<RawArticle[]> {
    const cik = this.ciks[ticker];
    if (!cik || !this.userAgent) return [];
    const padded = cik.replace(/\D/g, "").padStart(10, "0");
    const data = await fetchJson<any>(`https://data.sec.gov/submissions/CIK${padded}.json`, {
      headers: { "User-Agent": this.userAgent, accept: "application/json" },
    });
    const r = data?.filings?.recent;
    if (!r) return [];
    const out: RawArticle[] = [];
    for (let i = 0; i < r.form.length; i++) {
      if (r.form[i] !== "8-K") continue;
      const publishedAt = new Date(r.acceptanceDateTime[i]);
      if (publishedAt < from || publishedAt > to) continue;
      const items = String(r.items?.[i] ?? "").split(",").map((x: string) => x.trim()).filter(Boolean);
      const desc = items.map((it: string) => ITEMS[it] ?? `Item ${it}`).join("; ");
      const acc = String(r.accessionNumber[i]);
      out.push({
        provider: "sec",
        externalId: acc,
        outlet: "SEC EDGAR",
        url: `https://www.sec.gov/Archives/edgar/data/${Number(padded)}/${acc.replace(/-/g, "")}/${r.primaryDocument[i]}`,
        title: `${ticker} registra 8-K: ${desc || "comunicado"}`,
        summary: null,
        publishedAt,
        related: [ticker],
        raw: { form: "8-K", items, accession: acc },
      });
    }
    return out;
  }
}
