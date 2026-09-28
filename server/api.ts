import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Ctx } from "./context.js";
import type { Row } from "./db/db.js";
import { iso } from "./db/db.js";
import { ExperimentConfigSchema } from "./config.js";
import { createExperiment, equityAt, listExperiments, loadExperiment, pendingOrders, reservedCash, availableCash } from "./sim/engine.js";
import { aiCosts, experimentMetrics } from "./eval/metrics.js";
import { collectNews, collectPrices } from "./pipeline/collect.js";
import { classifyPendingEvents } from "./pipeline/analyse.js";
import { isMarketOpen, isTradingDay, nextTradingDay, nyDate, nyTime, weekStart, shiftDay, sessionClose } from "./lib/calendar.js";
import { ingestArticles, assignEvents, loadCompanies } from "./news/ingest.js";
import { csvToArticles, csvToBars } from "./sources/csv.js";
import { saveBars } from "./sim/prices.js";
import { ANALYST_PROMPTS } from "./ai/analyst.js";
import { JEV_PROMPTS } from "./ai/jev.js";

const j = (s: string | null | undefined) => (s ? JSON.parse(s) : null);

function toCsv(rows: Row[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

const EXPORTS: Record<string, string> = {
  predictions: "SELECT * FROM predictions ORDER BY id",
  decisions: "SELECT d.*, r.session_date FROM decisions d JOIN decision_rounds r ON r.id = d.round_id ORDER BY d.id",
  orders: "SELECT * FROM orders ORDER BY id",
  executions: "SELECT * FROM executions ORDER BY id",
  positions: "SELECT * FROM positions ORDER BY id",
  cash_ledger: "SELECT * FROM cash_ledger ORDER BY id",
  equity_snapshots: "SELECT * FROM equity_snapshots ORDER BY experiment_id, session_date",
  events: "SELECT * FROM events ORDER BY id",
  articles: "SELECT id, source_key, provider, outlet, url, title, summary, content_level, published_at, first_seen_at FROM articles ORDER BY id",
  jev_classifications: "SELECT id, event_id, ticker, label, prob_bullish, prob_bearish, confidence, model, prompt_version, cost_usd, created_at FROM jev_classifications ORDER BY id",
  api_costs: "SELECT * FROM api_costs ORDER BY id",
  labeled_samples: "SELECT * FROM labeled_samples ORDER BY id",
};

export function createApi(ctx: Ctx, opts: { webDir?: string; env: Record<string, unknown> }) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(express.text({ type: "text/csv", limit: "20mb" }));
  const db = ctx.db;
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

  app.get("/api/status", wrap((_req, res) => {
    const now = ctx.clock.now();
    const budget = ctx.budget.status(now);
    const jobs = db.all("SELECT * FROM job_state ORDER BY name");
    const lastBar = db.get("SELECT MAX(ts) ts, feed FROM bars WHERE timeframe = '1Min'");
    const warnings: string[] = [];
    if (ctx.mode === "mock") warnings.push("MODO MOCK: notícias, preços e IA são sintéticos. Resultados não têm valor de avaliação.");
    if (ctx.mode === "live") {
      if (!ctx.news.some((n) => n.name === "finnhub")) warnings.push("FINNHUB_API_KEY ausente: sem notícias da Finnhub.");
      if (!ctx.prices) warnings.push("Chaves da Alpaca ausentes: sem preços, nenhuma ordem será executada.");
      if (!opts.env.OPENROUTER_API_KEY) warnings.push("OPENROUTER_API_KEY ausente: sem classificação nem previsões.");
    }
    const failing = jobs.filter((r: Row) => r.last_error);
    for (const f of failing) warnings.push(`Rotina ${f.name}: ${String(f.last_error).slice(0, 160)}`);
    res.json({
      now: iso(now),
      mode: ctx.mode,
      market: { today: nyDate(now), isTradingDay: isTradingDay(nyDate(now)), open: isMarketOpen(now) },
      prices: { source: ctx.prices?.name ?? null, feed: ctx.prices?.feed ?? null, lastMinuteBar: lastBar?.ts ?? null, delayMinutes: ctx.prices?.publishDelayMinutes ?? null },
      news: ctx.news.map((n) => n.name),
      budget: { day: Number(budget.day), month: Number(budget.month), dailyLimit: Number(budget.dailyLimit), monthlyLimit: Number(budget.monthlyLimit) },
      jobs,
      warnings,
    });
  }));

  app.get("/api/overview", wrap((_req, res) => {
    const now = ctx.clock.now();
    const exps = listExperiments(db).map((e) => {
      const m = experimentMetrics(db, e.id);
      const eq = equityAt(db, e.id, now);
      const wk = weekStart(nyDate(now));
      const prevWeekEnd = db.get<Row>(
        "SELECT equity FROM equity_snapshots WHERE experiment_id = ? AND session_date < ? ORDER BY session_date DESC LIMIT 1", e.id, wk,
      );
      const base = Number(prevWeekEnd?.equity ?? e.initial_capital);
      return {
        id: e.id,
        name: e.name,
        horizon: e.horizon_sessions,
        startedOn: e.started_on,
        equityNow: Number(eq.equity),
        cash: Number(eq.cash),
        reserved: Number(reservedCash(db, e.id)),
        positions: eq.lines,
        stalePrices: eq.stale,
        weekReturn: Number(eq.equity) / base - 1,
        metrics: { netReturn: m.equity.netReturn, maxDrawdown: m.maxDrawdown, closed: m.trades.closed, benchmarks: m.benchmarks, sampleWarning: m.sampleWarning },
        series: m.series,
        lastRound: db.get("SELECT * FROM decision_rounds WHERE experiment_id = ? ORDER BY session_date DESC LIMIT 1", e.id),
      };
    });
    res.json({ experiments: exps });
  }));

  app.get("/api/news", wrap((req, res) => {
    const ticker = typeof req.query.ticker === "string" && req.query.ticker ? req.query.ticker.toUpperCase() : null;
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const events = db.all<Row>(
      `SELECT e.*, a.content_level, a.outlet, a.url FROM events e JOIN articles a ON a.id = e.representative_article_id
       WHERE (? IS NULL OR e.ticker = ?) AND (? IS NULL OR e.status = ?) ORDER BY e.first_published_at DESC LIMIT ?`,
      ticker, ticker, status, status, limit,
    );
    res.json({
      events: events.map((e) => ({
        ...e,
        articles: db.all(
          `SELECT a.id, a.outlet, a.title, a.summary, a.url, a.published_at, a.first_seen_at, a.content_level, a.provider, ea.role
           FROM event_articles ea JOIN articles a ON a.id = ea.article_id WHERE ea.event_id = ? ORDER BY a.published_at`, e.id,
        ),
        classifications: db.all(
          "SELECT id, label, prob_bullish, prob_bearish, confidence, model, prompt_version, cost_usd, created_at FROM jev_classifications WHERE event_id = ? ORDER BY created_at DESC",
          e.id,
        ),
        label: db.get("SELECT human_label, note FROM labeled_samples WHERE event_id = ? AND ticker = ?", e.id, e.ticker) ?? null,
      })),
    });
  }));

  app.get("/api/stocks/:ticker", wrap((req, res) => {
    const t = String(req.params.ticker).toUpperCase();
    const company = db.get("SELECT * FROM companies WHERE ticker = ?", t);
    if (!company) return res.status(404).json({ error: "ação não cadastrada" });
    const bars = db.all(
      "SELECT ts, open, high, low, close, volume FROM bars WHERE ticker = ? AND timeframe = '1Day' AND adjusted = 1 ORDER BY ts DESC LIMIT 260", t,
    ).reverse();
    const intraday = db.all(
      "SELECT ts, close FROM bars WHERE ticker = ? AND timeframe = '1Min' AND adjusted = 0 AND ts >= ? ORDER BY ts",
      t, iso(new Date(ctx.clock.now().getTime() - 2 * 86400_000)),
    );
    const predictions = db.all<Row>(
      `SELECT p.*, r.status AS run_status, r.model FROM predictions p JOIN analysis_runs r ON r.id = p.analysis_run_id
       WHERE p.ticker = ? ORDER BY p.made_at DESC, p.horizon LIMIT 200`, t,
    );
    const events = db.all(
      `SELECT e.*, (SELECT label FROM jev_classifications j WHERE j.event_id = e.id ORDER BY created_at DESC LIMIT 1) AS jev_label,
         (SELECT confidence FROM jev_classifications j WHERE j.event_id = e.id ORDER BY created_at DESC LIMIT 1) AS jev_confidence
       FROM events e WHERE e.ticker = ? ORDER BY e.first_published_at DESC LIMIT 100`, t,
    );
    const trades = db.all(
      "SELECT p.*, x.name AS experiment FROM positions p JOIN experiments x ON x.id = p.experiment_id WHERE p.ticker = ? ORDER BY p.opened_at DESC LIMIT 100", t,
    );
    res.json({
      company: { ...company, aliases: j(company.aliases) },
      bars,
      intraday,
      events,
      trades,
      predictions: predictions.map((p) => ({ ...p, supporting_event_ids: j(p.supporting_event_ids), counter_evidence: j(p.counter_evidence), limitations: j(p.limitations) })),
    });
  }));

  // Registro do que estava disponível no momento da previsão.
  app.get("/api/predictions/:id", wrap((req, res) => {
    const p = db.get<Row>("SELECT * FROM predictions WHERE id = ?", Number(req.params.id));
    if (!p) return res.status(404).json({ error: "previsão não encontrada" });
    const run = db.get<Row>("SELECT * FROM analysis_runs WHERE id = ?", p.analysis_run_id)!;
    const decisions = db.all(
      `SELECT d.*, x.name AS experiment, o.status AS order_status, o.id AS order_id
       FROM decisions d JOIN experiments x ON x.id = d.experiment_id LEFT JOIN orders o ON o.decision_id = d.id WHERE d.prediction_id = ?`, p.id,
    );
    res.json({
      prediction: { ...p, supporting_event_ids: j(p.supporting_event_ids), counter_evidence: j(p.counter_evidence), limitations: j(p.limitations) },
      run: { ...run, input: j(run.input_json), output: j(run.output_json), input_json: undefined, output_json: undefined },
      decisions,
    });
  }));

  app.get("/api/experiments", wrap((_req, res) => {
    res.json({ experiments: listExperiments(db).map((e) => experimentMetrics(db, e.id)) });
  }));

  app.get("/api/experiments/:id", wrap((req, res) => {
    const id = Number(req.params.id);
    const e = loadExperiment(db, id);
    const now = ctx.clock.now();
    res.json({
      metrics: experimentMetrics(db, id),
      cash: { balance: Number(equityAt(db, id, now).cash), reserved: Number(reservedCash(db, id)), available: Number(availableCash(db, id)) },
      positions: db.all("SELECT * FROM positions WHERE experiment_id = ? ORDER BY opened_at DESC LIMIT 300", id),
      openValuation: equityAt(db, id, now).lines,
      pending: pendingOrders(db, id),
      orders: db.all(
        `SELECT o.*, x.ref_price, x.fill_price, x.quantity AS exec_qty, x.gross_amount, x.commission, x.spread_cost, x.slippage_cost,
           x.executed_at, x.price_source, x.approximation
         FROM orders o LEFT JOIN executions x ON x.order_id = o.id WHERE o.experiment_id = ? ORDER BY o.id DESC LIMIT 300`, id,
      ),
      rounds: db.all("SELECT * FROM decision_rounds WHERE experiment_id = ? ORDER BY session_date DESC LIMIT 60", id).map((r: Row) => ({
        ...r,
        summary: j(r.summary_json),
        decisions: db.all(
          `SELECT d.*, p.direction, p.strength, p.explanation FROM decisions d LEFT JOIN predictions p ON p.id = d.prediction_id
           WHERE d.round_id = ? ORDER BY d.action = 'buy' DESC, d.rank, d.ticker`, r.id,
        ),
      })),
      ledger: db.all("SELECT * FROM cash_ledger WHERE experiment_id = ? ORDER BY ts DESC, id DESC LIMIT 300", id),
      config: e.config,
    });
  }));

  // Relatório semanal: operações encerradas, posições abertas, resultado pelo último preço e patrimônio.
  app.get("/api/experiments/:id/weekly", wrap((req, res) => {
    const id = Number(req.params.id);
    const now = ctx.clock.now();
    const week = typeof req.query.week === "string" ? req.query.week : weekStart(nyDate(now));
    const from = nyTime(week, "00:00"), to = nyTime(shiftDay(week, 7), "00:00");
    const at = to < now ? to : now;
    const eq = equityAt(db, id, at);
    const startEq = db.get<Row>("SELECT equity FROM equity_snapshots WHERE experiment_id = ? AND session_date < ? ORDER BY session_date DESC LIMIT 1", id, week);
    const base = Number(startEq?.equity ?? loadExperiment(db, id).initial_capital);
    res.json({
      week,
      closedTrades: db.all("SELECT * FROM positions WHERE experiment_id = ? AND status = 'closed' AND closed_at >= ? AND closed_at < ? ORDER BY closed_at", id, iso(from), iso(to)),
      openPositions: eq.lines,
      equityStart: base,
      equityEnd: Number(eq.equity),
      weekReturn: Number(eq.equity) / base - 1,
      snapshots: db.all("SELECT * FROM equity_snapshots WHERE experiment_id = ? AND session_date >= ? AND session_date < ? ORDER BY session_date", id, week, shiftDay(week, 7)),
    });
  }));

  app.post("/api/experiments", wrap((req, res) => {
    const body = z.object({ name: z.string().min(1), config: ExperimentConfigSchema, startedOn: z.string().optional() }).parse(req.body);
    if (!ANALYST_PROMPTS[body.config.analystPromptVersion] || !JEV_PROMPTS[body.config.jevPromptVersion]) {
      return res.status(400).json({ error: "versão de instruções desconhecida" });
    }
    const now = ctx.clock.now();
    // Experimentos novos só começam no próximo pregão: nada de decisões retroativas.
    const startedOn = body.startedOn && body.startedOn > nyDate(now) ? body.startedOn : nextTradingDay(nyDate(now));
    res.json(createExperiment(db, body.name, body.config, startedOn, now));
  }));

  app.post("/api/experiments/:id/active", wrap((req, res) => {
    db.run("UPDATE experiments SET active = ? WHERE id = ?", req.body?.active ? 1 : 0, Number(req.params.id));
    res.json({ ok: true });
  }));

  app.get("/api/settings", wrap((_req, res) => {
    res.json({
      companies: db.all("SELECT * FROM companies ORDER BY is_benchmark, ticker").map((c: Row) => ({ ...c, aliases: j(c.aliases) })),
      env: opts.env,
      prompts: { analyst: Object.keys(ANALYST_PROMPTS), jev: Object.keys(JEV_PROMPTS) },
      analystPrompts: ANALYST_PROMPTS,
      aiCosts: aiCosts(db),
      experiments: listExperiments(db).map((e) => ({ id: e.id, name: e.name, active: e.active, startedOn: e.started_on, config: e.config })),
    });
  }));

  app.post("/api/companies", wrap((req, res) => {
    const c = z.object({
      ticker: z.string().regex(/^[A-Z.]{1,6}$/),
      name: z.string().min(1),
      aliases: z.array(z.string()).default([]),
      cik: z.string().nullish(),
      ir_rss_url: z.string().url().nullish(),
      active: z.boolean().default(true),
    }).parse(req.body);
    db.run(
      `INSERT INTO companies(ticker, name, aliases, cik, ir_rss_url, active) VALUES(?,?,?,?,?,?)
       ON CONFLICT(ticker) DO UPDATE SET name = excluded.name, aliases = excluded.aliases, cik = excluded.cik,
         ir_rss_url = excluded.ir_rss_url, active = excluded.active`,
      c.ticker, c.name, JSON.stringify(c.aliases), c.cik ?? null, c.ir_rss_url ?? null, c.active ? 1 : 0,
    );
    res.json({ ok: true, note: "O universo de experimentos já criados não muda; crie um experimento novo para incluir a ação." });
  }));

  app.post("/api/actions/collect", wrap(async (_req, res) => {
    const news = await collectNews(ctx);
    const prices = await collectPrices(ctx).catch((e) => ({ error: (e as Error).message }));
    res.json({ news, prices });
  }));

  app.post("/api/actions/classify", wrap(async (_req, res) => {
    const out: Record<string, unknown> = {};
    for (const e of listExperiments(db, true)) {
      const k = `${e.config.jevModel}|${e.config.jevPromptVersion}`;
      if (!out[k]) out[k] = await classifyPendingEvents(ctx, e.config.jevModel, e.config.jevPromptVersion);
    }
    res.json(out);
  }));

  // Importação CSV (testes e recuperação de falhas).
  app.post("/api/import/news", wrap((req, res) => {
    const arts = csvToArticles(String(req.body ?? ""));
    const now = ctx.clock.now();
    const companies = loadCompanies(db);
    const r = ingestArticles(db, arts.filter((a) => a.publishedAt <= now), companies, now);
    res.json({ ...r, events: assignEvents(db, companies) });
  }));

  app.post("/api/import/bars", wrap((req, res) => {
    const now = ctx.clock.now();
    const groups = csvToBars(String(req.body ?? ""));
    for (const g of groups) {
      const ts = g.bars.map((b) => new Date(b.ts).getTime()).sort((a, b) => a - b);
      if (!ts.length) continue;
      saveBars(db, { ticker: g.ticker, timeframe: g.timeframe, adjusted: g.adjusted, feed: "csv", fetchedAt: now, from: new Date(ts[0]), until: new Date(ts.at(-1)! + 60_000) }, g.bars);
    }
    res.json({ groups: groups.length });
  }));

  // Amostra revisada manualmente para medir a classificação do JEV.
  app.post("/api/labels", wrap((req, res) => {
    const b = z.object({ eventId: z.number().int(), ticker: z.string(), label: z.enum(["bullish", "bearish", "ambiguous", "irrelevant"]), note: z.string().optional() }).parse(req.body);
    db.run(
      `INSERT INTO labeled_samples(event_id, ticker, human_label, note, created_at) VALUES(?,?,?,?,?)
       ON CONFLICT(event_id, ticker) DO UPDATE SET human_label = excluded.human_label, note = excluded.note`,
      b.eventId, b.ticker, b.label, b.note ?? null, iso(ctx.clock.now()),
    );
    res.json({ ok: true });
  }));

  app.get("/api/labels/agreement", wrap((_req, res) => {
    const rows = db.all<Row>(
      `SELECT l.human_label, (SELECT label FROM jev_classifications j WHERE j.event_id = l.event_id ORDER BY created_at DESC LIMIT 1) AS jev_label
       FROM labeled_samples l`,
    );
    const comparable = rows.filter((r) => (r.human_label === "bullish" || r.human_label === "bearish") && r.jev_label);
    res.json({
      labeled: rows.length,
      comparable: comparable.length,
      agreement: comparable.length ? comparable.filter((r) => r.human_label === r.jev_label).length / comparable.length : null,
      byLabel: rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.human_label]: (acc[r.human_label] ?? 0) + 1 }), {}),
    });
  }));

  app.get("/api/export/:table.csv", wrap((req, res) => {
    const sql = EXPORTS[String(req.params.table)];
    if (!sql) return res.status(404).send("tabela não exportável");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${req.params.table}.csv"`);
    res.send(toCsv(db.all(sql)));
  }));

  app.get("/api/calendar", wrap((_req, res) => {
    const today = nyDate(ctx.clock.now());
    res.json({ today, isTradingDay: isTradingDay(today), close: isTradingDay(today) ? iso(sessionClose(today)) : null, next: nextTradingDay(today) });
  }));

  if (opts.webDir && existsSync(opts.webDir)) {
    app.use(express.static(opts.webDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(opts.webDir!, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof z.ZodError ? 400 : 500;
    res.status(status).json({ error: err instanceof z.ZodError ? err.issues : (err as Error).message });
  });
  return app;
}
