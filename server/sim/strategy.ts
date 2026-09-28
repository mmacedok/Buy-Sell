import { D, Decimal, cents } from "../lib/money.js";
import type { ExperimentConfig } from "../config.js";

export interface Candidate {
  ticker: string;
  predictionId: number | null;
  direction: "up" | "down" | null;
  strength: number;
  sufficientData: boolean;
  /** Maior confiança do JEV entre os eventos novos e bullish que sustentam a previsão (null se nenhum). */
  bestNewBullishConfidence: number | null;
  hasPrice: boolean;
  analysisStatus: string;
}

export interface Selection {
  ticker: string;
  action: "buy" | "no_trade";
  reason: string;
  rank: number | null;
  notional: Decimal | null;
  predictionId: number | null;
}

/**
 * Regras fixas da estratégia inicial (pura, sem efeitos colaterais — testável).
 *  - Compra: previsão de alta, força ≥ mínimo, dados suficientes, evento novo bullish e preço válido.
 *  - Ranking: força ↓, confiança do JEV ↓, ticker ↑ (desempate determinístico).
 *  - Alocação igual, limitada por caixa disponível e % máximo do patrimônio.
 *  - Não compra de novo uma ação com posição aberta ou ordem pendente.
 */
export function selectTrades(
  candidates: Candidate[],
  state: { equity: Decimal; availableCash: Decimal; heldOrPending: Set<string>; openSlots: number },
  cfg: ExperimentConfig,
): Selection[] {
  const out: Selection[] = [];
  const eligible: Candidate[] = [];
  for (const c of candidates) {
    const no = (reason: string) => out.push({ ticker: c.ticker, action: "no_trade", reason, rank: null, notional: null, predictionId: c.predictionId });
    if (c.analysisStatus === "error" || c.analysisStatus === "budget") no(`análise indisponível (${c.analysisStatus})`);
    else if (c.analysisStatus === "no_events") no("sem eventos novos");
    else if (!c.sufficientData || c.direction === null) no("dados insuficientes para previsão");
    else if (c.direction === "down") no("previsão de queda (sem venda a descoberto nesta versão)");
    else if (c.strength < cfg.minStrength) no(`sinal fraco (força ${c.strength} < ${cfg.minStrength})`);
    else if (c.bestNewBullishConfidence === null) no("nenhum evento novo bullish sustenta a previsão");
    else if (!c.hasPrice) no("sem preço válido");
    else if (state.heldOrPending.has(c.ticker)) no("posição aberta ou ordem pendente nesta ação");
    else eligible.push(c);
  }
  eligible.sort(
    (a, b) =>
      b.strength - a.strength ||
      (b.bestNewBullishConfidence ?? 0) - (a.bestNewBullishConfidence ?? 0) ||
      a.ticker.localeCompare(b.ticker),
  );
  const take = Math.max(0, Math.min(state.openSlots, eligible.length));
  const cap = state.equity.times(cfg.maxPositionPct);
  const perPosition = take > 0 ? cents(Decimal.min(cap, state.availableCash.div(take))) : D(0);
  eligible.forEach((c, i) => {
    if (i >= take) {
      out.push({ ticker: c.ticker, action: "no_trade", reason: `fora do limite de posições (posição ${i + 1} no ranking)`, rank: i + 1, notional: null, predictionId: c.predictionId });
    } else if (perPosition.lt(cfg.minNotional)) {
      out.push({ ticker: c.ticker, action: "no_trade", reason: `caixa insuficiente (US$ ${perPosition.toFixed(2)} por posição)`, rank: i + 1, notional: null, predictionId: c.predictionId });
    } else {
      out.push({ ticker: c.ticker, action: "buy", reason: `previsão de alta, força ${c.strength}`, rank: i + 1, notional: perPosition, predictionId: c.predictionId });
    }
  });
  return out;
}
