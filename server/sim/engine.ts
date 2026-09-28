import type { DB, Row } from "../db/db.js";
import { iso } from "../db/db.js";
import { ExperimentConfigSchema, type ExperimentConfig } from "../config.js";
import { D, Decimal, ZERO, bps, cents, floorTo, s } from "../lib/money.js";
import { addSessions, nyDate, nyTime, sessionClose, sessionOpen } from "../lib/calendar.js";
import { executionBar, lastPriceAt, sessionClosePrice } from "./prices.js";

/**
 * Simulador de carteira fictícia.
 *
 * Regras invariáveis:
 *  - Uma ordem só executa com a abertura da primeira barra de 1 minuto que começa
 *    em ou depois de `not_before` (registrado antes do preço existir).
 *  - Sem preço válido, não há execução: a ordem fica pendente ou expira.
 *  - Todo movimento de caixa vira uma linha em cash_ledger; saldo = soma do razão.
 *  - Toda operação que mexe em dinheiro roda numa transação.
 */

export interface Experiment {
  id: number;
  name: string;
  horizon_sessions: number;
  initial_capital: string;
  started_on: string;
  active: number;
  config: ExperimentConfig;
}

export function loadExperiment(db: DB, id: number): Experiment {
  const r = db.get("SELECT * FROM experiments WHERE id = ?", id);
  if (!r) throw new Error(`Experimento ${id} não existe`);
  return { ...(r as any), config: ExperimentConfigSchema.parse(JSON.parse(r.config_json)) };
}

export function listExperiments(db: DB, onlyActive = false): Experiment[] {
  return db
    .all<Row>(`SELECT id FROM experiments ${onlyActive ? "WHERE active = 1" : ""} ORDER BY id`)
    .map((r) => loadExperiment(db, r.id));
}

export function createExperiment(db: DB, name: string, cfg: ExperimentConfig, startedOn: string, now: Date): Experiment {
  const config = ExperimentConfigSchema.parse(cfg);
  return db.tx(() => {
    const { lastId } = db.run(
      `INSERT INTO experiments(name, horizon_sessions, initial_capital, config_json, started_on, created_at)
       VALUES(?,?,?,?,?,?)`,
      name, config.horizonSessions, s(config.initialCapital), JSON.stringify(config), startedOn, iso(now),
    );
    db.run(
      "INSERT INTO cash_ledger(experiment_id, ts, kind, amount, note) VALUES(?,?,?,?,?)",
      lastId, iso(now), "deposit", s(cents(config.initialCapital)), "Capital fictício inicial",
    );
    return loadExperiment(db, lastId);
  });
}

// ---------- Contabilidade ----------

export function cashBalance(db: DB, expId: number, at?: Date): Decimal {
  const rows = db.all<{ amount: string }>(
    `SELECT amount FROM cash_ledger WHERE experiment_id = ? ${at ? "AND ts <= ?" : ""}`,
    ...(at ? [expId, iso(at)] : [expId]),
  );
  return rows.reduce((acc, r) => acc.plus(r.amount), ZERO);
}

export function reservedCash(db: DB, expId: number): Decimal {
  const rows = db.all<{ notional_reserved: string }>(
    "SELECT notional_reserved FROM orders WHERE experiment_id = ? AND side = 'buy' AND status = 'pending'",
    expId,
  );
  return rows.reduce((acc, r) => acc.plus(r.notional_reserved), ZERO);
}

export function availableCash(db: DB, expId: number): Decimal {
  return cashBalance(db, expId).minus(reservedCash(db, expId));
}

export function openPositions(db: DB, expId: number) {
  return db.all<Row>("SELECT * FROM positions WHERE experiment_id = ? AND status = 'open' ORDER BY id", expId);
}

export function pendingOrders(db: DB, expId?: number) {
  return db.all<Row>(
    `SELECT * FROM orders WHERE status = 'pending' ${expId ? "AND experiment_id = ?" : ""} ORDER BY id`,
    ...(expId ? [expId] : []),
  );
}

