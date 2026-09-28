/**
 * Etapa 1 do plano — validar integrações com as contas gratuitas ANTES de confiar no restante.
 * Uso: preencha o .env e rode `npm run validate`. Nada é gravado no banco; o relatório vai para
 * data/validation-report.json. Faz no máximo 2 chamadas pagas à OpenRouter (JEV + analista), de centavos.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { readEnv, DEFAULT_UNIVERSE } from "../server/config.js";
import { FinnhubNews } from "../server/sources/finnhub.js";
import { AlpacaPrices } from "../server/sources/alpaca.js";
import { SecFilings } from "../server/sources/sec.js";
import { OpenRouter } from "../server/ai/openrouter.js";
import { OpenRouterJev, buildJevRequest, parseJevResponse } from "../server/ai/jev.js";
import { OpenRouterAnalyst } from "../server/ai/analyst.js";
import { fetchJson } from "../server/lib/http.js";
import { nyDate, previousTradingDay, isTradingDay, sessionOpen, sessionClose } from "../server/lib/calendar.js";

const env = readEnv();
const report: Record<string, unknown> = { ranAt: new Date().toISOString() };
const ok = (k: string, v: unknown) => { report[k] = { ok: true, ...(v as object) }; console.log(`✔ ${k}`, JSON.stringify(v, null, 2)); };
const fail = (k: string, e: unknown) => { report[k] = { ok: false, error: String((e as Error)?.message ?? e) }; console.log(`✘ ${k}: ${(e as Error)?.message ?? e}`); };
const skip = (k: string, why: string) => { report[k] = { ok: null, skipped: why }; console.log(`– ${k}: ${why}`); };
const now = new Date();
const minutesAgo = (iso: string) => Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);

// 1. Finnhub
if (!env.FINNHUB_API_KEY) skip("finnhub", "FINNHUB_API_KEY ausente");
else {
  try {
    const src = new FinnhubNews(env.FINNHUB_API_KEY);
    const items = await src.fetchCompanyNews("NVDA", new Date(now.getTime() - 3 * 86400_000), now);
    const withSummary = items.filter((i) => (i.summary ?? "").length >= 40).length;
    const oldest = await src.fetchCompanyNews("NVDA", new Date(now.getTime() - 370 * 86400_000), new Date(now.getTime() - 360 * 86400_000));
    ok("finnhub", {
      nvdaLast3Days: items.length,
      withSummaryShare: items.length ? +(withSummary / items.length).toFixed(2) : null,
      newestMinutesAgo: items.length ? minutesAgo(items.map((i) => i.publishedAt.toISOString()).sort().at(-1)!) : null,
      outlets: [...new Set(items.map((i) => i.outlet))].slice(0, 10),
      sample: items.slice(0, 3).map((i) => ({ at: i.publishedAt.toISOString(), title: i.title, summaryChars: i.summary?.length ?? 0, url: i.url })),
      itemsAbout1YearAgo: oldest.length,
      note: "Finnhub entrega título/resumo/link — não o texto completo.",
    });
  } catch (e) { fail("finnhub", e); }
}

// 2. Alpaca
if (!env.ALPACA_API_KEY_ID) skip("alpaca", "chaves da Alpaca ausentes");
else {
  const src = new AlpacaPrices(env.ALPACA_API_KEY_ID, env.ALPACA_API_SECRET_KEY, env.ALPACA_DATA_FEED);
  try {
    const today = nyDate(now);
    const day = isTradingDay(today) && now > sessionOpen(today) ? today : previousTradingDay(today);
    const end = now < sessionClose(day) ? new Date(now.getTime() - 60_000) : sessionClose(day);
    const minute = await src.fetchBars(["NVDA", "SPY"], "1Min", sessionOpen(day), end, false);
    const daily = await src.fetchBars(["NVDA"], "1Day", new Date(now.getTime() - 550 * 86400_000), now, true);
    const last = minute.NVDA?.at(-1);
    const expectedMinutes = Math.round((end.getTime() - sessionOpen(day).getTime()) / 60_000);
    ok("alpaca", {
      feed: src.feed,
      session: day,
      nvdaMinuteBars: minute.NVDA?.length ?? 0,
      spyMinuteBars: minute.SPY?.length ?? 0,
      minutesInWindow: expectedMinutes,
      missingMinuteShare: expectedMinutes ? +(1 - (minute.NVDA?.length ?? 0) / expectedMinutes).toFixed(3) : null,
      lastBar: last ? { ts: new Date(last.ts).toISOString(), close: last.close, minutesAgo: minutesAgo(new Date(last.ts).toISOString()) } : null,
      dailyAdjustedBars: daily.NVDA?.length ?? 0,
      note: "IEX cobre parte do mercado; a execução simulada é uma aproximação.",
    });
  } catch (e) { fail("alpaca", e); }
  try {
    const ca = await src.fetchCorporateActions(["NVDA", "AAPL", "MSFT"], nyDate(new Date(now.getTime() - 365 * 86400_000)), nyDate(now));
    ok("alpaca_corporate_actions", { count: ca.length, sample: ca.slice(0, 5) });
  } catch (e) { fail("alpaca_corporate_actions", e); }
  try {
    // Testa se dados consolidados (SIP) recentes estão bloqueados no plano gratuito.
    const sip = new AlpacaPrices(env.ALPACA_API_KEY_ID, env.ALPACA_API_SECRET_KEY, "sip");
    const r = await sip.fetchBars(["NVDA"], "1Min", new Date(now.getTime() - 30 * 60_000), now, false);
    ok("alpaca_sip_recent", { bars: r.NVDA?.length ?? 0, note: "SIP recente acessível nesta conta" });
  } catch (e) { report.alpaca_sip_recent = { ok: null, restricted: String((e as Error).message).slice(0, 200) }; console.log("– alpaca_sip_recent: restrito (esperado no plano gratuito)"); }
}

// 3. SEC
if (!env.SEC_USER_AGENT) skip("sec", "SEC_USER_AGENT ausente");
else {
  try {
    const ciks = Object.fromEntries(DEFAULT_UNIVERSE.filter((c) => c.cik).map((c) => [c.ticker, c.cik!]));
    const items = await new SecFilings(env.SEC_USER_AGENT, ciks).fetchCompanyNews("NVDA", new Date(now.getTime() - 180 * 86400_000), now);
    ok("sec", { nvda8KLast180Days: items.length, sample: items.slice(0, 3).map((i) => ({ at: i.publishedAt.toISOString(), title: i.title })) });
  } catch (e) { fail("sec", e); }
}

// 4. OpenRouter
if (!env.OPENROUTER_API_KEY) skip("openrouter", "OPENROUTER_API_KEY ausente");
else {
  const or = new OpenRouter(env.OPENROUTER_API_KEY, env.OPENROUTER_BASE_URL);
  try {
    const models = await or.listModels();
    const find = (id: string) => models.find((m) => m.id === id);
    ok("openrouter_models", {
      total: models.length,
      jev: find(env.JEV_MODEL) ? { id: env.JEV_MODEL, pricing: find(env.JEV_MODEL)!.pricing } : `NÃO ENCONTRADO: ${env.JEV_MODEL}`,
      analyst: find(env.ANALYST_MODEL) ? { id: env.ANALYST_MODEL, pricing: find(env.ANALYST_MODEL)!.pricing } : `NÃO ENCONTRADO: ${env.ANALYST_MODEL}`,
    });
  } catch (e) { fail("openrouter_models", e); }

  const sample = {
    ticker: "NVDA", company: "NVIDIA Corporation", outlet: "Validation",
    title: "Nvidia beats quarterly revenue estimates and raises guidance on strong data center demand",
    summary: "Nvidia reported revenue above analyst expectations and forecast next-quarter sales above consensus, citing demand for its data center chips.",
    publishedAt: now.toISOString(),
  };
  try {
    const req = buildJevRequest(env.JEV_MODEL, "jev-v1", sample);
    const raw = await fetchJson<any>(env.JEV_DECISIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(req), retries: 0,
    });
    let parsed: unknown;
    try { parsed = parseJevResponse(raw); } catch (e) { parsed = `NÃO RECONHECIDO — ajuste parseJevResponse: ${(e as Error).message}`; }
    ok("jev", { request: req, rawResponse: raw, parsed, expected: "bullish" });
    void OpenRouterJev;
  } catch (e) { fail("jev", e); console.log("  Confira JEV_DECISIONS_URL e o formato do corpo em server/ai/jev.ts (buildJevRequest)."); }

  try {
    const analyst = new OpenRouterAnalyst(env.ANALYST_MODEL, or);
    const r = await analyst.analyse({
      ticker: "NVDA", company: "NVIDIA Corporation", session_date: nyDate(now), cutoff_utc: now.toISOString(),
      events: [{ event_id: 1, first_published_at: now.toISOString(), is_new_since_last_round: true, article_count: 3, content_level: "summary",
        classifier: { label: "bullish", confidence: 0.9, prob_bullish: 0.9 },
        sources: [{ outlet: "Validation", title: sample.title, summary: sample.summary, published_at: now.toISOString(), url: null }] }],
      price_context: { last_price: 100, change_since_prev_close_pct: 4.1, return_5d_pct: 6.2, return_20d_pct: 3.0, volatility_20d_annualized_pct: 45 },
      market_context: { benchmark: "SPY", change_since_prev_close_pct: 0.3 },
      data_quality: ["pacote de validação sintético"],
    }, [1, 5], "analyst-v1");
    ok("analyst", { output: r.output, costUsd: r.costUsd });
  } catch (e) { fail("analyst", e); }
}

mkdirSync("data", { recursive: true });
writeFileSync("data/validation-report.json", JSON.stringify(report, null, 2));
console.log("\nRelatório salvo em data/validation-report.json");
