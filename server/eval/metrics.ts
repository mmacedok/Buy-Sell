import type { DB, Row } from "../db/db.js";
import { D, Decimal, ZERO, cents } from "../lib/money.js";
import { nyTime, weekStart } from "../lib/calendar.js";
import { executionBar, sessionClosePrice } from "../sim/prices.js";
import { cashBalance, loadExperiment, type Experiment } from "../sim/engine.js";

export interface SeriesPoint { date: string; value: number }

/** Maior queda acumulada (fração) de uma série de patrimônio. */
export function maxDrawdown(values: number[]): number {
  let peak = -Infinity, mdd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd;
}

/** Retornos semanais a partir do patrimônio no fim de cada semana (primeira base = capital inicial). */
export function weeklyReturns(points: SeriesPoint[], initial: number) {
  const byWeek = new Map<string, number>();
  for (const p of points) byWeek.set(weekStart(p.date), p.value);
  const out: { week: string; ret: number; end: number }[] = [];
  let prev = initial;
  for (const [week, end] of [...byWeek.entries()].sort()) {
    out.push({ week, ret: end / prev - 1, end });
    prev = end;
  }
  return out;
}

export function equitySeries(db: DB, expId: number): SeriesPoint[] {
  return db
    .all<Row>("SELECT session_date, equity FROM equity_snapshots WHERE experiment_id = ? ORDER BY session_date", expId)
    .map((r) => ({ date: r.session_date, value: Number(r.equity) }));
}

/**
 * Referências obrigatórias, marcadas nos mesmos fechamentos das fotografias:
 *  1. comprar e manter as ações do universo com pesos iguais (entrada no 1º horário de decisão);
 *  2. comprar e manter o benchmark (SPY);
 *  3. manter em caixa.
 * Sem custos na referência (vantagem para ela — conservador para a estratégia).
 */
export function benchmarkSeries(db: DB, exp: Experiment, dates: string[]) {
  const capital = Number(exp.initial_capital);
  const start = nyTime(exp.started_on, exp.config.decisionTimeNY);
  const entry = (t: string) => {
    const r = executionBar(db, t, start);
    return "bar" in r ? Number(r.bar.open) : null;
  };
  const universe = exp.config.universe.map((t) => ({ t, px: entry(t) })).filter((x) => x.px !== null) as { t: string; px: number }[];
  const spy = entry(exp.config.benchmark);
  const ew: SeriesPoint[] = [], bm: SeriesPoint[] = [], cash: SeriesPoint[] = [];
  for (const date of dates) {
    if (universe.length) {
      let v = 0, ok = true;
      for (const u of universe) {
        const c = sessionClosePrice(db, u.t, date);
        if (!c) { ok = false; break; }
        v += (capital / universe.length) * (Number(c.price) / u.px);
      }
      if (ok) ew.push({ date, value: v });
    }
    if (spy) {
      const c = sessionClosePrice(db, exp.config.benchmark, date);
      if (c) bm.push({ date, value: capital * (Number(c.price) / spy) });
    }
    cash.push({ date, value: capital });
  }
  return { equalWeight: ew, benchmark: bm, cash };
}

function stats(xs: number[]) {
  const n = xs.length;
  return { n, mean: n ? xs.reduce((a, b) => a + b, 0) / n : null };
}

