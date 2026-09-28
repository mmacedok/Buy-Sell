import type { DB } from "./db/db.js";
import type { Clock } from "./lib/clock.js";
import type { NewsSource, PriceSource } from "./sources/types.js";
import type { JevClient } from "./ai/jev.js";
import type { AnalystClient } from "./ai/analyst.js";
import type { AiBudget } from "./ai/budget.js";

/** Dependências do backend reunidas (facilita testes com fontes e relógio falsos). */
export interface Ctx {
  db: DB;
  clock: Clock;
  mode: "live" | "mock";
  news: NewsSource[];
  prices: PriceSource | null;
  jev: (model: string) => JevClient | null;
  analyst: (model: string) => AnalystClient | null;
  budget: AiBudget;
  /** Estimativas conservadoras de custo por chamada, usadas no teto de orçamento. */
  costEstimates: { jev: number; analyst: number };
  log: (msg: string, extra?: unknown) => void;
}
