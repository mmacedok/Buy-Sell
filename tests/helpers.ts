import { DB } from "../server/db/db.js";
import { ExperimentConfigSchema, type ExperimentConfig } from "../server/config.js";
import { createExperiment } from "../server/sim/engine.js";
import { saveBars } from "../server/sim/prices.js";
import { nyTime, sessionClose, sessionOpen } from "../server/lib/calendar.js";

export function memDb() {
  return new DB(":memory:");
}

export function cfg(over: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return ExperimentConfigSchema.parse({
    horizonSessions: 1,
    jevModel: "test/jev",
    jevPromptVersion: "jev-v1",
    analystModel: "test/analyst",
    analystPromptVersion: "analyst-v1",
    universe: ["AAA", "BBB", "CCC"],
    ...over,
  });
}

export function newExp(db: DB, over: Partial<ExperimentConfig> = {}, name = "A") {
  return createExperiment(db, name, cfg(over), "2026-09-28", new Date("2026-09-28T12:00:00Z"));
}

/** Barras de 1 minuto num pregão, com preço dado por f(índice do minuto). */
export function minuteBars(
  db: DB,
  ticker: string,
  date: string,
  price: (i: number) => number,
  opts: { fromHHMM?: string; toHHMM?: string; fetchedAt?: Date; skip?: (i: number) => boolean } = {},
) {
  const start = opts.fromHHMM ? nyTime(date, opts.fromHHMM) : sessionOpen(date);
  const end = opts.toHHMM ? nyTime(date, opts.toHHMM) : sessionClose(date);
  const bars = [];
  for (let t = start.getTime(), i = 0; t < end.getTime(); t += 60_000, i++) {
    if (opts.skip?.(i)) continue;
    const p = price(i);
    bars.push({ ts: new Date(t), open: p, high: p, low: p, close: p, volume: 1000 });
  }
  saveBars(
    db,
    { ticker, timeframe: "1Min", adjusted: false, feed: "iex", fetchedAt: opts.fetchedAt ?? end, from: start, until: end },
    bars,
  );
}
