import { describe, expect, it } from "vitest";
import { memDb, minuteBars, newExp } from "./helpers.js";
import {
  applyCorporateActions, availableCash, cashBalance, createBuyOrder, openPositions, processPendingOrders, snapshotEquity,
} from "../server/sim/engine.js";
import { D } from "../server/lib/money.js";
import { nyTime, sessionClose } from "../server/lib/calendar.js";
import type { DB } from "../server/db/db.js";

function decision(db: DB, expId: number, ticker: string, date = "2026-09-28") {
  const round = db.run(
    "INSERT INTO decision_rounds(experiment_id, session_date, scheduled_at, status) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
    expId, date, nyTime(date, "10:00").toISOString(), "done",
  );
  const roundId = round.lastId || db.get("SELECT id FROM decision_rounds WHERE experiment_id=? AND session_date=?", expId, date)!.id;
  return db.run(
    "INSERT INTO decisions(round_id, experiment_id, ticker, action, reason, created_at) VALUES(?,?,?,?,?,?)",
    roundId, expId, ticker, "buy", "teste", new Date().toISOString(),
  ).lastId;
}

describe("simulador", () => {
  it("executa na primeira barra posterior à decisão, nunca antes", () => {
    const db = memDb();
    const exp = newExp(db);
    // Preço 100 antes das 10:03, 110 depois.
    minuteBars(db, "AAA", "2026-09-28", (i) => (i < 33 ? 100 : 110));
    const decidedAt = nyTime("2026-09-28", "10:03");
    const dId = decision(db, exp.id, "AAA");
    createBuyOrder(db, exp, { decisionId: dId, ticker: "AAA", notional: D(2000), notBefore: decidedAt, now: decidedAt });
    processPendingOrders(db, sessionClose("2026-09-28"));
    const ex = db.get("SELECT * FROM executions")!;
    expect(ex.ref_bar_ts).toBe(decidedAt.toISOString());
    expect(ex.ref_price).toBe("110");
    expect(new Date(ex.executed_at) >= decidedAt).toBe(true);
  });

  it("fica pendente enquanto o preço posterior não está disponível", () => {
    const db = memDb();
    const exp = newExp(db);
    // Coleta só até 10:00; decisão às 10:03.
    minuteBars(db, "AAA", "2026-09-28", () => 100, { toHHMM: "10:00" });
    const t = nyTime("2026-09-28", "10:03");
    const dId = decision(db, exp.id, "AAA");
    createBuyOrder(db, exp, { decisionId: dId, ticker: "AAA", notional: D(2000), notBefore: t, now: t });
    processPendingOrders(db, nyTime("2026-09-28", "10:10"));
    expect(db.get("SELECT status FROM orders")!.status).toBe("pending");
    expect(db.all("SELECT * FROM executions")).toHaveLength(0);
    // Caixa reservado não pode ser usado por outra compra.
    expect(availableCash(db, exp.id).toString()).toBe("8000");
  });

  it("não pula barra ainda não coletada (cobertura com buraco)", () => {
    const db = memDb();
    const exp = newExp(db);
    minuteBars(db, "AAA", "2026-09-28", () => 100, { toHHMM: "10:00" });
    // Coleta separada, deixando buraco 10:00–10:05 → cobertura não avança.
    minuteBars(db, "AAA", "2026-09-28", () => 120, { fromHHMM: "10:05", toHHMM: "11:00" });
    const t = nyTime("2026-09-28", "10:01");
    const dId = decision(db, exp.id, "AAA");
    createBuyOrder(db, exp, { decisionId: dId, ticker: "AAA", notional: D(2000), notBefore: t, now: t });
    processPendingOrders(db, nyTime("2026-09-28", "11:30"));
    expect(db.get("SELECT status FROM orders")!.status).toBe("pending");
  });

  it("aplica spread, slippage e comissão e fecha a conta do caixa", () => {
    const db = memDb();
    const exp = newExp(db, {
      costs: { commissionPerOrder: "1", commissionPerShare: "0", halfSpreadBps: "5", slippageBps: "5" },
      allowFractional: false,
    });
    minuteBars(db, "AAA", "2026-09-28", () => 100);
    minuteBars(db, "AAA", "2026-09-29", () => 105);
    const t = nyTime("2026-09-28", "10:00");
    const dId = decision(db, exp.id, "AAA");
    createBuyOrder(db, exp, { decisionId: dId, ticker: "AAA", notional: D(2000), notBefore: t, now: t });
    processPendingOrders(db, sessionClose("2026-09-28"));
    const buy = db.get("SELECT * FROM executions WHERE side='buy'")!;
    expect(buy.fill_price).toBe("100.1"); // +10 bps
    expect(buy.quantity).toBe("19"); // floor((2000-1)/100.1)
    expect(buy.gross_amount).toBe("1901.9");
    const pos = openPositions(db, exp.id)[0];
    expect(pos.cost_basis).toBe("1902.9");
    expect(pos.planned_exit_session).toBe("2026-09-29");

    processPendingOrders(db, sessionClose("2026-09-29"));
    const sell = db.get("SELECT * FROM executions WHERE side='sell'")!;
    expect(sell.fill_price).toBe("104.895"); // -10 bps
    expect(sell.ref_bar_ts).toBe(nyTime("2026-09-29", "10:00").toISOString());
    const closed = db.get("SELECT * FROM positions")!;
    // 19 × 104.895 = 1993.005 → 1993.00 (meio par), menos 1 de comissão.
    expect(closed.proceeds).toBe("1992");
    expect(closed.realized_pnl).toBe("89.1");
    expect(cashBalance(db, exp.id).toString()).toBe(D(10000).plus("89.1").toString());
  });

  it("a saída acontece após N pregões, pulando fim de semana", () => {
    const db = memDb();
    const exp = newExp(db, { horizonSessions: 5 });
    minuteBars(db, "AAA", "2026-09-30", () => 50);
    const t = nyTime("2026-09-30", "10:00");
    const dId = decision(db, exp.id, "AAA", "2026-09-30");
    createBuyOrder(db, exp, { decisionId: dId, ticker: "AAA", notional: D(1000), notBefore: t, now: t });
    processPendingOrders(db, sessionClose("2026-09-30"));
    const pos = openPositions(db, exp.id)[0];
    expect(pos.planned_exit_session).toBe("2026-10-07");
    expect(db.get("SELECT not_before FROM orders WHERE side='sell'")!.not_before).toBe(nyTime("2026-10-07", "10:00").toISOString());
  });

  it("não duplica ordens ao reprocessar (reinício)", () => {
    const db = memDb();
    const exp = newExp(db);
    minuteBars(db, "AAA", "2026-09-28", () => 100);
    const t = nyTime("2026-09-28", "10:00");
    const dId = decision(db, exp.id, "AAA");
    createBuyOrder(db, exp, { decisionId: dId, ticker: "AAA", notional: D(2000), notBefore: t, now: t });
    createBuyOrder(db, exp, { decisionId: dId, ticker: "AAA", notional: D(2000), notBefore: t, now: t });
    processPendingOrders(db, sessionClose("2026-09-28"));
    processPendingOrders(db, sessionClose("2026-09-28"));
    expect(db.all("SELECT * FROM orders WHERE side='buy'")).toHaveLength(1);
    expect(db.all("SELECT * FROM executions")).toHaveLength(1);
    expect(db.all("SELECT * FROM positions")).toHaveLength(1);
    expect(db.all("SELECT * FROM orders WHERE side='sell'")).toHaveLength(1);
  });

  it("expira compra sem negociação no pregão e devolve o caixa", () => {
    const db = memDb();
    const exp = newExp(db);
    // Cobertura completa, mas sem barras depois das 10:00 (nenhum negócio).
    minuteBars(db, "AAA", "2026-09-28", () => 100, { skip: (i) => i >= 30 });
    const t = nyTime("2026-09-28", "10:05");
    const dId = decision(db, exp.id, "AAA");
    createBuyOrder(db, exp, { decisionId: dId, ticker: "AAA", notional: D(2000), notBefore: t, now: t });
    processPendingOrders(db, nyTime("2026-09-28", "16:30"));
    expect(db.get("SELECT status FROM orders")!.status).toBe("expired");
    expect(availableCash(db, exp.id).toString()).toBe("10000");
  });

  it("não reserva mais que o caixa disponível", () => {
    const db = memDb();
    const exp = newExp(db);
    const t = nyTime("2026-09-28", "10:00");
    createBuyOrder(db, exp, { decisionId: decision(db, exp.id, "AAA"), ticker: "AAA", notional: D(9000), notBefore: t, now: t });
    createBuyOrder(db, exp, { decisionId: decision(db, exp.id, "BBB"), ticker: "BBB", notional: D(9000), notBefore: t, now: t });
    expect(availableCash(db, exp.id).toString()).toBe("0");
    expect(() =>
      createBuyOrder(db, exp, { decisionId: decision(db, exp.id, "CCC"), ticker: "CCC", notional: D(10), notBefore: t, now: t }),
    ).toThrow();
  });

  it("desdobramento ajusta quantidade uma única vez; dividendo entra no caixa uma vez", () => {
    const db = memDb();
    const exp = newExp(db, { horizonSessions: 5, allowFractional: false });
    minuteBars(db, "AAA", "2026-09-28", () => 100);
    const t = nyTime("2026-09-28", "10:00");
    createBuyOrder(db, exp, { decisionId: decision(db, exp.id, "AAA"), ticker: "AAA", notional: D(1000), notBefore: t, now: t });
    processPendingOrders(db, sessionClose("2026-09-28"));
    db.run("INSERT INTO corporate_actions(ticker, kind, ex_date, ratio, source, created_at) VALUES('AAA','split','2026-09-30','2','teste','x')");
    db.run("INSERT INTO corporate_actions(ticker, kind, ex_date, amount_per_share, source, created_at) VALUES('AAA','cash_dividend','2026-09-29','0.5','teste','x')");
    const before = cashBalance(db, exp.id);
    applyCorporateActions(db, nyTime("2026-09-30", "12:00"));
    applyCorporateActions(db, nyTime("2026-09-30", "13:00"));
    const pos = openPositions(db, exp.id)[0];
    expect(pos.quantity).toBe("18"); // 9 × 2
    expect(db.get("SELECT quantity FROM orders WHERE side='sell'")!.quantity).toBe("18");
    expect(cashBalance(db, exp.id).minus(before).toString()).toBe("4.5"); // 9 × 0,50
  });

  it("fotografia de patrimônio marca pelo fechamento", () => {
    const db = memDb();
    const exp = newExp(db, { horizonSessions: 5, allowFractional: false, costs: { commissionPerOrder: "0", commissionPerShare: "0", halfSpreadBps: "0", slippageBps: "0" } });
    minuteBars(db, "AAA", "2026-09-28", (i) => (i < 60 ? 100 : 90));
    const t = nyTime("2026-09-28", "10:00");
    createBuyOrder(db, exp, { decisionId: decision(db, exp.id, "AAA"), ticker: "AAA", notional: D(1000), notBefore: t, now: t });
    processPendingOrders(db, sessionClose("2026-09-28"));
    const snap = snapshotEquity(db, exp.id, "2026-09-28", sessionClose("2026-09-28"));
    expect(snap.positionsValue.toString()).toBe("900");
    expect(snap.equity.toString()).toBe("9900");
  });
});
