import type { Ctx } from "../context.js";
import type { Row } from "../db/db.js";
import { iso } from "../db/db.js";
import { assignEvents, ingestArticles, loadCompanies } from "../news/ingest.js";
import { getCoverage, saveBars, type Timeframe } from "../sim/prices.js";
import { DateTime } from "luxon";
import { TZ, nyDate, sessionClose, sessionOpen, addSessions, isTradingDay, previousTradingDay } from "../lib/calendar.js";
import { jobState, markJob } from "./jobs.js";

const DAY = 86400_000;

export function allTickers(ctx: Ctx): string[] {
  return ctx.db.all<Row>("SELECT ticker FROM companies WHERE active = 1 ORDER BY ticker").map((r) => r.ticker);
}

/** Busca notícias novas de todas as fontes, grava e agrupa em eventos. */
export async function collectNews(ctx: Ctx) {
  const now = ctx.clock.now();
  const companies = loadCompanies(ctx.db);
  const summary: Record<string, unknown> = {};
  for (const src of ctx.news) {
    for (const c of companies) {
      const job = `news:${src.name}:${c.ticker}`;
      const st = jobState(ctx.db, job);
      // Janela com sobreposição de 1 dia: a deduplicação cuida das repetições.
      const from = st?.last_ok_at ? new Date(new Date(st.last_ok_at).getTime() - DAY) : new Date(now.getTime() - 3 * DAY);
      try {
        const arts = await src.fetchCompanyNews(c.ticker, from, now);
        const r = ingestArticles(ctx.db, arts.filter((a) => a.publishedAt <= now), companies, now);
        markJob(ctx.db, job, now, true, { fetched: arts.length, ...r });
        summary[job] = r;
      } catch (e) {
        markJob(ctx.db, job, now, false, undefined, String((e as Error).message));
        ctx.log(`Falha na coleta ${job}`, (e as Error).message);
      }
    }
  }
  const ev = assignEvents(ctx.db, companies);
  markJob(ctx.db, "collect_news", now, true, { events: ev });
  return { sources: summary, events: ev };
}

function floorMinute(t: Date) {
  return new Date(Math.floor(t.getTime() / 60_000) * 60_000);
}

/** Barras de 1 minuto (brutas) e diárias (brutas e ajustadas). Idempotente, incremental. */
export async function collectPrices(ctx: Ctx, opts: { historyDays?: number } = {}) {
  if (!ctx.prices) return { skipped: "sem fonte de preços configurada" };
  const src = ctx.prices;
  const now = ctx.clock.now();
  const tickers = allTickers(ctx);
  const end = floorMinute(new Date(now.getTime() - src.publishDelayMinutes * 60_000));
  const out: Record<string, number> = {};
  // Barras diárias só entram depois do fechamento; a cobertura para no início do pregão ainda aberto.
  const todayStart = DateTime.fromJSDate(now, { zone: TZ }).startOf("day").toUTC().toJSDate();
  const today = nyDate(now);
  const barsEnd = (tf: Timeframe) =>
    tf === "1Min" || (isTradingDay(today) ? sessionClose(today) <= end : true) ? end : todayStart;
  try {
    const plan: { tf: Timeframe; adjusted: boolean; defaultStart: Date }[] = [
      // Minuto: começa no pregão anterior para permitir execução e marcação.
      { tf: "1Min", adjusted: false, defaultStart: sessionOpen(lastSessionOnOrBefore(nyDate(now), 1)) },
      { tf: "1Day", adjusted: false, defaultStart: new Date(now.getTime() - (opts.historyDays ?? 400) * DAY) },
      { tf: "1Day", adjusted: true, defaultStart: new Date(now.getTime() - (opts.historyDays ?? 400) * DAY) },
    ];
    for (const p of plan) {
      // Agrupa tickers com o mesmo ponto de partida numa só requisição.
      const groups = new Map<string, string[]>();
      for (const t of tickers) {
        const cov = getCoverage(ctx.db, t, p.tf, p.adjusted);
        const start = cov ? new Date(cov.covered_until) : p.defaultStart;
        if (start >= barsEnd(p.tf)) continue;
        const k = iso(start);
        groups.set(k, [...(groups.get(k) ?? []), t]);
      }
      for (const [startIso, group] of groups) {
        const start = new Date(startIso);
        const until = barsEnd(p.tf);
        const data = await src.fetchBars(group, p.tf, start, end, p.adjusted);
        for (const t of group) {
          const bars = (data[t] ?? []).filter((b) =>
            p.tf === "1Min" ? new Date(b.ts) < until : sessionClose(nyDate(new Date(b.ts))) <= end && new Date(b.ts) < until,
          );
          saveBars(ctx.db, { ticker: t, timeframe: p.tf, adjusted: p.adjusted, feed: src.feed, fetchedAt: now, from: start, until }, bars);
          out[`${t}:${p.tf}${p.adjusted ? ":adj" : ""}`] = bars.length;
        }
      }
    }
    markJob(ctx.db, "collect_prices", now, true, { feed: src.feed, until: iso(end) });
  } catch (e) {
    markJob(ctx.db, "collect_prices", now, false, undefined, String((e as Error).message));
    throw e;
  }
  return out;
}

function lastSessionOnOrBefore(date: string, back = 0) {
  let d = isTradingDay(date) ? date : previousTradingDay(date);
  if (back) d = addSessions(d, -back);
  return d;
}

/** Desdobramentos e dividendos. Um desdobramento novo invalida o histórico ajustado guardado. */
export async function collectCorporateActions(ctx: Ctx) {
  if (!ctx.prices) return;
  const now = ctx.clock.now();
  const tickers = allTickers(ctx);
  const from = nyDate(new Date(now.getTime() - 30 * DAY));
  const to = nyDate(new Date(now.getTime() + 30 * DAY));
  try {
    const actions = await ctx.prices.fetchCorporateActions(tickers, from, to);
    for (const a of actions) {
      const r = ctx.db.run(
        `INSERT INTO corporate_actions(ticker, kind, ex_date, ratio, amount_per_share, source, created_at)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
        a.ticker, a.kind, a.exDate, a.ratio ?? null, a.amountPerShare ?? null, ctx.prices.name, iso(now),
      );
      if (r.changes && a.kind === "split") {
        ctx.db.run("DELETE FROM bars WHERE ticker = ? AND timeframe = '1Day' AND adjusted = 1", a.ticker);
        ctx.db.run("DELETE FROM bar_coverage WHERE ticker = ? AND timeframe = '1Day' AND adjusted = 1", a.ticker);
      }
    }
    markJob(ctx.db, "collect_corporate_actions", now, true, { count: actions.length });
  } catch (e) {
    markJob(ctx.db, "collect_corporate_actions", now, false, undefined, String((e as Error).message));
  }
}
