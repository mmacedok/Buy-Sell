import type { DB, Row } from "../db/db.js";
import { iso } from "../db/db.js";
import { nyDate, sessionClose, sessionOpen, isMarketOpen } from "../lib/calendar.js";
import { lastPriceAt } from "../sim/prices.js";

/**
 * Indicadores calculados pelo código (o modelo recebe só o resumo).
 * Usa apenas barras disponíveis até `cutoff`:
 *  - barras diárias ajustadas de pregões já encerrados, buscadas até o cutoff;
 *  - último preço bruto de 1 minuto.
 */
export function priceFeatures(db: DB, ticker: string, cutoff: Date) {
  const issues: string[] = [];
  const today = nyDate(cutoff);
  const daily = db
    .all<Row>(
      `SELECT ts, close, volume FROM bars WHERE ticker = ? AND timeframe = '1Day' AND adjusted = 1
       AND ts < ? AND fetched_at <= ? ORDER BY ts DESC LIMIT 21`,
      ticker, iso(sessionOpen(today) < cutoff ? sessionOpen(today) : cutoff), iso(cutoff),
    )
    .filter((b) => sessionClose(nyDate(new Date(b.ts))) <= cutoff)
    .reverse();
  const rawPrev = db.get<Row>(
    `SELECT ts, close FROM bars WHERE ticker = ? AND timeframe = '1Day' AND adjusted = 0 AND ts < ? AND fetched_at <= ?
     ORDER BY ts DESC LIMIT 1`,
    ticker, iso(sessionOpen(today) < cutoff ? sessionOpen(today) : cutoff), iso(cutoff),
  );
  const last = lastPriceAt(db, ticker, cutoff);
  if (daily.length < 21) issues.push(`histórico diário curto (${daily.length} pregões)`);
  if (!last) issues.push("sem preço recente");
  else if (isMarketOpen(cutoff) && cutoff.getTime() - new Date(last.ts).getTime() > 30 * 60_000) {
    issues.push(`último preço com atraso de ${Math.round((cutoff.getTime() - new Date(last.ts).getTime()) / 60_000)} min`);
  }

  const closes = daily.map((b) => Number(b.close));
  const n = closes.length;
  const lastPx = last ? Number(last.price) : null;
  // Movimento desde o último fechamento em preços brutos, composto com o histórico ajustado.
  const sinceClose = lastPx !== null && rawPrev ? lastPx / Number(rawPrev.close) - 1 : null;
  const ret = (k: number) =>
    n > k && sinceClose !== null ? (closes[n - 1] / closes[n - 1 - k]) * (1 + sinceClose) - 1 : null;
  const logRets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = logRets.reduce((a, b) => a + b, 0) / (logRets.length || 1);
  const vol =
    logRets.length >= 10 ? Math.sqrt(logRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (logRets.length - 1)) * Math.sqrt(252) : null;
  const vols = daily.map((b) => Number(b.volume));
  const avgVol = vols.length > 1 ? vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1) : null;

  const pct = (x: number | null) => (x === null ? null : Math.round(x * 10000) / 100);
  return {
    features: {
      last_price: lastPx,
      last_price_time_utc: last?.ts ?? null,
      change_since_prev_close_pct: pct(sinceClose),
      return_1d_pct: pct(sinceClose),
      return_5d_pct: pct(ret(4)),
      return_20d_pct: pct(ret(19)),
      volatility_20d_annualized_pct: pct(vol),
      prev_session_volume_vs_avg: avgVol && vols.length ? Math.round((vols[vols.length - 1] / avgVol) * 100) / 100 : null,
      sessions_of_history: n,
    },
    issues,
  };
}
