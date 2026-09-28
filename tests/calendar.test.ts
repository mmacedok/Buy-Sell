import { describe, expect, it } from "vitest";
import { addSessions, isTradingDay, nyTime, sessionClose, tradingDaysBetween, isMarketOpen } from "../server/lib/calendar.js";

describe("calendário da bolsa", () => {
  it("reconhece fins de semana e feriados", () => {
    expect(isTradingDay("2026-09-26")).toBe(false); // sábado
    expect(isTradingDay("2026-09-07")).toBe(false); // Labor Day
    expect(isTradingDay("2026-11-26")).toBe(false); // Thanksgiving
    expect(isTradingDay("2026-09-28")).toBe(true);
  });

  it("5 pregões a partir de quarta terminam na quarta seguinte", () => {
    expect(addSessions("2026-09-30", 5)).toBe("2026-10-07");
  });

  it("pula feriados ao somar pregões", () => {
    expect(addSessions("2026-11-25", 1)).toBe("2026-11-27");
    expect(addSessions("2026-09-04", 1)).toBe("2026-09-08");
  });

  it("converte horário de Nova York para UTC com horário de verão", () => {
    expect(nyTime("2026-09-28", "10:00").toISOString()).toBe("2026-09-28T14:00:00.000Z");
    expect(nyTime("2026-12-01", "10:00").toISOString()).toBe("2026-12-01T15:00:00.000Z");
  });

  it("pregão encurtado fecha às 13h", () => {
    expect(sessionClose("2026-11-27").toISOString()).toBe("2026-11-27T18:00:00.000Z");
    expect(isMarketOpen(new Date("2026-11-27T18:30:00Z"))).toBe(false);
  });

  it("lista pregões num intervalo", () => {
    expect(tradingDaysBetween("2026-09-25", "2026-09-30")).toEqual(["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30"]);
  });

  it("recusa ano sem calendário cadastrado", () => {
    expect(() => isTradingDay("2031-01-02")).toThrow();
  });
});
