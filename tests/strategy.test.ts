import { describe, expect, it } from "vitest";
import { selectTrades, type Candidate } from "../server/sim/strategy.js";
import { cfg } from "./helpers.js";
import { D } from "../server/lib/money.js";

const c = (ticker: string, over: Partial<Candidate> = {}): Candidate => ({
  ticker, predictionId: 1, direction: "up", strength: 2, sufficientData: true, bestNewBullishConfidence: 0.8, hasPrice: true, analysisStatus: "ok", ...over,
});
const state = (over = {}) => ({ equity: D(10000), availableCash: D(10000), heldOrPending: new Set<string>(), openSlots: 5, ...over });

describe("regras de compra", () => {
  it("só compra previsão de alta com evento novo bullish, dados e preço", () => {
    const sel = selectTrades([
      c("A"), c("B", { direction: "down" }), c("C", { sufficientData: false, direction: null }), c("D", { strength: 0 }),
      c("E", { bestNewBullishConfidence: null }), c("F", { hasPrice: false }), c("G", { analysisStatus: "no_events", direction: null }),
    ], state(), cfg());
    expect(sel.filter((s) => s.action === "buy").map((s) => s.ticker)).toEqual(["A"]);
    expect(sel.find((s) => s.ticker === "B")!.reason).toMatch(/queda/);
  });

  it("ranking determinístico e limite de posições", () => {
    const sel = selectTrades([c("Z", { strength: 3 }), c("B", { strength: 2, bestNewBullishConfidence: 0.9 }), c("A", { strength: 2, bestNewBullishConfidence: 0.9 }), c("C", { strength: 1 })], state({ openSlots: 2 }), cfg());
    expect(sel.filter((s) => s.action === "buy").map((s) => s.ticker)).toEqual(["Z", "A"]);
    expect(sel.find((s) => s.ticker === "B")!.reason).toMatch(/limite/);
  });

  it("aloca valores iguais, limitado a 20% do patrimônio e ao caixa", () => {
    const one = selectTrades([c("A")], state(), cfg());
    expect(one[0].notional!.toString()).toBe("2000");
    const tight = selectTrades([c("A"), c("B")], state({ availableCash: D(1000) }), cfg());
    expect(tight.map((s) => s.notional?.toString())).toEqual(["500", "500"]);
  });

  it("não repete compra de ação com posição aberta", () => {
    const sel = selectTrades([c("A")], state({ heldOrPending: new Set(["A"]) }), cfg());
    expect(sel[0].action).toBe("no_trade");
  });

  it("sem sinal elegível, dinheiro fica em caixa", () => {
    const sel = selectTrades([c("A", { direction: null, sufficientData: false })], state(), cfg());
    expect(sel.every((s) => s.action === "no_trade")).toBe(true);
  });
});