/** Patrimônio no instante t, marcado pelo último preço disponível até t. */
export function equityAt(db: DB, expId: number, t: Date) {
  const cash = cashBalance(db, expId, t);
  let positionsValue = ZERO;
  let stale = 0;
  const lines: { ticker: string; quantity: string; price: string | null; value: string; costBasis: string; unrealized: string }[] = [];
  const positions = db.all<Row>(
    "SELECT * FROM positions WHERE experiment_id = ? AND opened_at <= ? AND (closed_at IS NULL OR closed_at > ?)",
    expId, iso(t), iso(t),
  );
  for (const p of positions) {
    const lp = lastPriceAt(db, p.ticker, t);
    if (!lp) stale++;
    const price = lp ? D(lp.price) : D(p.cost_basis).div(p.quantity);
    const value = price.times(p.quantity);
    positionsValue = positionsValue.plus(value);
    lines.push({
      ticker: p.ticker,
      quantity: p.quantity,
      price: lp?.price ?? null,
      value: s(cents(value)),
      costBasis: p.cost_basis,
      unrealized: s(cents(value.minus(p.cost_basis))),
    });
  }
  return { cash, positionsValue, equity: cash.plus(positionsValue), stale, lines };
}

// ---------- Ordens ----------

export function createBuyOrder(
  db: DB,
  exp: Experiment,
  args: { decisionId: number; ticker: string; notional: Decimal; notBefore: Date; now: Date },
) {
  return db.tx(() => {
    const dup = db.get("SELECT id FROM orders WHERE decision_id = ? AND side = 'buy'", args.decisionId);
    if (dup) return dup.id as number;
    const avail = availableCash(db, exp.id);
    const notional = cents(Decimal.min(args.notional, avail));
    if (notional.lte(0)) throw new Error("Sem caixa disponível para a compra");
    const { lastId } = db.run(
      `INSERT INTO orders(experiment_id, decision_id, ticker, side, notional_reserved, not_before, expires_at, status, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      exp.id, args.decisionId, args.ticker, "buy", s(notional), iso(args.notBefore),
      iso(sessionClose(nyDate(args.notBefore))), "pending", iso(args.now), iso(args.now),
    );
    return lastId;
  });
}

export function fillPrices(ref: Decimal, side: "buy" | "sell", cfg: ExperimentConfig) {
  const hs = bps(cfg.costs.halfSpreadBps);
  const sl = bps(cfg.costs.slippageBps);
  const sign = side === "buy" ? 1 : -1;
  const fill = ref.times(D(1).plus(hs.plus(sl).times(sign)));
  return { fill, hs, sl };
}

export function commissionFor(qty: Decimal, cfg: ExperimentConfig) {
  return cents(D(cfg.costs.commissionPerOrder).plus(D(cfg.costs.commissionPerShare).times(qty)));
}

const APPROX =
  "Aproximação: abertura da primeira barra de 1 min após a decisão (feed parcial), ajustada por meio spread e slippage estimados.";

function recordExecution(
  db: DB,
  order: Row,
  exp: Experiment,
  bar: { ts: string; open: string; feed: string },
  qty: Decimal,
  now: Date,
) {
  const ref = D(bar.open);
  const { fill, hs, sl } = fillPrices(ref, order.side, exp.config);
  const gross = cents(qty.times(fill));
  const commission = commissionFor(qty, exp.config);
  const { lastId } = db.run(
    `INSERT INTO executions(order_id, experiment_id, ticker, side, quantity, ref_price, ref_bar_ts, fill_price, gross_amount,
       commission, spread_cost, slippage_cost, executed_at, recorded_at, price_source, approximation)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    order.id, exp.id, order.ticker, order.side, s(qty), s(ref), bar.ts, s(fill), s(gross), s(commission),
    s(cents(qty.times(ref).times(hs))), s(cents(qty.times(ref).times(sl))), bar.ts, iso(now),
    `alpaca:${bar.feed}:1Min`, APPROX,
  );
  const sign = order.side === "buy" ? -1 : 1;
  db.run(
    "INSERT INTO cash_ledger(experiment_id, ts, kind, amount, ref_type, ref_id) VALUES(?,?,?,?,?,?)",
    exp.id, bar.ts, order.side, s(gross.times(sign)), "execution", lastId,
  );
  if (commission.gt(0)) {
    db.run(
      "INSERT INTO cash_ledger(experiment_id, ts, kind, amount, ref_type, ref_id) VALUES(?,?,?,?,?,?)",
      exp.id, bar.ts, "commission", s(commission.neg()), "execution", lastId,
    );
  }
  db.run("UPDATE orders SET status = 'filled', updated_at = ? WHERE id = ?", iso(now), order.id);
  return { executionId: lastId, gross, commission, fill };
}

function fillBuy(db: DB, order: Row, exp: Experiment, bar: { ts: string; open: string; feed: string }, now: Date) {
  const cfg = exp.config;
  const { fill } = fillPrices(D(bar.open), "buy", cfg);
  const budget = D(order.notional_reserved).minus(cfg.costs.commissionPerOrder);
  const dp = cfg.allowFractional ? cfg.quantityDecimals : 0;
  let qty = floorTo(budget.div(fill.plus(cfg.costs.commissionPerShare)), dp);
  // Garante que custo total (arredondado) cabe no valor reservado.
  while (qty.gt(0) && cents(qty.times(fill)).plus(commissionFor(qty, cfg)).gt(order.notional_reserved)) {
    qty = qty.minus(D(10).pow(-dp));
  }
  if (qty.lte(0)) {
    db.run(
      "UPDATE orders SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE id = ?",
      "valor reservado insuficiente para uma unidade", iso(now), order.id,
    );
    return;
  }
  const { gross, commission } = recordExecution(db, order, exp, bar, qty, now);
  const entrySession = nyDate(new Date(bar.ts));
  const exitSession = addSessions(entrySession, exp.horizon_sessions);
  const exitAt = nyTime(exitSession, cfg.decisionTimeNY);
  const { lastId: posId } = db.run(
    `INSERT INTO positions(experiment_id, ticker, quantity, cost_basis, entry_order_id, entry_session,
       planned_exit_session, planned_exit_at, opened_at, status)
     VALUES(?,?,?,?,?,?,?,?,?,'open')`,
    exp.id, order.ticker, s(qty), s(gross.plus(commission)), order.id, entrySession, exitSession, iso(exitAt), bar.ts,
  );
  // A saída é decidida no momento da entrada: não é uma decisão nova, e não depende de preço futuro.
  db.run(
    `INSERT INTO orders(experiment_id, position_id, ticker, side, quantity, not_before, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    exp.id, posId, order.ticker, "sell", s(qty), iso(exitAt), "pending", iso(now), iso(now),
  );
}

function fillSell(db: DB, order: Row, exp: Experiment, bar: { ts: string; open: string; feed: string }, now: Date) {
  const pos = db.get("SELECT * FROM positions WHERE id = ?", order.position_id);
  if (!pos || pos.status !== "open") throw new Error(`Posição ${order.position_id} não está aberta`);
  const qty = D(pos.quantity);
  const { gross, commission } = recordExecution(db, order, exp, bar, qty, now);
  const proceeds = gross.minus(commission);
  db.run(
    "UPDATE positions SET status = 'closed', closed_at = ?, proceeds = ?, realized_pnl = ? WHERE id = ?",
    bar.ts, s(proceeds), s(proceeds.minus(pos.cost_basis)), pos.id,
  );
}

/** Processa ordens pendentes. Idempotente: pode rodar a qualquer momento, inclusive após reinício. */
export function processPendingOrders(db: DB, now: Date) {
  const results: { orderId: number; outcome: string }[] = [];
  for (const order of pendingOrders(db)) {
    const exp = loadExperiment(db, order.experiment_id);
    const notBefore = new Date(order.not_before);
    if (notBefore > now) continue;
    const until = order.expires_at ? new Date(order.expires_at) : undefined;
    const r = executionBar(db, order.ticker, notBefore, until);
    if ("bar" in r) {
      // Barra precisa ter terminado até agora (dado já disponível).
      if (new Date(r.bar.ts).getTime() + 60_000 > now.getTime()) continue;
      db.tx(() => (order.side === "buy" ? fillBuy : fillSell)(db, order, exp, r.bar, now));
      results.push({ orderId: order.id, outcome: "filled" });
    } else if ("none" in r) {
      db.run("UPDATE orders SET status = 'expired', status_reason = ?, updated_at = ? WHERE id = ?", r.none, iso(now), order.id);
      results.push({ orderId: order.id, outcome: "expired" });
    } else if (until && now.getTime() > until.getTime() + 24 * 3600_000) {
      // Dados nunca chegaram: libera o caixa sem inventar execução.
      db.run(
        "UPDATE orders SET status = 'expired', status_reason = ?, updated_at = ? WHERE id = ?",
        `sem dados de preço (${r.wait})`, iso(now), order.id,
      );
      results.push({ orderId: order.id, outcome: "expired_no_data" });
    } else if (order.status_reason !== r.wait) {
      db.run("UPDATE orders SET status_reason = ?, updated_at = ? WHERE id = ?", r.wait, iso(now), order.id);
    }
  }
  return results;
}

// ---------- Eventos corporativos ----------

/**
 * Desdobramentos ajustam a quantidade (preços de execução são brutos, não ajustados).
 * Dividendos entram como caixa na data ex. A tabela de aplicações impede contar duas vezes.
 */
export function applyCorporateActions(db: DB, now: Date) {
  const actions = db.all<Row>("SELECT * FROM corporate_actions WHERE ex_date <= ? ORDER BY ex_date, id", nyDate(now));
  for (const a of actions) {
    const exOpen = sessionOpen(a.ex_date);
    if (exOpen > now) continue;
    const positions = db.all<Row>(
      `SELECT * FROM positions WHERE ticker = ? AND opened_at < ? AND (closed_at IS NULL OR closed_at >= ?)
       AND id NOT IN (SELECT position_id FROM corporate_action_applications WHERE action_id = ?)`,
      a.ticker, iso(exOpen), iso(exOpen), a.id,
    );
    for (const p of positions) {
      db.tx(() => {
        if (a.kind === "split") {
          if (p.status !== "open") {
            db.run(
              "INSERT INTO corporate_action_applications(action_id, position_id, applied_at, detail) VALUES(?,?,?,?)",
              a.id, p.id, iso(now), "posição já encerrada antes do processamento; nenhum ajuste",
            );
            return;
          }
          const newQty = D(p.quantity).times(a.ratio);
          db.run("UPDATE positions SET quantity = ? WHERE id = ?", s(newQty), p.id);
          db.run(
            "UPDATE orders SET quantity = ? WHERE position_id = ? AND side = 'sell' AND status = 'pending'",
            s(newQty), p.id,
          );
          db.run(
            "INSERT INTO corporate_action_applications(action_id, position_id, applied_at, detail) VALUES(?,?,?,?)",
            a.id, p.id, iso(now), `quantidade ${p.quantity} → ${s(newQty)}`,
          );
        } else if (a.kind === "cash_dividend") {
          const amount = cents(D(p.quantity).times(a.amount_per_share));
          db.run(
            "INSERT INTO cash_ledger(experiment_id, ts, kind, amount, ref_type, ref_id, note) VALUES(?,?,?,?,?,?,?)",
            p.experiment_id, iso(exOpen), "dividend", s(amount), "corporate_action", a.id,
            `Dividendo ${a.ticker} (creditado na data ex, simplificação)`,
          );
          db.run(
            "INSERT INTO corporate_action_applications(action_id, position_id, applied_at, detail) VALUES(?,?,?,?)",
            a.id, p.id, iso(now), `crédito ${s(amount)}`,
          );
        }
      });
    }
  }
}

// ---------- Fotografias diárias ----------

export function snapshotEquity(db: DB, expId: number, date: string, now: Date) {
  const close = sessionClose(date);
  if (now < close) throw new Error("Fotografia só depois do fechamento");
  const cash = cashBalance(db, expId, close);
  let positionsValue = ZERO;
  let stale = 0;
  const positions = db.all<Row>(
    "SELECT * FROM positions WHERE experiment_id = ? AND opened_at < ? AND (closed_at IS NULL OR closed_at >= ?)",
    expId, iso(close), iso(close),
  );
  for (const p of positions) {
    const px = sessionClosePrice(db, p.ticker, date) ?? lastPriceAt(db, p.ticker, close);
    if (!px) stale++;
    // Quantidade vigente no fechamento (desdobramentos já aplicados ficam na posição).
    positionsValue = positionsValue.plus(px ? D(px.price).times(p.quantity) : D(p.cost_basis));
  }
  const equity = cash.plus(positionsValue);
  db.run(
    `INSERT INTO equity_snapshots(experiment_id, session_date, cash, positions_value, equity, invested_fraction, stale_prices, created_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(experiment_id, session_date) DO UPDATE SET cash = excluded.cash, positions_value = excluded.positions_value,
       equity = excluded.equity, invested_fraction = excluded.invested_fraction, stale_prices = excluded.stale_prices,
       created_at = excluded.created_at`,
    expId, date, s(cents(cash)), s(cents(positionsValue)), s(cents(equity)),
    s(equity.gt(0) ? positionsValue.div(equity).toDecimalPlaces(6) : ZERO), stale, iso(now),
  );
  return { cash, positionsValue, equity, stale };
}
