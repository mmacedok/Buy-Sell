import type { DB, Row } from "../db/db.js";
import { iso } from "../db/db.js";
import { DateTime } from "luxon";
import { TZ, addSessions, nyTime } from "../lib/calendar.js";
import { D } from "../lib/money.js";
import { executionBar } from "../sim/prices.js";

/**
 * Avalia previsões cujo prazo terminou. Mesma regra de preço do simulador:
 * início = primeira barra após a previsão; fim = primeira barra após o mesmo horário, N pregões depois.
 * A previsão original nunca é alterada; só as colunas eval_* são preenchidas.
 */
export function evaluatePredictions(db: DB, now: Date, benchmark = "SPY") {
  const pending = db.all<Row>("SELECT * FROM predictions WHERE eval_status = 'pending' ORDER BY id");
  let evaluated = 0;
  for (const p of pending) {
    const start = new Date(p.made_at);
    const hhmm = DateTime.fromJSDate(start, { zone: TZ }).toFormat("HH:mm");
    const end = nyTime(addSessions(p.session_date, p.horizon), hhmm);
    if (now < end) continue;
    const a = executionBar(db, p.ticker, start), b = executionBar(db, p.ticker, end);
    const ma = executionBar(db, benchmark, start), mb = executionBar(db, benchmark, end);
    if (!("bar" in a) || !("bar" in b)) {
      // Sem dados depois de 3 dias: marca como indisponível em vez de inventar.
      if (now.getTime() - end.getTime() > 3 * 86400_000) {
        db.run("UPDATE predictions SET eval_status = 'unavailable', evaluated_at = ? WHERE id = ?", iso(now), p.id);
      }
      continue;
    }
    const ret = D(b.bar.open).div(a.bar.open).minus(1);
    const bret = "bar" in ma && "bar" in mb ? D(mb.bar.open).div(ma.bar.open).minus(1) : null;
    const correct = p.direction === null || ret.isZero() ? null : (p.direction === "up") === ret.gt(0) ? 1 : 0;
    db.run(
      `UPDATE predictions SET eval_status = 'evaluated', eval_start_at = ?, eval_end_at = ?, eval_start_price = ?, eval_end_price = ?,
         eval_return = ?, eval_benchmark_return = ?, eval_correct = ?, evaluated_at = ? WHERE id = ?`,
      a.bar.ts, b.bar.ts, a.bar.open, b.bar.open, ret.toDecimalPlaces(8).toFixed(), bret?.toDecimalPlaces(8).toFixed() ?? null,
      correct, iso(now), p.id,
    );
    evaluated++;
  }
  return { evaluated };
}
