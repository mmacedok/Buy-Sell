import { describe, expect, it } from "vitest";
import { buildContext } from "../server/bootstrap.js";
import { DB } from "../server/db/db.js";
import { ManualClock } from "../server/lib/clock.js";
import { runClock } from "../scripts/simulate.js";
import { cashBalance, listExperiments } from "../server/sim/engine.js";
import { experimentMetrics } from "../server/eval/metrics.js";
import { D, ZERO } from "../server/lib/money.js";
import { nyTime } from "../server/lib/calendar.js";

function env(): any {
  return {
    DATA_MODE: "mock", DB_PATH: ":memory:", JEV_MODEL: "x", ANALYST_MODEL: "y",
    AI_BUDGET_DAILY_USD: 1, AI_BUDGET_MONTHLY_USD: 10, OPENROUTER_API_KEY: "", ALPACA_DATA_FEED: "iex",
  };
}

describe("fluxo completo (modo mock)", () => {
  it("coleta → classificação → previsão → operação → resultado, sem violar regras", async () => {
    const clock = new ManualClock(new Date("2026-09-27T12:00:00Z")); // domingo
    const db = new DB(":memory:");
    const { ctx } = buildContext({ env: env(), db, clock });
    ctx.log = () => {};
    await runClock(ctx, clock, new Date("2026-10-06T22:00:00Z"), 10);

    const exps = listExperiments(db);
    expect(exps).toHaveLength(2);
    expect(db.get("SELECT COUNT(*) n FROM events")!.n).toBeGreaterThan(0);
    expect(db.get("SELECT COUNT(*) n FROM jev_classifications")!.n).toBeGreaterThan(0);
    expect(db.get("SELECT COUNT(*) n FROM predictions")!.n).toBeGreaterThan(0);
    // Um evento por acontecimento: há mais artigos do que eventos (republicações agrupadas).
    expect(db.get("SELECT COUNT(*) n FROM articles")!.n).toBeGreaterThan(db.get("SELECT COUNT(*) n FROM events")!.n);

    // Uma rodada por pregão por experimento (28/09 a 06/10 = 7 pregões).
    for (const e of exps) {
      expect(db.get("SELECT COUNT(*) n FROM decision_rounds WHERE experiment_id = ? AND status = 'done'", e.id)!.n).toBe(7);
    }

    // Toda execução ocorre depois da decisão que a originou.
    const bad = db.all(
      `SELECT x.* FROM executions x JOIN orders o ON o.id = x.order_id JOIN decisions d ON d.id = o.decision_id
       WHERE x.executed_at < d.created_at`,
    );
    expect(bad).toHaveLength(0);
    const anyBuys = db.get("SELECT COUNT(*) n FROM executions WHERE side = 'buy'")!.n;
    expect(anyBuys).toBeGreaterThan(0);

    // Saídas do experimento A: exatamente 1 pregão depois da entrada, às 10:00.
    const a = exps.find((e) => e.horizon_sessions === 1)!;
    for (const p of db.all("SELECT * FROM positions WHERE experiment_id = ? AND status = 'closed'", a.id)) {
      expect(p.closed_at).toBe(nyTime(p.planned_exit_session, "10:00").toISOString());
    }

    // Contabilidade: caixa = depósito + vendas − compras − comissões; nunca negativo.
    for (const e of exps) {
      const cash = cashBalance(db, e.id);
      expect(cash.gte(0)).toBe(true);
      const ledger = db.all("SELECT * FROM cash_ledger WHERE experiment_id = ? ORDER BY ts, id", e.id);
      let running = ZERO;
      for (const l of ledger) {
        running = running.plus(l.amount);
        expect(running.gte(0)).toBe(true);
      }
      const realized = db.all("SELECT realized_pnl FROM positions WHERE experiment_id = ? AND status='closed'", e.id)
        .reduce<typeof ZERO>((acc, r) => acc.plus(r.realized_pnl), ZERO);
      const openCost = db.all("SELECT cost_basis FROM positions WHERE experiment_id = ? AND status='open'", e.id)
        .reduce<typeof ZERO>((acc, r) => acc.plus(r.cost_basis), ZERO);
      expect(cash.toString()).toBe(D(e.initial_capital).plus(realized).minus(openCost).toString());
      // No máximo 5 posições simultâneas e sem duas posições abertas da mesma ação.
      const open = db.all("SELECT ticker FROM positions WHERE experiment_id = ? AND status='open'", e.id);
      expect(open.length).toBeLessThanOrEqual(5);
      expect(new Set(open.map((r) => r.ticker)).size).toBe(open.length);
    }

    // Previsões de 1 pregão avaliadas; métricas calculáveis.
    expect(db.get("SELECT COUNT(*) n FROM predictions WHERE eval_status = 'evaluated'")!.n).toBeGreaterThan(0);
    const m = experimentMetrics(db, a.id);
    expect(m.series.strategy.length).toBeGreaterThan(0);
    expect(m.benchmarks.benchmark.return).not.toBeNull();
  }, 120_000);

  it("reinício no meio do pregão não duplica e rodada perdida não é refeita depois", async () => {
    const clock = new ManualClock(new Date("2026-09-28T12:00:00Z"));
    const db = new DB(":memory:");
    const { ctx } = buildContext({ env: env(), db, clock });
    ctx.log = () => {};
    // Sistema desligado entre 09:40 e 11:30 de Nova York em 29/09 (perde a rodada das 10:00).
    const off = (t: Date) => t >= nyTime("2026-09-29", "09:40") && t < nyTime("2026-09-29", "11:30");
    await runClock(ctx, clock, new Date("2026-09-30T21:00:00Z"), 10, off);
    // "Reinício": novo contexto no mesmo banco, roda o mesmo período de novo.
    const again = buildContext({ env: env(), db, clock: new ManualClock(new Date("2026-09-30T21:00:00Z")) }).ctx;
    again.log = () => {};
    const { tick } = await import("../server/scheduler.js");
    await tick(again);
    await tick(again);
    for (const e of listExperiments(db)) {
      const rounds = db.all("SELECT session_date, status FROM decision_rounds WHERE experiment_id = ? ORDER BY session_date", e.id);
      expect(rounds.map((r) => `${r.session_date}:${r.status}`)).toEqual(["2026-09-28:done", "2026-09-29:missed", "2026-09-30:done"]);
      const dup = db.all("SELECT decision_id, COUNT(*) n FROM orders WHERE side='buy' AND experiment_id = ? GROUP BY decision_id HAVING n > 1", e.id);
      expect(dup).toHaveLength(0);
    }
    expect(db.get("SELECT COUNT(*) n FROM decisions d JOIN decision_rounds r ON r.id = d.round_id WHERE r.session_date = '2026-09-29'")!.n).toBe(0);
  }, 120_000);
});
