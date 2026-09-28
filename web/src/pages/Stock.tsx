import { useApi } from "../api";
import { PriceChart } from "../components/Charts";
import { cls, date, dt, DIR, money, num, pct, st } from "../fmt";
import { go, openPrediction } from "../App";

export function Stock({ ticker }: { ticker: string }) {
  const { data, error } = useApi(`/stocks/${ticker}`, 120_000);
  const { data: settings } = useApi("/settings", 0);
  return (
    <>
      <div className="row">
        <select value={ticker} onChange={(e) => go("stock", e.target.value)}>
          {settings?.companies.map((c: any) => <option key={c.ticker} value={c.ticker}>{c.ticker} — {c.name}</option>)}
        </select>
      </div>
      {error && <p className="neg">{error}</p>}
      {!data ? <p className="muted">Carregando…</p> : (
        <>
          <section className="card">
            <h2>{data.company.ticker} — {data.company.name} · fechamento ajustado</h2>
            <PriceChart
              bars={data.bars}
              markers={data.events.filter((e: any) => e.status === "ok").map((e: any) => ({ date: e.first_published_at.slice(0, 10), label: `#${e.id} ${e.title}` }))}
            />
            <p className="small muted">Linhas tracejadas: dias com eventos válidos. Datas em UTC.</p>
          </section>
          <section className="card" style={{ marginTop: 12 }}>
            <h2>Previsões</h2>
            <div className="scroll">
              <table>
                <thead><tr><th>Feita em</th><th className="n">Prazo</th><th>Direção</th><th className="n">Força</th><th>Explicação</th><th>Resultado</th><th></th></tr></thead>
                <tbody>
                  {data.predictions.map((p: any) => (
                    <tr key={p.id}>
                      <td className="small">{dt(p.made_at)}</td>
                      <td className="n">{p.horizon} preg.</td>
                      <td>{p.direction ? <span className={`tag ${p.direction === "up" ? "bull" : "bear"}`}>{DIR[p.direction]}</span> : <span className="muted small">sem previsão</span>}</td>
                      <td className="n">{p.strength}</td>
                      <td className="small">{p.explanation}</td>
                      <td className="small">
                        {p.eval_status === "evaluated" ? (
                          <>
                            <span className={cls(Number(p.eval_return))}>{pct(Number(p.eval_return))}</span>{" "}
                            {p.eval_correct === 1 ? "✓ acertou" : p.eval_correct === 0 ? "✗ errou" : ""}
                            {p.eval_benchmark_return !== null && <div className="muted">SPY {pct(Number(p.eval_benchmark_return))}</div>}
                          </>
                        ) : <span className="muted">{p.eval_status === "pending" ? "aguardando avaliação" : st(p.eval_status)}</span>}
                      </td>
                      <td><button onClick={() => openPrediction(p.id)}>Registro</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="grid" style={{ marginTop: 12 }}>
            <section className="card">
              <h2>Eventos recentes</h2>
              <table>
                <tbody>
                  {data.events.slice(0, 30).map((e: any) => (
                    <tr key={e.id}>
                      <td className="small">{dt(e.first_published_at)}</td>
                      <td>{e.title} <span className="muted small">#{e.id} · {e.article_count} fonte(s) · {st(e.status)}</span></td>
                      <td>{e.jev_label ? <span className={`tag ${e.jev_label === "bullish" ? "bull" : "bear"}`}>{e.jev_label} {num(e.jev_confidence, 2)}</span> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card">
              <h2>Operações fictícias nesta ação</h2>
              <table>
                <thead><tr><th>Experimento</th><th>Entrada</th><th>Saída</th><th className="n">Resultado</th></tr></thead>
                <tbody>
                  {data.trades.map((t: any) => (
                    <tr key={t.id}>
                      <td className="small">{t.experiment}</td>
                      <td className="small">{dt(t.opened_at)}</td>
                      <td className="small">{t.status === "closed" ? dt(t.closed_at) : `prevista ${date(t.planned_exit_session)}`}</td>
                      <td className={`n ${cls(Number(t.realized_pnl))}`}>{t.realized_pnl ? money(t.realized_pnl) : "aberta"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </>
  );
}
