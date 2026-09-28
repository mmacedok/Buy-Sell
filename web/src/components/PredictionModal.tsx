import { useApi } from "../api";
import { DIR, dt, pct, st } from "../fmt";

/** O que estava disponível no momento da previsão: pacote exato enviado ao modelo e a resposta. */
export function PredictionModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, error } = useApi(`/predictions/${id}`, 0);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Registro da previsão #{id}</h2>
          <button onClick={onClose}>Fechar</button>
        </div>
        {error && <p className="neg">{error}</p>}
        {data && (
          <>
            <p>
              <b>{data.prediction.ticker}</b> — previsão para {data.prediction.horizon} pregão(ões):{" "}
              <b>{data.prediction.direction ? DIR[data.prediction.direction] : "sem previsão"}</b> (força {data.prediction.strength})
            </p>
            <p className="small">{data.prediction.explanation}</p>
            {data.prediction.counter_evidence.length > 0 && <p className="small"><b>Evidências contrárias:</b> {data.prediction.counter_evidence.join("; ")}</p>}
            {data.prediction.limitations.length > 0 && <p className="small"><b>Limitações:</b> {data.prediction.limitations.join("; ")}</p>}
            <p className="small">
              <b>Resultado:</b>{" "}
              {data.prediction.eval_status === "evaluated"
                ? `${pct(Number(data.prediction.eval_return))} entre ${dt(data.prediction.eval_start_at)} e ${dt(data.prediction.eval_end_at)} — ${data.prediction.eval_correct === 1 ? "acertou" : data.prediction.eval_correct === 0 ? "errou" : "neutro"}`
                : "aguardando avaliação"}
            </p>
            <p className="small muted">
              Dados até {dt(data.run.cutoff_at)} · modelo {data.run.model} · instruções {data.run.prompt_version} · status {st(data.run.status)} · custo US$ {data.run.cost_usd}
              {data.run.error ? ` · erro: ${data.run.error}` : ""}
            </p>
            {data.decisions.length > 0 && (
              <p className="small">
                <b>Decisões:</b> {data.decisions.map((d: any) => `${d.experiment}: ${d.action === "buy" ? "compra" : "sem operação"} (${d.reason})`).join(" · ")}
              </p>
            )}
            <h3>Eventos e fontes disponíveis naquele momento</h3>
            <ul className="small">
              {data.run.input?.events?.map((e: any) => (
                <li key={e.event_id}>
                  #{e.event_id} {e.is_new_since_last_round ? "(novo)" : "(anterior)"} · {e.classifier ? `${e.classifier.label} conf. ${e.classifier.confidence ?? "—"}` : "sem classificação"} · {st(e.content_level)}
                  <ul>
                    {e.sources.map((s: any, i: number) => (
                      <li key={i}>{s.outlet}: {s.title} {s.url && <a href={s.url} target="_blank" rel="noreferrer noopener">link</a>}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <details>
              <summary>Pacote completo enviado ao modelo</summary>
              <pre>{JSON.stringify(data.run.input, null, 2)}</pre>
            </details>
            <details>
              <summary>Resposta do modelo</summary>
              <pre>{JSON.stringify(data.run.output, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
