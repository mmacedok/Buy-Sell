import { useApi } from "../api";
import { cls, date, dt, DIR, money, num, pct, st } from "../fmt";
import { go, openPrediction } from "../App";

export function Portfolio({ expId }: { expId?: number }) {
  const { data: list } = useApi("/overview", 0);
  const id = expId ?? list?.experiments?.[0]?.id;
  const { data, error } = useApi(id ? `/experiments/${id}` : null, 60_000);
  const { data: weekly } = useApi(id ? `/experiments/${id}/weekly` : null, 120_000);
  return (
    <>
      <div className="row">
        {list?.experiments.map((e: any) => (
          <button key={e.id} onClick={() => go("portfolio", e.id)} style={e.id === id ? { fontWeight: 600, borderColor: "var(--s1)" } : {}}>{e.name}</button>
        ))}
      </div>
      {error && <p className="neg">{error}</p>}
      {!data ? <p className="muted">Carregando…</p> : (
        <>
          <div className="grid">
            <section className="card">
              <h2>Caixa</h2>
              <div className="stats">
                <div className="stat"><div className="v">{money(data.cash.balance)}</div><div className="l">Saldo</div></div>
                <div className="stat"><div className="v">{money(data.cash.reserved)}</div><div className="l">Reservado (ordens pendentes)</div></div>
                <div className="stat"><div className="v">{money(data.cash.available)}</div><div className="l">Disponível</div></div>
              </div>
              <h3>Custos simulados</h3>
              <p className="small">Custos simulados das execuções: {money(data.metrics.trades.totalSimulatedCosts)} (comissão + meio spread + slippage). Gastos reais com IA: ver Configurações.</p>
            </section>
            {weekly && (
              <section className="card">
                <h2>Relatório da semana de {date(weekly.week)}</h2>
                <div className="stats">
                  <div className="stat"><div className="v">{money(weekly.equityEnd)}</div><div className="l">Patrimônio</div></div>
                  <div className="stat"><div className={`v ${cls(weekly.weekReturn)}`}>{pct(weekly.weekReturn)}</div><div className="l">Na semana</div></div>
                  <div className="stat"><div className="v">{weekly.closedTrades.length}</div><div className="l">Encerradas</div></div>
                  <div className="stat"><div className="v">{weekly.openPositions.length}</div><div className="l">Abertas</div></div>
                </div>
                <p className="small muted">Posições abertas avaliadas pelo último preço disponível.</p>
              </section>
            )}
          </div>

          <section className="card" style={{ marginTop: 12 }}>
            <h2>Posições</h2>
            <div className="scroll">
              <table>
                <thead><tr><th>Ação</th><th className="n">Qtd.</th><th className="n">Custo</th><th>Entrada</th><th>Saída prevista</th><th>Situação</th><th className="n">Resultado</th></tr></thead>
                <tbody>
                  {data.positions.map((p: any) => {
                    const live = data.openValuation.find((l: any) => l.ticker === p.ticker);
                    return (
                      <tr key={p.id}>
                        <td><a href={`#/stock/${p.ticker}`}>{p.ticker}</a></td>
                        <td className="n">{num(p.quantity, 4)}</td>
                        <td className="n">{money(p.cost_basis)}</td>
                        <td className="small">{dt(p.opened_at)}</td>
                        <td className="small">{date(p.planned_exit_session)} {dt(p.planned_exit_at).split(" ")[1]}</td>
                        <td className="small">{st(p.status)}{p.status === "closed" ? ` ${dt(p.closed_at)}` : ""}</td>
                        <td className={`n ${cls(Number(p.realized_pnl ?? live?.unrealized))}`}>
                          {p.status === "closed" ? money(p.realized_pnl) : live ? <>{money(live.unrealized)} <span className="muted small">(aberto)</span></> : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" style={{ marginTop: 12 }}>
            <h2>Ordens e execuções</h2>
            <div className="scroll">
              <table>
                <thead><tr><th>#</th><th>Ação</th><th>Lado</th><th>Não antes de</th><th>Situação</th><th className="n">Preço ref.</th><th className="n">Preço exec.</th><th className="n">Qtd.</th><th className="n">Valor</th><th className="n">Custos</th><th>Executada</th></tr></thead>
                <tbody>
                  {data.orders.map((o: any) => (
                    <tr key={o.id}>
                      <td className="small muted">{o.id}</td>
                      <td>{o.ticker}</td>
                      <td>{o.side === "buy" ? "compra" : "venda"}</td>
                      <td className="small">{dt(o.not_before)}</td>
                      <td className="small">{st(o.status)}{o.status_reason && o.status !== "filled" ? <div className="muted">{o.status_reason}</div> : null}</td>
                      <td className="n">{o.ref_price ? money(o.ref_price) : "—"}</td>
                      <td className="n">{o.fill_price ? money(o.fill_price) : "—"}</td>
                      <td className="n">{num(o.exec_qty ?? o.quantity, 4)}</td>
                      <td className="n">{o.gross_amount ? money(o.gross_amount) : o.notional_reserved ? <span className="muted">{money(o.notional_reserved)} res.</span> : "—"}</td>
                      <td className="n small">{o.commission !== null && o.commission !== undefined ? money(Number(o.commission) + Number(o.spread_cost) + Number(o.slippage_cost)) : "—"}</td>
                      <td className="small">{dt(o.executed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">Execução aproximada: abertura da primeira barra de 1 minuto após a decisão (feed parcial), ajustada por meio spread e slippage estimados.</p>
          </section>

          <section className="card" style={{ marginTop: 12 }}>
            <h2>Rodadas de decisão</h2>
            {data.rounds.map((r: any) => (
              <details key={r.id}>
                <summary>
                  {date(r.session_date)} — {st(r.status)} {r.summary?.buys !== undefined ? `· ${r.summary.buys} compra(s)` : ""} {r.summary?.reason ? `· ${r.summary.reason}` : ""}
                  {r.decided_at ? <span className="muted small"> · decidida {dt(r.decided_at)}</span> : null}
                </summary>
                <table>
                  <tbody>
                    {r.decisions.map((d: any) => (
                      <tr key={d.id}>
                        <td>{d.ticker}</td>
                        <td>{d.action === "buy" ? <b>compra</b> : <span className="muted">sem operação</span>}</td>
                        <td className="small">{d.reason}</td>
                        <td className="small">{d.direction ? `${DIR[d.direction]} (força ${d.strength})` : ""}</td>
                        <td>{d.prediction_id && <button onClick={() => openPrediction(d.prediction_id)}>Registro</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </section>

          <section className="card" style={{ marginTop: 12 }}>
            <h2>Movimentações de caixa</h2>
            <div className="scroll">
              <table>
                <thead><tr><th>Data</th><th>Tipo</th><th className="n">Valor</th><th>Obs.</th></tr></thead>
                <tbody>
                  {data.ledger.map((l: any) => (
                    <tr key={l.id}><td className="small">{dt(l.ts)}</td><td>{({ deposit: "aporte", buy: "compra", sell: "venda", commission: "comissão", dividend: "dividendo" } as any)[l.kind] ?? l.kind}</td><td className={`n ${cls(Number(l.amount))}`}>{money(l.amount)}</td><td className="small muted">{l.note}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
