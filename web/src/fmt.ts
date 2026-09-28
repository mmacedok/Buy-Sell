const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" });
export const money = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : usd.format(Number(v)));
export const pct = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(dp).replace(".", ",")}%`;
export const num = (v: number | string | null | undefined, dp = 2) =>
  v === null || v === undefined ? "—" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: dp });
export const dt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/New_York", dateStyle: "short", timeStyle: "short" }) + " NY" : "—";
export const date = (d: string | null | undefined) => (d ? d.split("-").reverse().join("/") : "—");
export const cls = (v: number | null | undefined) => (v === null || v === undefined ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "");
export const DIR: Record<string, string> = { up: "alta", down: "queda" };
export const STATUS: Record<string, string> = {
  ok: "válido", insufficient: "conteúdo insuficiente", low_relevance: "pouco relevante", commentary: "comentário",
  pending: "pendente", filled: "executada", expired: "expirada", cancelled: "cancelada", open: "aberta", closed: "encerrada",
  done: "concluída", missed: "perdida", running: "em andamento", error: "erro", no_events: "sem eventos novos", budget: "orçamento atingido",
  evaluated: "avaliada", unavailable: "sem dados", title_only: "só título", summary: "título + resumo", full: "texto completo",
};
export const st = (s: string | null | undefined) => (s ? STATUS[s] ?? s : "—");
