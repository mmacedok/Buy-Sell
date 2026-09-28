import type { DB } from "../db/db.js";
import { iso } from "../db/db.js";
import { D, Decimal, ZERO, s } from "../lib/money.js";

export class BudgetExceeded extends Error {}

export interface BudgetLimits {
  dailyUsd: number;
  monthlyUsd: number;
}

/** Limite diário e mensal (UTC) de gastos reais com IA. Verificado antes de cada chamada. */
export class AiBudget {
  constructor(private db: DB, private limits: BudgetLimits) {}

  spent(from: Date, to: Date): Decimal {
    return this.db
      .all<{ cost_usd: string }>("SELECT cost_usd FROM api_costs WHERE ts >= ? AND ts < ?", iso(from), iso(to))
      .reduce((a, r) => a.plus(r.cost_usd), ZERO);
  }

  status(now: Date) {
    const day0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const month0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const far = new Date(now.getTime() + 86400_000);
    return {
      day: this.spent(day0, far),
      month: this.spent(month0, far),
      dailyLimit: D(this.limits.dailyUsd),
      monthlyLimit: D(this.limits.monthlyUsd),
    };
  }

  assertCanSpend(now: Date, estimateUsd: number) {
    const st = this.status(now);
    if (st.day.plus(estimateUsd).gt(st.dailyLimit)) throw new BudgetExceeded(`Orçamento diário de IA atingido (US$ ${st.day.toFixed(4)})`);
    if (st.month.plus(estimateUsd).gt(st.monthlyLimit)) throw new BudgetExceeded(`Orçamento mensal de IA atingido (US$ ${st.month.toFixed(4)})`);
  }

  record(now: Date, entry: { provider: string; model: string; purpose: string; ref?: string; costUsd: Decimal.Value; tokensIn?: number; tokensOut?: number }) {
    this.db.run(
      "INSERT INTO api_costs(ts, provider, model, purpose, ref, cost_usd, tokens_in, tokens_out) VALUES(?,?,?,?,?,?,?,?)",
      iso(now), entry.provider, entry.model, entry.purpose, entry.ref ?? null, s(entry.costUsd), entry.tokensIn ?? null, entry.tokensOut ?? null,
    );
  }
}
