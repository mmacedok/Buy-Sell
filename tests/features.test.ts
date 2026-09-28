import { describe, expect, it } from "vitest";
import { memDb, minuteBars } from "./helpers.js";
import { priceFeatures } from "../server/analysis/features.js";
import { lastPriceAt, saveBars } from "../server/sim/prices.js";
import { nyTime, sessionClose, tradingDaysBetween } from "../server/lib/calendar.js";
import { DateTime } from "luxon";
import { maxDrawdown, weeklyReturns } from "../server/eval/metrics.js";
import { parseCsv } from "../server/sources/csv.js";

describe("dados disponíveis no momento (sem olhar o futuro)", () => {
  it("último preço ignora barras ainda não terminadas ou buscadas depois", () => {
    const db = memDb();
    minuteBars(db, "AAA", "2026-09-28", (i) => 100 + i, { toHHMM: "10:03", fetchedAt: nyTime("2026-09-28", "10:03") });
    minuteBars(db, "AAA", "2026-09-28", (i) => 200 + i, { fromHHMM: "10:03", toHHMM: "10:10", fetchedAt: nyTime("2026-09-28", "10:10") });
    // Às 10:03 a barra das 10:02 acabou de terminar e já tinha sido buscada.
    expect(lastPriceAt(db, "AAA", nyTime("2026-09-28", "10:03"))!.ts).toBe(nyTime("2026-09-28", "10:02").toISOString());
    // Às 10:08 as barras seguintes existem no banco, mas só foram buscadas às 10:10: não contam.
    expect(lastPriceAt(db, "AAA", nyTime("2026-09-28", "10:08"))!.ts).toBe(nyTime("2026-09-28", "10:02").toISOString());
    expect(lastPriceAt(db, "AAA", nyTime("2026-09-28", "10:10"))!.ts).toBe(nyTime("2026-09-28", "10:09").toISOString());
    // Antes de qualquer coleta, nada.
    expect(lastPriceAt(db, "AAA", nyTime("2026-09-28", "10:02"))).toBeUndefined();
  });

  it("indicadores só usam fechamentos anteriores ao corte", () => {
    const db = memDb();
    const days = tradingDaysBetween("2026-08-01", "2026-09-29");
    const bars = days.map((d, i) => ({ ts: DateTime.fromISO(d, { zone: "America/New_York" }).toJSDate(), open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1000 }));
    for (const adjusted of [true, false]) {
      saveBars(db, { ticker: "AAA", timeframe: "1Day", adjusted, feed: "t", fetchedAt: sessionClose("2026-09-29"), from: new Date("2026-08-01"), until: sessionClose("2026-09-29") }, bars);
    }
    // fetched_at depois do corte → nada disponível
    expect(priceFeatures(db, "AAA", nyTime("2026-09-28", "10:00")).features.sessions_of_history).toBe(0);
  });
});

describe("métricas", () => {
  it("maior queda acumulada", () => {
    expect(maxDrawdown([100, 120, 90, 130, 117])).toBeCloseTo(0.25);
  });
  it("retornos semanais encadeados", () => {
    const w = weeklyReturns([{ date: "2026-09-28", value: 101 }, { date: "2026-10-02", value: 102 }, { date: "2026-10-05", value: 99.96 }], 100);
    expect(w.map((x) => x.week)).toEqual(["2026-09-28", "2026-10-05"]);
    expect(w[0].ret).toBeCloseTo(0.02);
    expect(w[1].ret).toBeCloseTo(-0.02);
  });
});

describe("CSV", () => {
  it("lê aspas, vírgulas e quebras", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\r\n1,2\n')).toEqual([{ a: "x, y", b: 'he said "hi"' }, { a: "1", b: "2" }]);
  });
});
