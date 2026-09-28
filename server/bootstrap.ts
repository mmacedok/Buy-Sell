import { DB } from "./db/db.js";
import { BENCHMARK, DEFAULT_UNIVERSE, ExperimentConfigSchema, readEnv, type Env } from "./config.js";
import { systemClock, type Clock } from "./lib/clock.js";
import { AiBudget } from "./ai/budget.js";
import { OpenRouter } from "./ai/openrouter.js";
import { OpenRouterJev } from "./ai/jev.js";
import { OpenRouterAnalyst } from "./ai/analyst.js";
import { MockAnalyst, MockJev } from "./ai/mock.js";
import { FinnhubNews } from "./sources/finnhub.js";
import { AlpacaPrices } from "./sources/alpaca.js";
import { SecFilings } from "./sources/sec.js";
import { IrRss } from "./sources/rss.js";
import { MockNews, MockPrices } from "./sources/mock.js";
import type { NewsSource } from "./sources/types.js";
import type { Ctx } from "./context.js";
import { createExperiment, listExperiments } from "./sim/engine.js";
import { isTradingDay, nextTradingDay, nyDate, nyTime } from "./lib/calendar.js";
import type { Row } from "./db/db.js";

export function seedCompanies(db: DB) {
  const n = db.get<Row>("SELECT COUNT(*) n FROM companies")!.n;
  if (n > 0) return;
  for (const c of DEFAULT_UNIVERSE) {
    db.run("INSERT INTO companies(ticker, name, aliases, cik) VALUES(?,?,?,?)", c.ticker, c.name, JSON.stringify(c.aliases), c.cik ?? null);
  }
  db.run("INSERT INTO companies(ticker, name, aliases, is_benchmark) VALUES(?,?,?,1)", BENCHMARK.ticker, BENCHMARK.name, JSON.stringify(BENCHMARK.aliases));
}

/** Cria os experimentos A (1 pregão) e B (5 pregões) na primeira execução, com modelos e instruções fixados. */
export function seedExperiments(db: DB, env: Pick<Env, "JEV_MODEL" | "ANALYST_MODEL" | "DATA_MODE">, now: Date) {
  if (listExperiments(db).length) return;
  const universe = db.all<Row>("SELECT ticker FROM companies WHERE active = 1 AND is_benchmark = 0 ORDER BY ticker").map((r) => r.ticker);
  const today = nyDate(now);
  const startsOn = isTradingDay(today) && now < nyTime(today, "10:00") ? today : nextTradingDay(today);
  const mock = env.DATA_MODE === "mock";
  for (const [name, h] of [["A — 1 pregão", 1], ["B — 5 pregões", 5]] as const) {
    createExperiment(
      db,
      name,
      ExperimentConfigSchema.parse({
        horizonSessions: h,
        universe,
        jevModel: mock ? "mock/jev" : env.JEV_MODEL,
        jevPromptVersion: "jev-v1",
        analystModel: mock ? "mock/analyst" : env.ANALYST_MODEL,
        analystPromptVersion: "analyst-v1",
      }),
      startsOn,
      now,
    );
  }
}

export function buildContext(opts: { env?: Env; db?: DB; clock?: Clock } = {}): { ctx: Ctx; env: Env } {
  const env = opts.env ?? readEnv();
  const db = opts.db ?? new DB(env.DB_PATH);
  const clock = opts.clock ?? systemClock;
  const log = (msg: string, extra?: unknown) =>
    console.log(`[${clock.now().toISOString()}] ${msg}${extra !== undefined ? " " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : ""}`);
  seedCompanies(db);
  const budget = new AiBudget(db, { dailyUsd: env.AI_BUDGET_DAILY_USD, monthlyUsd: env.AI_BUDGET_MONTHLY_USD });

  let ctx: Ctx;
  if (env.DATA_MODE === "mock") {
    const names = Object.fromEntries(db.all<Row>("SELECT ticker, name FROM companies").map((r) => [r.ticker, r.name.split(" ")[0]]));
    const mj = new MockJev(), ma = new MockAnalyst();
    ctx = {
      db, clock, mode: "mock", log, budget,
      news: [new MockNews(names)],
      prices: new MockPrices(),
      jev: () => mj,
      analyst: () => ma,
      costEstimates: { jev: 0, analyst: 0 },
    };
  } else {
    const or = new OpenRouter(env.OPENROUTER_API_KEY, env.OPENROUTER_BASE_URL);
    const news: NewsSource[] = [];
    if (env.FINNHUB_API_KEY) news.push(new FinnhubNews(env.FINNHUB_API_KEY));
    if (env.SEC_USER_AGENT) {
      const ciks = Object.fromEntries(db.all<Row>("SELECT ticker, cik FROM companies WHERE cik IS NOT NULL").map((r) => [r.ticker, r.cik]));
      news.push(new SecFilings(env.SEC_USER_AGENT, ciks));
    }
    const feeds = Object.fromEntries(db.all<Row>("SELECT ticker, ir_rss_url FROM companies WHERE ir_rss_url IS NOT NULL").map((r) => [r.ticker, r.ir_rss_url]));
    if (Object.keys(feeds).length) news.push(new IrRss(feeds));
    ctx = {
      db, clock, mode: "live", log, budget, news,
      prices: env.ALPACA_API_KEY_ID ? new AlpacaPrices(env.ALPACA_API_KEY_ID, env.ALPACA_API_SECRET_KEY, env.ALPACA_DATA_FEED) : null,
      jev: (model) => (or.configured ? new OpenRouterJev(model, env.OPENROUTER_API_KEY, env.JEV_DECISIONS_URL) : null),
      analyst: (model) => (or.configured ? new OpenRouterAnalyst(model, or) : null),
      costEstimates: { jev: 0.002, analyst: 0.05 },
    };
  }
  seedExperiments(db, env, clock.now());
  return { ctx, env };
}
