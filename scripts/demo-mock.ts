/**
 * Demonstração com DADOS SIMULADOS: roda o agendador com relógio acelerado por duas semanas
 * e grava em data/demo.db. Depois: `DATA_MODE=mock DB_PATH=data/demo.db npm run dev`.
 * Serve para ver o fluxo e a contabilidade funcionando — NÃO avalia a estratégia.
 */
import { rmSync } from "node:fs";
import { buildContext } from "../server/bootstrap.js";
import { DB } from "../server/db/db.js";
import { ManualClock } from "../server/lib/clock.js";
import { readEnv } from "../server/config.js";
import { listExperiments } from "../server/sim/engine.js";
import { experimentMetrics } from "../server/eval/metrics.js";
import { runClock } from "./simulate.js";

const path = process.argv[2] ?? "data/demo.db";
for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
const start = new Date(process.argv[3] ?? "2026-09-13T12:00:00Z");
const end = new Date(process.argv[4] ?? "2026-09-26T00:00:00Z");
const clock = new ManualClock(start);
const env = { ...readEnv(), DATA_MODE: "mock" as const, DB_PATH: path };
const { ctx } = buildContext({ env, db: new DB(path), clock });
ctx.log = () => {};
console.log(`Simulando de ${start.toISOString()} a ${end.toISOString()} (dados sintéticos)…`);
await runClock(ctx, clock, end, 10);
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(2)}%`);
for (const e of listExperiments(ctx.db)) {
  const m = experimentMetrics(ctx.db, e.id);
  console.log(`\n${e.name}`);
  console.log(`  patrimônio: US$ ${m.equity.last.toFixed(2)} (${pct(m.equity.netReturn)})`);
  console.log(`  operações encerradas: ${m.trades.closed}, abertas: ${m.trades.open}, custos simulados: US$ ${m.trades.totalSimulatedCosts}`);
  console.log(`  acerto altas: ${pct(m.predictions.up.hitRate)} (n=${m.predictions.up.n}), quedas: ${pct(m.predictions.down.hitRate)} (n=${m.predictions.down.n}), abstenção: ${pct(m.predictions.abstentionShare)}`);
  console.log(`  referências: pesos iguais ${pct(m.benchmarks.equalWeight.return)}, SPY ${pct(m.benchmarks.benchmark.return)}, caixa 0%`);
}
console.log(`\nBanco gravado em ${path}. Para abrir a dashboard: DATA_MODE=mock DB_PATH=${path} npm run dev`);
