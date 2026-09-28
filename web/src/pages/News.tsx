import { useState } from "react";
import { post, useApi } from "../api";
import { dt, num, st } from "../fmt";

const ROLE: Record<string, string> = { original: "original", repeat: "repetição", followup: "desdobramento posterior" };

export function News({ ticker }: { ticker?: string }) {
  const [t, setT] = useState(ticker ?? "");
  const [status, setStatus] = useState("ok");
  const { data, error, reload } = useApi(`/news?limit=150&ticker=${t}&status=${status}`, 120_000);
  const { data: settings } = useApi("/settings", 0);
  const { data: agreement, reload: reloadAgreement } = useApi("/labels/agreement", 0);
  const label = async (eventId: number, tk: string, l: string) => {
    await post("/labels", { eventId, ticker: tk, label: l });
    reload(); reloadAgreement();
  };
  return (
    <>
      <div className="row">
        <select value={t} onChange={(e) => setT(e.target.value)}>
          <option value="">Todas as empresas</option>
          {settings?.companies.filter((c: any) => !c.is_benchmark).map((c: any) => <option key={c.ticker} value={c.ticker}>{c.ticker} — {c.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ok">Eventos válidos</option>
          <option value="">Todos</option>
          <option value="low_relevance">Pouco relevantes</option>
          <option value="commentary">Comentários</option>
          <option value="insufficient">Conteúdo insuficiente</option>
        </select>
        <span className="small muted">
          Revisão manual: {agreement ? `${agreement.labeled} rotuladas, concordância com o JEV ${agreement.agreement === null ? "—" : `${Math.round(agreement.agreement * 100)}%`} (n=${agreement.comparable})` : "…"}
        </span>
      </div>
      <p className="small muted">A confiança do JEV mede a certeza da classificação bullish/bearish — não é a chance de a ação subir.</p>
      {error && <p className="neg">{error}</p>}
      {!data ? <p className="muted">Carregando…</p> : data.events.length === 0 ? <p className="muted">Nenhum evento.</p> : (
        <div className="scroll card">
          <table>
            <thead><tr><th>Publicado</th><th>Empresa</th><th>Evento</th><th>Fontes</th><th>Conteúdo</th><th>JEV</th><th>Revisão</th></tr></thead>
            <tbody>
              {data.events.map((e: any) => {
                const c = e.classifications[0];
                return (
                  <tr key={e.id}>
                    <td className="small">{dt(e.first_published_at)}<div className="muted">visto {dt(e.first_seen_at)}</div></td>
                    <td><a href={`#/stock/${e.ticker}`}>{e.ticker}</a></td>
                    <td>
                      <details>
                        <summary>{e.title} <span className="muted small">#{e.id}</span></summary>
                        <ul className="small">
                          {e.articles.map((a: any) => (
                            <li key={a.id}>
                              <b>{a.outlet ?? a.provider}</b> ({ROLE[a.role] ?? a.role}) — {dt(a.published_at)}{" "}
                              {a.url && <a href={a.url} target="_blank" rel="noreferrer noopener">link</a>}
                              <div>{a.title}</div>
                              {a.summary && <div className="muted">{a.summary}</div>}
                            </li>
                          ))}
                        </ul>
                        {e.status_reason && <p className="small muted">{e.status_reason}</p>}
                      </details>
                    </td>
                    <td className="n">{e.article_count}</td>
                    <td className="small">{st(e.content_level)}</td>
                    <td>
                      {c ? (
                        <>
                          <span className={`tag ${c.label === "bullish" ? "bull" : "bear"}`}>{c.label}</span>
                          <div className="small muted">conf. {c.confidence === null ? "—" : num(c.confidence, 2)}</div>
                        </>
                      ) : <span className="muted small">{e.status === "ok" ? "aguardando" : st(e.status)}</span>}
                    </td>
                    <td>
                      <select value={e.label?.human_label ?? ""} onChange={(ev) => label(e.id, e.ticker, ev.target.value)}>
                        <option value="" disabled>—</option>
                        <option value="bullish">bullish</option>
                        <option value="bearish">bearish</option>
                        <option value="ambiguous">ambígua</option>
                        <option value="irrelevant">irrelevante</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
