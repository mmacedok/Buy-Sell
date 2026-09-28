import { useApi } from "../api";
import { EquityChart } from "../components/Charts";
import { cls, date, dt, money, num, pct, st } from "../fmt";
import { go } from "../App";

const JOB_LABEL: Record<string, string> = {
  tick_news: "Coleta de notícias", tick_prices: "Coleta de preços", tick_orders: "Ordens pendentes",
  tick_close: "Fechamento e avaliação", tick_corporate_actions: "Eventos corporativos",
};

export function Overview({ status }: { status: any }) {
  const { data, error } = useApi("/overview", 60_000);
  if (error) return <p className="neg">{error}</p>;
  if (!data) return <p className="muted">Carregando…</p>;
  return (
    <>
      <div className="grid">
        {data.experiments.map((e: any) => (
          <section className="card" key={e.id}>
            <h2><a href={`#/portfolio/${e.id}`}>{e.name}</a></h2>
            <div className="stats">
              <div className="stat"><div className="v">{money(e.equityNow)}</div><div className="l">Patrimônio agora</div></div>
              <div className="stat"><div className={`v ${cls(e.weekReturn)}`}>{pct(e.weekReturn)}</div><div className="l">Na semana</div></div>
              <div className="stat"><div className={`v ${cls(e.metrics.netReturn)}`}>{pct(e.metrics.netReturn)}</div><div className="l">Desde {date(e.startedOn)} (fechamentos)</div></div>
              <div className="stat"><div className="v">{pct(-e.metrics.maxDrawdown)}</div><div className="l">Maior queda</div></div>
            </div>
            <h3>Comparação com referências (mesmo período)</h3>
            <table>
              <tbody>
                <tr><td>Estratégia</td><td className={`n ${cls(e.metrics.netReturn)}`}>{pct(e.metrics.netReturn)}</td></tr>
                <tr><td>Mesmas ações, pesos iguais</td><td className={`n ${cls(e.metrics.benchmarks.equalWeight.return)}`}>{pct(e.metrics.benchmarks.equalWeight.return)}</td></tr>
                <tr><td>{e.metrics.benchmarks.benchmark.ticker}</td><td className={`n ${cls(e.metrics.benchmarks.benchmark.return)}`}>{pct(e.metrics.benchmarks.benchmark.return)}</td></tr>
                <tr><td>Caixa</td><td className="n">{pct(0)}</td></tr>
              </tbody>
            </table>
            {e.metrics.sampleWarning && <p className="small muted">{e.metrics.sampleWarning}</p>}
            <h3>Evolução</h3>
            <EquityChart series={e.series} initial={Number(e.series.cash?.[0]?.value ?? 10000)} height={200} />
            <h3>Posições abertas ({e.positions.length}) · caixa {money(e.cash)}{e.reserved ? ` (reservado ${money(e.reserved)})` : ""}</h3>
            {e.positions.length ? (
              <div className="scroll">
                <table>
                  <thead><tr><th>Ação</th><th className="n">Qtd.</th><th className="n">Último preço</th><th className="n">Valor</th><th className="n">Resultado</th></tr></thead>
                  <tbody>
                    {e.positions.map((p: any) => (
                      <tr key={p.ticker}>
                        <td><a href={`#/stock/${p.ticker}`}>{p.ticker}</a></td>
                        <td className="n">{num(p.quantity, 4)}</td>
                        <td className="n">{p.price ? money(p.price) : <span className="muted">sem preço</span>}</td>
                        <td className="n">{money(p.value)}</td>
                        <td className={`n ${cls(Number(p.unrealized))}`}>{money(p.unrealized)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted small">Nenhuma posição: capital em caixa.</p>}
            <p className="small muted">
              Última rodada: {e.lastRound ? `${date(e.lastRound.session_date)} — ${st(e.lastRound.status)}` : "nenhuma ainda"}
            </p>
          </section>
        ))}
      </div>
      {status && (
        <section className="card" style={{ marginTop: 12 }}>
          <h2>Estado da coleta</h2>
          <p className="small">
            Modo <b>{status.mode}</b> · Notícias: {status.news.join(", ") || "nenhuma fonte"} · Preços: {status.prices.source ?? "nenhuma fonte"}
            {status.prices.feed ? ` (feed ${status.prices.feed}, atraso considerado ${status.prices.delayMinutes} min)` : ""} · Última barra: {dt(status.prices.lastMinuteBar)}
          </p>
          <p className="small">IA hoje: US$ {num(status.budget.day, 4)} de {num(status.budget.dailyLimit)} · no mês: US$ {num(status.budget.month, 4)} de {num(status.budget.monthlyLimit)}</p>
          <div className="scroll">
            <table>
              <thead><tr><th>Rotina</th><th>Última execução</th><th>Último sucesso</th><th>Erro</th></tr></thead>
              <tbody>
                {status.jobs.filter((j: any) => !j.name.startsWith("news:")).map((j: any) => (
                  <tr key={j.name}>
                    <td>{JOB_LABEL[j.name] ?? j.name}</td><td>{dt(j.last_run_at)}</td><td>{dt(j.last_ok_at)}</td>
                    <td className="neg small">{j.last_error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button style={{ marginTop: 8 }} onClick={() => go("news")}>Ver notícias</button>
        </section>
      )}
    </>
  );
}
