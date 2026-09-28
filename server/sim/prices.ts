import type { DB } from "../db/db.js";
import { iso } from "../db/db.js";
import { DateTime } from "luxon";
import { TZ, isCalendarKnown, isTradingDay, nyDate, sessionClose, sessionOpen } from "../lib/calendar.js";

export type Timeframe = "1Min" | "1Day";

export interface Bar {
  ticker: string;
  timeframe: Timeframe;
  ts: string;
  adjusted: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  feed: string;
  fetched_at: string;
}

export interface BarInput {
  ts: string | Date;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
}

const MIN = 60_000;

/** Grava barras (idempotente) e estende a cobertura [from, until] da coleta. */
export function saveBars(
  db: DB,
  opts: { ticker: string; timeframe: Timeframe; adjusted: boolean; feed: string; fetchedAt: Date; from: Date; until: Date },
  bars: BarInput[],
) {
  db.tx(() => {
    for (const b of bars) {
      db.run(
        `INSERT INTO bars(ticker, timeframe, ts, adjusted, open, high, low, close, volume, feed, fetched_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(ticker, timeframe, adjusted, ts) DO NOTHING`,
        opts.ticker, opts.timeframe, iso(new Date(b.ts)), opts.adjusted ? 1 : 0,
        String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume),
        opts.feed, iso(opts.fetchedAt),
      );
    }
    const cur = getCoverage(db, opts.ticker, opts.timeframe, opts.adjusted);
    // A cobertura só avança se o novo intervalo encosta no anterior (sem buracos).
    if (!cur) {
      db.run(
        "INSERT INTO bar_coverage(ticker, timeframe, adjusted, covered_from, covered_until) VALUES(?,?,?,?,?)",
        opts.ticker, opts.timeframe, opts.adjusted ? 1 : 0, iso(opts.from), iso(opts.until),
      );
    } else {
      const from = new Date(Math.min(new Date(cur.covered_from).getTime(), opts.from.getTime()));
      let until = new Date(cur.covered_until);
      if (nextRegularMinute(until) >= opts.from && opts.until > until) until = opts.until;
      db.run(
        "UPDATE bar_coverage SET covered_from = ?, covered_until = ? WHERE ticker = ? AND timeframe = ? AND adjusted = ?",
        iso(from), iso(until), opts.ticker, opts.timeframe, opts.adjusted ? 1 : 0,
      );
    }
  });
}

/** Primeiro instante de pregão regular em ou depois de t (buracos fora do pregão não contam). */
export function nextRegularMinute(t: Date): Date {
  let d = nyDate(t);
  if (isCalendarKnown(d) && isTradingDay(d)) {
    if (t < sessionOpen(d)) return sessionOpen(d);
    if (t < sessionClose(d)) return t;
  }
  for (let i = 0; i < 10; i++) {
    d = DateTime.fromISO(d, { zone: TZ }).plus({ days: 1 }).toISODate()!;
    if (isTradingDay(d)) return sessionOpen(d);
  }
  return t;
}

export function getCoverage(db: DB, ticker: string, timeframe: Timeframe, adjusted: boolean) {
  return db.get<{ covered_from: string; covered_until: string }>(
    "SELECT covered_from, covered_until FROM bar_coverage WHERE ticker = ? AND timeframe = ? AND adjusted = ?",
    ticker, timeframe, adjusted ? 1 : 0,
  );
}

function inRegularSession(ts: Date): boolean {
  const d = nyDate(ts);
  return ts >= sessionOpen(d) && ts < sessionClose(d);
}

/**
 * Preço de referência para execução: a primeira barra de 1 minuto (bruta, pregão regular)
 * que começa em ou depois de `notBefore`. Retorna:
 *  - { bar } quando existe e a coleta já cobre tudo antes dela;
 *  - { wait } quando ainda não há dados suficientes (a ordem continua pendente);
 *  - { none } quando a cobertura passou de `until` sem nenhuma barra elegível.
 * Nunca escolhe entre preços: é sempre a primeira barra elegível.
 */
