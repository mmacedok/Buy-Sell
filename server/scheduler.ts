import type { Ctx } from "./context.js";
import { iso } from "./db/db.js";
import { isMarketOpen, isTradingDay, nyDate, nyTime, sessionClose, tradingDaysBetween } from "./lib/calendar.js";
import { applyCorporateActions, listExperiments, processPendingOrders, snapshotEquity } from "./sim/engine.js";
import { collectCorporateActions, collectNews, collectPrices } from "./pipeline/collect.js";
import { runDecisionRound } from "./pipeline/round.js";
import { evaluatePredictions } from "./eval/evaluate.js";
import { jobState, markJob } from "./pipeline/jobs.js";

const MIN = 60_000;

function due(ctx: Ctx, name: string, everyMs: number, now: Date) {
  const st = jobState(ctx.db, name);
  return !st?.last_run_at || now.getTime() - new Date(st.last_run_at).getTime() >= everyMs;
}

async function guarded(ctx: Ctx, name: string, fn: () => Promise<unknown> | unknown) {
  const now = ctx.clock.now();
  try {
    const info = await fn();
    markJob(ctx.db, name, now, true, info ?? null);
  } catch (e) {
    markJob(ctx.db, name, now, false, undefined, (e as Error).message);
    ctx.log(`Rotina ${name} falhou`, (e as Error).message);
  }
}

/** Um passo do agendador. Todo o estado fica no banco: reiniciar retoma de onde parou. */
export async function tick(ctx: Ctx) {
  const now = ctx.clock.now();
  const today = nyDate(now);
  const session = isTradingDay(today);
  const open = isMarketOpen(now);
  const experiments = listExperiments(ctx.db, true);

  const decisionSoon = session && experiments.some((e) => {
    const t = nyTime(today, e.config.decisionTimeNY).getTime();
    return now.getTime() >= t - 20 * MIN && now.getTime() <= t + e.config.decisionGraceMinutes * MIN;
  });

  if (due(ctx, "tick_news", decisionSoon ? 5 * MIN : 15 * MIN, now)) await guarded(ctx, "tick_news", () => collectNews(ctx));

  const afterClose = session && now >= sessionClose(today) && now.getTime() < sessionClose(today).getTime() + 3 * 3600_000;
  const priceEvery = open || decisionSoon ? 1 * MIN : afterClose ? 10 * MIN : 60 * MIN;
  if (due(ctx, "tick_prices", priceEvery, now)) await guarded(ctx, "tick_prices", () => collectPrices(ctx));

  if (due(ctx, "tick_corporate_actions", 6 * 3600_000, now)) {
    await guarded(ctx, "tick_corporate_actions", async () => {
      await collectCorporateActions(ctx);
      applyCorporateActions(ctx.db, now);
    });
  }

  await guarded(ctx, "tick_orders", () => processPendingOrders(ctx.db, ctx.clock.now()));

  for (const exp of experiments) {
    if (!session) continue;
    const t = nyTime(today, exp.config.decisionTimeNY);
    if (now < t) continue;
    const done = ctx.db.get("SELECT status FROM decision_rounds WHERE experiment_id = ? AND session_date = ?", exp.id, today);
    if (done && done.status !== "running") continue;
    // Preços frescos imediatamente antes da decisão.
    await guarded(ctx, "tick_prices", () => collectPrices(ctx));
    await guarded(ctx, `round:${exp.id}`, () => runDecisionRound(ctx, exp.id));
    await guarded(ctx, "tick_orders", () => processPendingOrders(ctx.db, ctx.clock.now()));
  }

  // Fechamento: fotografia de patrimônio (inclusive pregões passados sem fotografia) e avaliação.
  if (due(ctx, "tick_close", 30 * MIN, now)) {
    await guarded(ctx, "tick_close", () => {
      const out: Record<string, number> = {};
      for (const exp of experiments) {
        const missing = tradingDaysBetween(exp.started_on, today).filter(
          (d) => sessionClose(d).getTime() + 20 * MIN <= now.getTime() &&
            !ctx.db.get("SELECT 1 FROM equity_snapshots WHERE experiment_id = ? AND session_date = ?", exp.id, d),
        );
        for (const d of missing) snapshotEquity(ctx.db, exp.id, d, now);
        out[exp.name] = missing.length;
      }
      return { snapshots: out, ...evaluatePredictions(ctx.db, now) };
    });
  }
}

export function startScheduler(ctx: Ctx, everyMs = 30_000) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(ctx);
    } catch (e) {
      ctx.log("Falha no agendador", (e as Error).message);
    } finally {
      busy = false;
    }
  };
  void run();
  const h = setInterval(run, everyMs);
  ctx.log(`Agendador iniciado (${iso(ctx.clock.now())})`);
  return () => clearInterval(h);
}
