import type { Ctx } from "../context.js";
import type { Row } from "../db/db.js";
import { iso } from "../db/db.js";
import { jevCacheKey, type JevInput } from "../ai/jev.js";
import type { AnalysisPackage } from "../ai/analyst.js";
import { BudgetExceeded } from "../ai/budget.js";
import { priceFeatures } from "../analysis/features.js";
import { D } from "../lib/money.js";

const EVENT_LOOKBACK_MS = 5 * 86400_000;

/** Classifica (JEV) eventos válidos ainda sem classificação para este modelo/instrução. Usa cache por conteúdo. */
export async function classifyPendingEvents(ctx: Ctx, model: string, promptVersion: string, opts: { tickers?: string[]; since?: Date } = {}) {
  const client = ctx.jev(model);
  if (!client) return { classified: 0, skipped: "JEV não configurado" };
  const now = ctx.clock.now();
  const since = opts.since ?? new Date(now.getTime() - EVENT_LOOKBACK_MS);
  const events = ctx.db.all<Row>(
    `SELECT e.*, a.title AS a_title, a.summary AS a_summary, a.outlet, a.published_at AS a_pub, c.name AS company
     FROM events e JOIN articles a ON a.id = e.representative_article_id JOIN companies c ON c.ticker = e.ticker
     WHERE e.status = 'ok' AND e.last_published_at >= ? ORDER BY e.first_published_at`,
    iso(since),
  );
  let classified = 0, cached = 0;
  for (const e of events) {
    if (opts.tickers && !opts.tickers.includes(e.ticker)) continue;
    const input: JevInput = { ticker: e.ticker, company: e.company, title: e.a_title, summary: e.a_summary, outlet: e.outlet, publishedAt: e.a_pub };
    const key = jevCacheKey(client.model, promptVersion, input);
    if (ctx.db.get("SELECT 1 FROM jev_classifications WHERE cache_key = ?", key)) { cached++; continue; }
    try {
      ctx.budget.assertCanSpend(now, ctx.costEstimates.jev);
      const r = await client.classify(input, promptVersion);
      const cost = r.costUsd ?? ctx.costEstimates.jev;
      ctx.db.tx(() => {
        ctx.db.run(
          `INSERT INTO jev_classifications(event_id, ticker, cache_key, label, prob_bullish, prob_bearish, confidence, model,
             prompt_version, input_text, raw_response, cost_usd, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          e.id, e.ticker, key, r.label, r.probBullish, r.probBearish, r.confidence, client.model, promptVersion,
          JSON.stringify(input), JSON.stringify(r.raw), D(cost).toFixed(), iso(ctx.clock.now()),
        );
        ctx.budget.record(ctx.clock.now(), { provider: "openrouter", model: client.model, purpose: "jev", ref: `event:${e.id}`, costUsd: cost });
      });
      classified++;
    } catch (err) {
      if (err instanceof BudgetExceeded) { ctx.log(err.message); break; }
      ctx.log(`JEV falhou no evento ${e.id}`, (err as Error).message);
    }
  }
  return { classified, cached };
}

/**
 * Monta o pacote da ação com o que o sistema sabia até `cutoff`.
 * `newSince`: eventos publicados depois disso contam como fatos novos.
 */
export function buildPackage(ctx: Ctx, ticker: string, sessionDate: string, cutoff: Date, newSince: Date, jevModel: string, jevPrompt: string, benchmark: string): AnalysisPackage {
  const c = ctx.db.get<Row>("SELECT * FROM companies WHERE ticker = ?", ticker)!;
  const events = ctx.db.all<Row>(
    `SELECT * FROM events WHERE ticker = ? AND status = 'ok' AND first_seen_at <= ? AND first_published_at <= ?
       AND last_published_at >= ? ORDER BY first_published_at DESC LIMIT 12`,
    ticker, iso(cutoff), iso(cutoff), iso(new Date(cutoff.getTime() - EVENT_LOOKBACK_MS)),
  );
  const pkgEvents = events.map((e) => {
    const arts = ctx.db.all<Row>(
      `SELECT a.* FROM event_articles ea JOIN articles a ON a.id = ea.article_id
       WHERE ea.event_id = ? AND a.first_seen_at <= ? ORDER BY a.published_at LIMIT 3`,
      e.id, iso(cutoff),
    );
    const jev = ctx.db.get<Row>(
      `SELECT * FROM jev_classifications WHERE event_id = ? AND model = ? AND prompt_version = ? AND created_at <= ?
       ORDER BY created_at DESC LIMIT 1`,
      e.id, jevModel, jevPrompt, iso(cutoff),
    );
    const articleCount = ctx.db.get<Row>(
      `SELECT COUNT(*) n FROM event_articles ea JOIN articles a ON a.id = ea.article_id WHERE ea.event_id = ? AND a.first_seen_at <= ?`,
      e.id, iso(cutoff),
    )!.n;
    return {
      event_id: e.id as number,
      first_published_at: e.first_published_at as string,
      is_new_since_last_round: new Date(e.first_published_at) > newSince,
      article_count: Number(articleCount),
      content_level: arts.some((a) => a.content_level !== "title_only") ? "summary" : "title_only",
      classifier: jev ? { label: jev.label, confidence: jev.confidence, prob_bullish: jev.prob_bullish } : null,
      sources: arts.map((a) => ({ outlet: a.outlet, title: a.title, summary: a.summary, published_at: a.published_at, url: a.url })),
    };
  });
  const pf = priceFeatures(ctx.db, ticker, cutoff);
  const mf = priceFeatures(ctx.db, benchmark, cutoff);
  const dataQuality = [...pf.issues, ...mf.issues.map((i) => `${benchmark}: ${i}`)];
  if (pkgEvents.length && pkgEvents.every((e) => e.content_level === "title_only")) dataQuality.push("eventos só com título (sem resumo)");
  if (pkgEvents.some((e) => !e.classifier)) dataQuality.push("há eventos sem classificação do JEV");
  if (ctx.prices?.feed === "iex") dataQuality.push("preços do feed IEX (parte do mercado)");
  if (ctx.mode === "mock") dataQuality.push("DADOS SIMULADOS (modo mock)");
  return {
    ticker,
    company: c.name,
    session_date: sessionDate,
    cutoff_utc: iso(cutoff),
    events: pkgEvents,
    price_context: pf.features,
    market_context: { benchmark, ...mf.features },
    data_quality: dataQuality,
  };
}

/**
 * Executa (ou reaproveita) a análise de uma ação para o pregão. Única por (pregão, ação, modelo, instruções):
 * reiniciar não gera uma segunda previsão.
 */
export async function runAnalysis(
  ctx: Ctx,
  args: { ticker: string; sessionDate: string; cutoff: Date; newSince: Date; horizons: number[]; analystModel: string; analystPrompt: string; jevModel: string; jevPrompt: string; benchmark: string },
) {
  const existing = ctx.db.get<Row>(
    "SELECT * FROM analysis_runs WHERE session_date = ? AND ticker = ? AND model = ? AND prompt_version = ?",
    args.sessionDate, args.ticker, args.analystModel, args.analystPrompt,
  );
  // Falhas (erro ou orçamento) podem ser refeitas; análises concluídas nunca são substituídas.
  if (existing && existing.status !== "error" && existing.status !== "budget") return existing.id as number;

  const pkg = buildPackage(ctx, args.ticker, args.sessionDate, args.cutoff, args.newSince, args.jevModel, args.jevPrompt, args.benchmark);
  const hasNew = pkg.events.some((e) => e.is_new_since_last_round);
  let status = "ok", output: unknown = null, error: string | null = null, cost = 0;

  const client = ctx.analyst(args.analystModel);
  const empty = (reason: string) => ({
    predictions: args.horizons.map((h) => ({ horizon: h, direction: null, strength: 0, sufficient_data: false, supporting_event_ids: [], counter_evidence: [], limitations: [reason], explanation: reason })),
  });
  if (!hasNew) {
    status = "no_events";
    output = empty("Sem eventos novos desde a rodada anterior; nenhuma chamada ao modelo.");
  } else if (!client) {
    status = "error";
    error = "Analista não configurado";
  } else {
    try {
      ctx.budget.assertCanSpend(ctx.clock.now(), ctx.costEstimates.analyst);
      const r = await client.analyse(pkg, args.horizons, args.analystPrompt);
      output = r.output;
      cost = r.costUsd ?? ctx.costEstimates.analyst;
    } catch (e) {
      status = e instanceof BudgetExceeded ? "budget" : "error";
      error = (e as Error).message;
    }
  }
  const madeAt = ctx.clock.now();
  return ctx.db.tx(() => {
    const runId = ctx.db.run(
      `INSERT INTO analysis_runs(session_date, ticker, cutoff_at, model, prompt_version, status, input_json, output_json, error, cost_usd, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_date, ticker, model, prompt_version) DO UPDATE SET status = excluded.status, input_json = excluded.input_json,
         output_json = excluded.output_json, error = excluded.error, cost_usd = excluded.cost_usd, created_at = excluded.created_at, cutoff_at = excluded.cutoff_at`,
      args.sessionDate, args.ticker, iso(args.cutoff), args.analystModel, args.analystPrompt, status, JSON.stringify(pkg),
      output ? JSON.stringify(output) : null, error, D(cost).toFixed(), iso(madeAt),
    );
    const run = ctx.db.get<Row>("SELECT id FROM analysis_runs WHERE session_date = ? AND ticker = ? AND model = ? AND prompt_version = ?", args.sessionDate, args.ticker, args.analystModel, args.analystPrompt)!;
    if (cost > 0) ctx.budget.record(madeAt, { provider: "openrouter", model: args.analystModel, purpose: "analyst", ref: `run:${run.id}`, costUsd: cost });
    // Só análises concluídas geram previsões; falhas ficam registradas no run e podem ser refeitas.
    const preds = status === "ok" || status === "no_events" ? (output as { predictions: any[] }).predictions : [];
    for (const p of preds) {
      ctx.db.run(
        `INSERT INTO predictions(analysis_run_id, ticker, session_date, made_at, horizon, direction, strength, sufficient_data,
           supporting_event_ids, counter_evidence, limitations, explanation)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(analysis_run_id, horizon) DO NOTHING`,
        run.id, args.ticker, args.sessionDate, iso(madeAt), p.horizon, p.direction, p.strength, p.sufficient_data ? 1 : 0,
        JSON.stringify(p.supporting_event_ids), JSON.stringify(p.counter_evidence), JSON.stringify(p.limitations), p.explanation,
      );
    }
    return run.id as number;
  });
}
