import { useApi } from "../api";
import { EquityChart } from "../components/Charts";
import { date, money, num, pct } from "../fmt";

export function Experiments() {
  const { data, error } = useApi("/experiments", 120_000);
  if (error) return <p className="neg">{error}</p>;
  if (!data) return <p className="muted">Carregando…</p>;
  const exps = data.experiments;
  const row = (label: string, f: (m: any) => string, hint?: string) => (
    <tr>
      <td>{label}{hint && <div className="small muted">{hint}</div>}</td>
      {exps.map((m: any) => <td key={m.experiment.id} className="n">{f(m)}</td>)}
    </tr>
  );
  return (
    <>
      <section className="card">
        <h2>Comparação entre prazos</h2>
        <div className="scroll">
          <table>
            <thead><tr><th>Métrica</th>{exps.map((m: any) => <th key={m.experiment.id} className="n">{m.experiment.name}</th>)}</tr></thead>
            <tbody>
              {row("Início", (m) => date(m.experiment.startedOn))}
              {row("Retorno líquido", (m) => pct(m.equity.netReturn))}
              {row("Pesos iguais (mesmas ações)", (m) => pct(m.benchmarks.equalWeight.return))}
              {row("SPY", (m) => pct(m.benchmarks.benchmark.return))}
              {row("Caixa", () => pct(0))}
              {row("Semanas positivas", (m) => (m.weeks.positiveShare === null ? "—" : `${Math.round(m.weeks.positiveShare * 100)}% de ${m.weeks.count}`))}
              {row("Pior semana", (m) => pct(m.weeks.worst))}
              {row("Maior queda acumulada", (m) => pct(-m.maxDrawdown))}
              {row("Operações encerradas / abertas", (m) => `${m.trades.closed} / ${m.trades.open}`)}
              {row("Operações com lucro", (m) => (m.trades.winRate === null ? "—" : `${Math.round(m.trades.winRate * 100)}%`))}
              {row("Ganho médio / perda média", (m) => `${money(m.trades.avgWin)} / ${money(m.trades.avgLoss)}`)}
              {row("Custos simulados", (m) => money(m.trades.totalSimulatedCosts))}
              {row("Capital investido (média)", (m) => (m.exposure.avgInvestedFraction === null ? "—" : `${Math.round(m.exposure.avgInvestedFraction * 100)}%`))}
              {row("Pregões com posição", (m) => `${m.exposure.sessionsWithPositions} de ${m.exposure.sessions}`)}
              {row("Previsões (com direção)", (m) => `${m.predictions.total} (${m.predictions.withDirection})`)}
              {row("Abstenção", (m) => pct(m.predictions.abstentionShare, 0).replace("+", ""), "ações sem previsão por falta de sinal ou dados")}
              {row("Acerto em altas", (m) => (m.predictions.up.hitRate === null ? "—" : `${Math.round(m.predictions.up.hitRate * 100)}% (n=${m.predictions.up.n})`))}
              {row("Acerto em quedas", (m) => (m.predictions.down.hitRate === null ? "—" : `${Math.round(m.predictions.down.hitRate * 100)}% (n=${m.predictions.down.n})`))}
              {row("Rodadas", (m) => Object.entries(m.decisions.rounds).map(([k, v]) => `${k === "done" ? "concluídas" : k === "missed" ? "perdidas" : k}: ${v}`).join(", ") || "—")}
            </tbody>
          </table>
        </div>
        {exps.map((m: any) => m.sampleWarning && <p key={m.experiment.id} className="small muted">{m.experiment.name}: {m.sampleWarning}</p>)}
      </section>

      <section className="card" style={{ marginTop: 12 }}>
        <h2>Sensibilidade a custos (operações encerradas)</h2>
        <p className="small muted">Resultado das mesmas operações recalculado com 0×, 1×, 2× e 3× os custos simulados. Um lucro que some com 2× custos é frágil.</p>
        <table>
          <thead><tr><th>Custos</th>{exps.map((m: any) => <th key={m.experiment.id} className="n">{m.experiment.name}</th>)}</tr></thead>
          <tbody>
            {[0, 1, 2, 3].map((i) => (
              <tr key={i}><td>{i}×</td>{exps.map((m: any) => <td key={m.experiment.id} className="n">{money(m.trades.costSensitivity[i].closedTradesPnl)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid" style={{ marginTop: 12 }}>
        {exps.map((m: any) => (
          <section className="card" key={m.experiment.id}>
            <h2>{m.experiment.name}</h2>
            <EquityChart series={m.series} initial={m.equity.initial} />
            <h3>Semanas</h3>
            <table>
              <thead><tr><th>Semana</th><th className="n">Retorno</th><th className="n">Patrimônio</th></tr></thead>
              <tbody>{m.weeks.list.map((w: any) => <tr key={w.week}><td>{date(w.week)}</td><td className="n">{pct(w.ret)}</td><td className="n">{money(w.end)}</td></tr>)}</tbody>
            </table>
            <h3>Regras fixadas</h3>
            <table className="small">
              <tbody>
                <tr><td>Prazo</td><td>{m.experiment.config.horizonSessions} pregão(ões), decisão às {m.experiment.config.decisionTimeNY} (NY)</td></tr>
                <tr><td>Capital</td><td>{money(m.experiment.config.initialCapital)}</td></tr>
                <tr><td>Posições</td><td>até {m.experiment.config.maxPositions}, até {num(Number(m.experiment.config.maxPositionPct) * 100, 0)}% cada, força mínima {m.experiment.config.minStrength}</td></tr>
                <tr><td>Custos</td><td>comissão {money(m.experiment.config.costs.commissionPerOrder)}/ordem + {money(m.experiment.config.costs.commissionPerShare)}/ação, meio spread {m.experiment.config.costs.halfSpreadBps} bps, slippage {m.experiment.config.costs.slippageBps} bps</td></tr>
                <tr><td>Modelos</td><td>JEV {m.experiment.config.jevModel} ({m.experiment.config.jevPromptVersion}); analista {m.experiment.config.analystModel} ({m.experiment.config.analystPromptVersion})</td></tr>
                <tr><td>Universo</td><td>{m.experiment.config.universe.join(", ")}</td></tr>
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </>
  );
}
