import type { AnalysisPackage, AnalystClient } from "./analyst.js";
import { sanitizeAnalystOutput } from "./analyst.js";
import type { JevClient, JevInput } from "./jev.js";

/** IA SINTÉTICA para o modo mock: regras por palavras-chave. Não reflete a qualidade de modelos reais. */
const POS = /\b(beats?|raises?|record|upgrades?|agreement|wins?|approval|surges?)\b/i;
const NEG = /\b(cuts?|investigation|lawsuit|misses?|downgrades?|recall|probe|weaker)\b/i;

export class MockJev implements JevClient {
  model = "mock/jev";
  async classify(input: JevInput) {
    const text = `${input.title} ${input.summary ?? ""}`;
    const pos = POS.test(text), neg = NEG.test(text);
    const pb = pos && !neg ? 0.85 : neg && !pos ? 0.15 : 0.5 + ((text.length % 10) - 5) / 100;
    return {
      label: pb >= 0.5 ? ("bullish" as const) : ("bearish" as const),
      probBullish: pb,
      probBearish: 1 - pb,
      confidence: Math.max(pb, 1 - pb),
      raw: { mock: true },
      costUsd: 0,
    };
  }
}

export class MockAnalyst implements AnalystClient {
  model = "mock/analyst";
  async analyse(pkg: AnalysisPackage, horizons: number[]) {
    const fresh = pkg.events.filter((e) => e.is_new_since_last_round && e.classifier);
    const score = fresh.reduce((a, e) => a + (e.classifier!.label === "bullish" ? 1 : -1) * ((e.classifier!.confidence ?? 0.5) - 0.5) * 2, 0);
    const output = {
      predictions: horizons.map((h) => ({
        horizon: h,
        direction: fresh.length ? (score >= 0 ? ("up" as const) : ("down" as const)) : null,
        strength: fresh.length ? Math.min(3, Math.round(Math.abs(score) * 2)) : 0,
        sufficient_data: fresh.length > 0,
        supporting_event_ids: fresh.map((e) => e.event_id),
        counter_evidence: [],
        limitations: ["análise sintética (modo mock)"],
        explanation: fresh.length ? `Mock: saldo de eventos novos ${score.toFixed(2)} ${fresh.map((e) => `[#${e.event_id}]`).join(" ")}` : "Sem eventos novos.",
      })),
    };
    return { output: sanitizeAnalystOutput(output, pkg, horizons), costUsd: 0, raw: { mock: true } };
  }
}
