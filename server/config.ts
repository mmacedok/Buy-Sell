import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";

/** Carrega .env simples (sem dependência externa). Variáveis já definidas no ambiente têm prioridade. */
export function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

const EnvSchema = z.object({
  DATA_MODE: z.enum(["live", "mock"]).default("live"),
  FINNHUB_API_KEY: z.string().default(""),
  ALPACA_API_KEY_ID: z.string().default(""),
  ALPACA_API_SECRET_KEY: z.string().default(""),
  ALPACA_DATA_FEED: z.enum(["iex", "sip", "delayed_sip"]).default("iex"),
  SEC_USER_AGENT: z.string().default(""),
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  JEV_DECISIONS_URL: z.string().default("https://openrouter.ai/api/alpha/decisions"),
  JEV_MODEL: z.string().default("typesafe/jev-1.13"),
  ANALYST_MODEL: z.string().default("anthropic/claude-sonnet-5"),
  AI_BUDGET_DAILY_USD: z.coerce.number().default(2),
  AI_BUDGET_MONTHLY_USD: z.coerce.number().default(30),
  PORT: z.coerce.number().default(8787),
  DB_PATH: z.string().default("data/app.db"),
});
export type Env = z.infer<typeof EnvSchema>;

export function readEnv(): Env {
  loadDotEnv();
  return EnvSchema.parse(process.env);
}

/**
 * Parâmetros de um experimento. Ficam congelados em experiments.config_json
 * no momento da criação: mudar a configuração global não altera um experimento em andamento.
 */
export const ExperimentConfigSchema = z.object({
  horizonSessions: z.number().int().min(1),
  initialCapital: z.string().default("10000"),
  decisionTimeNY: z.string().regex(/^\d{2}:\d{2}$/).default("10:00"),
  /** Tolerância: se o programa estava desligado além disso, a rodada é marcada como perdida. */
  decisionGraceMinutes: z.number().int().min(1).default(45),
  maxPositions: z.number().int().min(1).default(5),
  maxPositionPct: z.string().default("0.20"),
  minStrength: z.number().int().min(1).max(3).default(1),
  minNotional: z.string().default("50"),
  allowFractional: z.boolean().default(true),
  quantityDecimals: z.number().int().min(0).max(6).default(4),
  costs: z
    .object({
      commissionPerOrder: z.string().default("0"),
      commissionPerShare: z.string().default("0"),
      halfSpreadBps: z.string().default("2"),
      slippageBps: z.string().default("3"),
    })
    .default({ commissionPerOrder: "0", commissionPerShare: "0", halfSpreadBps: "2", slippageBps: "3" }),
  jevModel: z.string(),
  jevPromptVersion: z.string(),
  analystModel: z.string(),
  analystPromptVersion: z.string(),
  universe: z.array(z.string()).min(1),
  benchmark: z.string().default("SPY"),
});
export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;

export const DEFAULT_UNIVERSE: { ticker: string; name: string; aliases: string[]; cik?: string }[] = [
  { ticker: "NVDA", name: "NVIDIA Corporation", aliases: ["Nvidia", "NVIDIA"], cik: "0001045810" },
  { ticker: "AAPL", name: "Apple Inc.", aliases: ["Apple", "iPhone"], cik: "0000320193" },
  { ticker: "MSFT", name: "Microsoft Corporation", aliases: ["Microsoft", "Azure"], cik: "0000789019" },
  { ticker: "AMZN", name: "Amazon.com Inc.", aliases: ["Amazon", "AWS"], cik: "0001018724" },
  { ticker: "GOOGL", name: "Alphabet Inc.", aliases: ["Alphabet", "Google", "YouTube"], cik: "0001652044" },
  { ticker: "META", name: "Meta Platforms Inc.", aliases: ["Meta", "Facebook", "Instagram", "WhatsApp"], cik: "0001326801" },
  { ticker: "TSLA", name: "Tesla Inc.", aliases: ["Tesla", "Musk"], cik: "0001318605" },
  { ticker: "AMD", name: "Advanced Micro Devices", aliases: ["AMD"], cik: "0000002488" },
  { ticker: "AVGO", name: "Broadcom Inc.", aliases: ["Broadcom"], cik: "0001730168" },
  { ticker: "JPM", name: "JPMorgan Chase & Co.", aliases: ["JPMorgan", "JP Morgan", "Chase"], cik: "0000019617" },
  { ticker: "XOM", name: "Exxon Mobil Corporation", aliases: ["Exxon", "ExxonMobil"], cik: "0000034088" },
  { ticker: "LLY", name: "Eli Lilly and Company", aliases: ["Eli Lilly", "Lilly"], cik: "0000059478" },
  { ticker: "UNH", name: "UnitedHealth Group", aliases: ["UnitedHealth", "Optum"], cik: "0000731766" },
  { ticker: "WMT", name: "Walmart Inc.", aliases: ["Walmart"], cik: "0000104169" },
  { ticker: "NFLX", name: "Netflix Inc.", aliases: ["Netflix"], cik: "0001065280" },
];

export const BENCHMARK = { ticker: "SPY", name: "SPDR S&P 500 ETF Trust", aliases: ["S&P 500"] };
