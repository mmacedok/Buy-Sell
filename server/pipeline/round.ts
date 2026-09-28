import type { Ctx } from "../context.js";
import type { Row } from "../db/db.js";
import { iso } from "../db/db.js";
import { isTradingDay, nyDate, nyTime, previousTradingDay } from "../lib/calendar.js";
import { availableCash, createBuyOrder, equityAt, listExperiments, loadExperiment, openPositions, pendingOrders, type Experiment } from "../sim/engine.js";
import { selectTrades, type Candidate } from "../sim/strategy.js";
import { lastPriceAt } from "../sim/prices.js";
import { classifyPendingEvents, runAnalysis } from "./analyse.js";

/**
 * Rodada diária de decisão de um experimento.
 *  - Uma por pregão (UNIQUE experiment_id + session_date).
 *  - Só roda dentro da janela [horário, horário + tolerância]. Fora dela a rodada é
 *    registrada como perdida: nunca se criam decisões retroativas.
 *  - Todas as ordens são criadas numa única transação no fim, com not_before = momento da decisão.
 */
export async function runDecisionRound(ctx: Ctx, expId: number) {
  const exp = loadExperiment(ctx.db, expId);
  const now = ctx.clock.now();
  const date = nyDate(now);
  if (!isTradingDay(date) || date < exp.started_on) return { status: "not_a_session" };
  const scheduled = nyTime(date, exp.config.decisionTimeNY);
  if (now < scheduled) return { status: "too_early" };

  let round = ctx.db.get<Row>("SELECT * FROM decision_rounds WHERE experiment_id = ? AND session_date = ?", exp.id, date);
  if (round && round.status !== "running") return { status: round.status, roundId: round.id };

  const deadline = new Date(scheduled.getTime() + exp.config.decisionGraceMinutes * 60_000);
  if (now > deadline) {
    if (round) ctx.db.run("UPDATE decision_rounds SET status = 'missed', summary_json = ? WHERE id = ?", JSON.stringify({ reason: "interrompida e fora da janela" }), round.id);
    else ctx.db.run(
      "INSERT INTO decision_rounds(experiment_id, session_date, scheduled_at, status, summary_json) VALUES(?,?,?,?,?)",
      exp.id, date, iso(scheduled), "missed", JSON.stringify({ reason: `sistema fora do ar no horário (${iso(now)})` }),
    );
    return { status: "missed" };
  }

  if (!round) {
    const id = ctx.db.run(
      "INSERT INTO decision_rounds(experiment_id, session_date, scheduled_at, started_at, status) VALUES(?,?,?,?,?)",
      exp.id, date, iso(scheduled), iso(now), "running",
    ).lastId;
    round = ctx.db.get<Row>("SELECT * FROM decision_rounds WHERE id = ?", id)!;
  }

  try {
    const cutoff = new Date(round.started_at);
    const newSince = nyTime(previousTradingDay(date), exp.config.decisionTimeNY);
    const cfg = exp.config;
    await classifyPendingEvents(ctx, cfg.jevModel, cfg.jevPromptVersion, { tickers: cfg.universe });

    // Mesma análise serve a todos os experimentos com os mesmos modelos: pede todos os horizontes ativos.
    const horizons = [...new Set([exp.horizon_sessions, ...listExperiments(ctx.db, true).map((e) => e.horizon_sessions)])].sort((a, b) => a - b);
    const candidates: Candidate[] = [];
    for (const ticker of cfg.universe) {
      const runId = await runAnalysis(ctx, {
        ticker, sessionDate: date, cutoff, newSince, horizons,
        analystModel: cfg.analystModel, analystPrompt: cfg.analystPromptVersion,
        jevModel: cfg.jevModel, jevPrompt: cfg.jevPromptVersion, benchmark: cfg.benchmark,
      });
      candidates.push(candidateFor(ctx, exp, runId, ticker, cutoff, newSince));
    }

    const decidedAt = ctx.clock.now();
    if (decidedAt > deadline) {
      ctx.db.run("UPDATE decision_rounds SET status = 'missed', summary_json = ? WHERE id = ?", JSON.stringify({ reason: "análise terminou fora da janela" }), round.id);
      return { status: "missed" };
    }
    const summary = ctx.db.tx(() => {
      const held = new Set([...openPositions(ctx.db, exp.id), ...pendingOrders(ctx.db, exp.id)].map((r) => r.ticker as string));
      const eq = equityAt(ctx.db, exp.id, decidedAt);
      const pendingBuys = pendingOrders(ctx.db, exp.id).filter((o) => o.side === "buy").length;
      const openSlots = cfg.maxPositions - openPositions(ctx.db, exp.id).length - pendingBuys;
      const sel = selectTrades(candidates, { equity: eq.equity, availableCash: availableCash(ctx.db, exp.id), heldOrPending: held, openSlots }, cfg);
      let buys = 0;
      for (const s of sel) {
        const decisionId = ctx.db.run(
          "INSERT INTO decisions(round_id, experiment_id, ticker, action, reason, prediction_id, rank, created_at) VALUES(?,?,?,?,?,?,?,?)",
          round!.id, exp.id, s.ticker, s.action, s.reason, s.predictionId, s.rank, iso(decidedAt),
        ).lastId;
        if (s.action === "buy" && s.notional) {
          createBuyOrder(ctx.db, exp, { decisionId, ticker: s.ticker, notional: s.notional, notBefore: decidedAt, now: decidedAt });
          buys++;
        }
      }
      const summary = { buys, candidates: candidates.length, equity: eq.equity.toFixed(2), openSlots };
      ctx.db.run("UPDATE decision_rounds SET status = 'done', decided_at = ?, summary_json = ? WHERE id = ?", iso(decidedAt), JSON.stringify(summary), round!.id);
      return summary;
    });
    return { status: "done", roundId: round.id, ...summary };
  } catch (e) {
    ctx.log(`Rodada ${exp.name} ${date} falhou`, (e as Error).message);
    ctx.db.run("UPDATE decision_rounds SET summary_json = ? WHERE id = ?", JSON.stringify({ lastError: (e as Error).message }), round.id);
    throw e;
  }
}

function candidateFor(ctx: Ctx, exp: Experiment, runId: number, ticker: string, cutoff: Date, newSince: Date): Candidate {
  const run = ctx.db.get<Row>("SELECT status FROM analysis_runs WHERE id = ?", runId)!;
  const p = ctx.db.get<Row>("SELECT * FROM predictions WHERE analysis_run_id = ? AND horizon = ?", runId, exp.horizon_sessions);
  let best: number | null = null;
  if (p) {
    const ids: number[] = JSON.parse(p.supporting_event_ids);
    for (const id of ids) {
      const ev = ctx.db.get<Row>("SELECT * FROM events WHERE id = ? AND status = 'ok' AND first_published_at > ?", id, iso(newSince));
      if (!ev) continue;
      const j = ctx.db.get<Row>(
        "SELECT * FROM jev_classifications WHERE event_id = ? AND model = ? AND prompt_version = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1",
        id, exp.config.jevModel, exp.config.jevPromptVersion, iso(cutoff),
      );
      if (j?.label === "bullish") best = Math.max(best ?? 0, j.confidence ?? 0);
    }
  }
  return {
    ticker,
    predictionId: p?.id ?? null,
    direction: p?.direction ?? null,
    strength: p?.strength ?? 0,
    sufficientData: !!p?.sufficient_data,
    bestNewBullishConfidence: best,
    hasPrice: !!lastPriceAt(ctx.db, ticker, cutoff),
    analysisStatus: run.status,
  };
}
