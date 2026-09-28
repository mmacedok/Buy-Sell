import Decimal from "decimal.js";

// Todos os valores financeiros passam por Decimal e são gravados como TEXT no SQLite.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };
export type Num = Decimal.Value;

export const D = (v: Num): Decimal => new Decimal(v);
export const ZERO = new Decimal(0);

/** Arredonda para centavos (usado em caixa e custos). */
export const cents = (v: Num): Decimal => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

/** Arredonda para baixo — usado em quantidades, para nunca gastar mais do que o reservado. */
export const floorTo = (v: Num, dp: number): Decimal => D(v).toDecimalPlaces(dp, Decimal.ROUND_DOWN);

/** Converte para string canônica para persistência. */
export const s = (v: Num): string => D(v).toFixed();

export const bps = (v: Num): Decimal => D(v).div(10_000);
