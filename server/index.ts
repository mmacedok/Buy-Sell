import { resolve } from "node:path";
import { buildContext } from "./bootstrap.js";
import { createApi } from "./api.js";
import { startScheduler } from "./scheduler.js";

const { ctx, env } = buildContext();

// Configuração exibida na tela de Configurações — nunca as chaves.
const publicEnv = {
  DATA_MODE: env.DATA_MODE,
  ALPACA_DATA_FEED: env.ALPACA_DATA_FEED,
  JEV_MODEL: env.JEV_MODEL,
  ANALYST_MODEL: env.ANALYST_MODEL,
  AI_BUDGET_DAILY_USD: env.AI_BUDGET_DAILY_USD,
  AI_BUDGET_MONTHLY_USD: env.AI_BUDGET_MONTHLY_USD,
  FINNHUB_API_KEY: !!env.FINNHUB_API_KEY,
  ALPACA_API_KEY_ID: !!env.ALPACA_API_KEY_ID,
  OPENROUTER_API_KEY: !!env.OPENROUTER_API_KEY,
  SEC_USER_AGENT: !!env.SEC_USER_AGENT,
};

const app = createApi(ctx, { webDir: resolve("dist/web"), env: publicEnv });
// Só na máquina local: as chaves e o banco não ficam expostos na rede.
app.listen(env.PORT, "127.0.0.1", () => {
  ctx.log(`API em http://127.0.0.1:${env.PORT} (modo ${env.DATA_MODE})`);
});
if (process.env.NO_SCHEDULER !== "1") startScheduler(ctx);