export function experimentMetrics(db: DB, expId: number) {
  const exp = loadExperiment(db, expId);
  const initial = Number(exp.initial_capital);
  const series = equitySeries(db, expId);
  const values = series.map((p) => p.value);
  const last = values.at(-1) ?? initial;
  const weeks = weeklyReturns(series, initial);

  const closed = db.all<Row>("SELECT * FROM positions WHERE experiment_id = ? AND status = 'closed'", expId);
  const pnls = closed.map((p) => Number(p.realized_pnl));
  const wins = pnls.filter((x) => x > 0), losses = pnls.filter((x) => x <= 0);

  // Custos simulados totais e sensibilidade: P&L das operações encerradas refeito com custos 0×, 1×, 2×, 3×.
  const execs = db.all<Row>("SELECT * FROM executions WHERE experiment_id = ?", expId);
  const byOrder = new Map(execs.map((e) => [e.order_id, e]));
  const totalCosts = execs.reduce<Decimal>((a, e) => a.plus(e.commission).plus(e.spread_cost).plus(e.slippage_cost), ZERO);
  const sensitivity = [0, 1, 2, 3].map((mult) => {
    let pnl = ZERO;
    for (const p of closed) {
      const buy = byOrder.get(p.entry_order_id);
      const sellOrder = db.get<Row>("SELECT id FROM orders WHERE position_id = ? AND side = 'sell' AND status = 'filled'", p.id);
      const sell = sellOrder && byOrder.get(sellOrder.id);
      if (!buy || !sell) continue;
      const q = D(sell.quantity);
      const buyCost = D(buy.commission).plus(buy.spread_cost).plus(buy.slippage_cost).times(mult);
      const sellCost = D(sell.commission).plus(sell.spread_cost).plus(sell.slippage_cost).times(mult);
      // Quantidade de compra pode diferir da de venda por desdobramento: usa valores totais.
      const buyValue = D(buy.quantity).times(buy.ref_price);
      pnl = pnl.plus(q.times(sell.ref_price).minus(buyValue).minus(buyCost).minus(sellCost));
    }
    return { multiplier: mult, closedTradesPnl: Number(cents(pnl)) };
  });

  const snaps = db.all<Row>("SELECT invested_fraction FROM equity_snapshots WHERE experiment_id = ?", expId);
  const invested = snaps.map((r) => Number(r.invested_fraction));

  const preds = db.all<Row>(
    `SELECT p.* FROM predictions p WHERE p.horizon = ? AND p.session_date >= ?`,
    exp.horizon_sessions, exp.started_on,
  );
  const evaluated = preds.filter((p) => p.eval_status === "evaluated" && p.eval_correct !== null);
  const acc = (dir: string) => {
    const xs = evaluated.filter((p) => p.direction === dir);
    return { n: xs.length, hitRate: xs.length ? xs.filter((p) => p.eval_correct === 1).length / xs.length : null };
  };
  const decisions = db.all<Row>("SELECT action FROM decisions WHERE experiment_id = ?", expId);
  const rounds = db.all<Row>("SELECT status, COUNT(*) n FROM decision_rounds WHERE experiment_id = ? GROUP BY status", expId);

  const dates = series.map((p) => p.date);
  const bm = benchmarkSeries(db, exp, dates);
  const retOf = (s: SeriesPoint[]) => (s.length ? s.at(-1)!.value / initial - 1 : null);

  return {
    experiment: { id: exp.id, name: exp.name, horizon: exp.horizon_sessions, startedOn: exp.started_on, config: exp.config },
    equity: { initial, last, netReturn: last / initial - 1, cash: Number(cashBalance(db, expId)) },
    weeks: {
      count: weeks.length,
      positiveShare: weeks.length ? weeks.filter((w) => w.ret > 0).length / weeks.length : null,
      worst: weeks.length ? Math.min(...weeks.map((w) => w.ret)) : null,
      list: weeks,
    },
    maxDrawdown: maxDrawdown([initial, ...values]),
    trades: {
      closed: closed.length,
      open: db.get<Row>("SELECT COUNT(*) n FROM positions WHERE experiment_id = ? AND status = 'open'", expId)!.n,
      winRate: pnls.length ? wins.length / pnls.length : null,
      avgWin: stats(wins).mean,
      avgLoss: stats(losses).mean,
      totalSimulatedCosts: Number(cents(totalCosts)),
      costSensitivity: sensitivity,
    },
    exposure: {
      avgInvestedFraction: invested.length ? invested.reduce((a, b) => a + b, 0) / invested.length : null,
      sessionsWithPositions: invested.filter((x) => x > 0).length,
      sessions: invested.length,
    },
    predictions: {
      total: preds.length,
      withDirection: preds.filter((p) => p.direction).length,
      abstentionShare: preds.length ? preds.filter((p) => !p.direction).length / preds.length : null,
      evaluated: evaluated.length,
      up: acc("up"),
      down: acc("down"),
    },
    decisions: {
      buys: decisions.filter((d) => d.action === "buy").length,
      noTrade: decisions.filter((d) => d.action === "no_trade").length,
      rounds: Object.fromEntries(rounds.map((r) => [r.status, r.n])),
    },
    benchmarks: {
      equalWeight: { return: retOf(bm.equalWeight), maxDrawdown: maxDrawdown(bm.equalWeight.map((p) => p.value)) },
      benchmark: { ticker: exp.config.benchmark, return: retOf(bm.benchmark), maxDrawdown: maxDrawdown(bm.benchmark.map((p) => p.value)) },
      cash: { return: 0 },
    },
    series: { strategy: series, ...bm },
    sampleWarning:
      closed.length < 30
        ? `Amostra pequena (${closed.length} operações encerradas): resultados ainda não permitem conclusões.`
        : null,
  };
}

export function aiCosts(db: DB) {
  return db.all<Row>(
    `SELECT substr(ts, 1, 10) AS day, purpose, model, COUNT(*) calls, SUM(CAST(cost_usd AS REAL)) cost
     FROM api_costs GROUP BY day, purpose, model ORDER BY day DESC LIMIT 200`,
  );
}

export type { Decimal };