export function executionBar(
  db: DB,
  ticker: string,
  notBefore: Date,
  until?: Date,
): { bar: Bar } | { wait: string } | { none: string } {
  const cov = getCoverage(db, ticker, "1Min", false);
  if (!cov || new Date(cov.covered_from) > notBefore) return { wait: "sem coleta de barras de 1 minuto cobrindo o horário da ordem" };
  const candidates = db.all<Bar>(
    `SELECT * FROM bars WHERE ticker = ? AND timeframe = '1Min' AND adjusted = 0 AND ts >= ?
     ${until ? "AND ts < ?" : ""} ORDER BY ts ASC LIMIT 500`,
    ...(until ? [ticker, iso(notBefore), iso(until)] : [ticker, iso(notBefore)]),
  );
  const covUntil = new Date(cov.covered_until);
  for (const bar of candidates) {
    const ts = new Date(bar.ts);
    if (!inRegularSession(ts)) continue;
    if (covUntil.getTime() < ts.getTime() + MIN) return { wait: "barra ainda não confirmada pela coleta" };
    return { bar };
  }
  if (until && covUntil >= until) return { none: "nenhuma barra negociada no período permitido" };
  return { wait: "aguardando próximo preço disponível" };
}

/** Último preço conhecido pelo sistema no instante `t` (sem olhar para o futuro). */
export function lastPriceAt(db: DB, ticker: string, t: Date): { price: string; ts: string; timeframe: Timeframe } | undefined {
  const minute = db.get<Bar>(
    `SELECT * FROM bars WHERE ticker = ? AND timeframe = '1Min' AND adjusted = 0
       AND ts <= ? AND fetched_at <= ? ORDER BY ts DESC LIMIT 1`,
    ticker, iso(new Date(t.getTime() - MIN)), iso(t),
  );
  const daily = db.get<Bar>(
    `SELECT * FROM bars WHERE ticker = ? AND timeframe = '1Day' AND adjusted = 0
       AND ts < ? AND fetched_at <= ? ORDER BY ts DESC LIMIT 1`,
    ticker, iso(t), iso(t),
  );
  // Cada barra só "existe" para o sistema depois de terminar: 1 min após o início
  // (barra de minuto) ou no fechamento do pregão (barra diária).
  const minuteAvail = minute ? new Date(minute.ts).getTime() + MIN : -Infinity;
  const dailyAvail = daily ? sessionClose(nyDate(new Date(daily.ts))).getTime() : -Infinity;
  const candidates = [
    minute && minuteAvail <= t.getTime() ? { bar: minute, avail: minuteAvail } : undefined,
    daily && dailyAvail <= t.getTime() ? { bar: daily, avail: dailyAvail } : undefined,
  ].filter((c): c is { bar: Bar; avail: number } => !!c);
  if (!candidates.length) return undefined;
  const best = candidates.sort((a, b) => b.avail - a.avail)[0].bar;
  return { price: best.close, ts: best.ts, timeframe: best.timeframe };
}

/** Fechamento de um pregão: última barra de 1 min do pregão regular, ou a barra diária. */
export function sessionClosePrice(db: DB, ticker: string, date: string): { price: string; source: string } | undefined {
  const minute = db.get<Bar>(
    `SELECT * FROM bars WHERE ticker = ? AND timeframe = '1Min' AND adjusted = 0 AND ts >= ? AND ts < ?
     ORDER BY ts DESC LIMIT 1`,
    ticker, iso(sessionOpen(date)), iso(sessionClose(date)),
  );
  const daily = db.get<Bar>(
    `SELECT * FROM bars WHERE ticker = ? AND timeframe = '1Day' AND adjusted = 0 AND ts >= ? AND ts < ?
     ORDER BY ts DESC LIMIT 1`,
    ticker, iso(new Date(sessionOpen(date).getTime() - 12 * 3600_000)), iso(sessionClose(date)),
  );
  if (daily) return { price: daily.close, source: "barra diária" };
  if (minute) return { price: minute.close, source: "última barra de 1 min" };
  return undefined;
}
