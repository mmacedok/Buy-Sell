import { useState } from "react";
import { api, post, useApi } from "../api";
import { date, num } from "../fmt";

const EXPORTS = ["predictions", "decisions", "orders", "executions", "positions", "cash_ledger", "equity_snapshots", "events", "articles", "jev_classifications", "api_costs", "labeled_samples"];

export function Settings() {
  const { data, error, reload } = useApi("/settings", 0);
  const [msg, setMsg] = useState<string | null>(null);
  const [company, setCompany] = useState({ ticker: "", name: "", aliases: "" });
  const [newExp, setNewExp] = useState({ name: "", base: "", analystModel: "", slippageBps: "", halfSpreadBps: "", maxPositions: "" });
  const run = async (f: () => Promise<unknown>, ok: string) => {
    try { const r = await f(); setMsg(`${ok} ${typeof r === "object" ? JSON.stringify(r).slice(0, 300) : ""}`); reload(); }
    catch (e) { setMsg(`Erro: ${(e as Error).message}`); }
  };
  if (error) return <p className="neg">{error}</p>;
  if (!data) return <p className="muted">Carregando…</p>;
  const baseExp = data.experiments.find((e: any) => String(e.id) === newExp.base) ?? data.experiments[0];
  return (
    <>
      {msg && <div className="banner small">{msg}</div>}
      <div className="grid">
        <section className="card">
          <h2>Fontes e chaves (somente no backend)</h2>
          <table className="small">
            <tbody>
              <tr><td>Modo</td><td><b>{data.env.DATA_MODE}</b></td></tr>
              <tr><td>Finnhub</td><td>{data.env.FINNHUB_API_KEY ? "configurada" : "ausente"}</td></tr>
              <tr><td>Alpaca</td><td>{data.env.ALPACA_API_KEY_ID ? `configurada (feed ${data.env.ALPACA_DATA_FEED})` : "ausente"}</td></tr>
              <tr><td>OpenRouter</td><td>{data.env.OPENROUTER_API_KEY ? "configurada" : "ausente"}</td></tr>
              <tr><td>SEC User-Agent</td><td>{data.env.SEC_USER_AGENT ? "configurado" : "ausente"}</td></tr>
              <tr><td>Modelos padrão (novos experimentos)</td><td>JEV {data.env.JEV_MODEL} · analista {data.env.ANALYST_MODEL}</td></tr>
              <tr><td>Orçamento de IA</td><td>US$ {data.env.AI_BUDGET_DAILY_USD}/dia · US$ {data.env.AI_BUDGET_MONTHLY_USD}/mês</td></tr>
            </tbody>
          </table>
          <p className="small muted">Chaves e limites são definidos no arquivo .env e exigem reiniciar o backend.</p>
          <div className="row">
            <button onClick={() => run(() => post("/actions/collect"), "Coleta concluída.")}>Coletar agora</button>
            <button onClick={() => run(() => post("/actions/classify"), "Classificação concluída.")}>Classificar eventos pendentes</button>
          </div>
        </section>

        <section className="card">
          <h2>Gastos reais com IA</h2>
          <div className="scroll">
            <table className="small">
              <thead><tr><th>Dia (UTC)</th><th>Uso</th><th>Modelo</th><th className="n">Chamadas</th><th className="n">US$</th></tr></thead>
              <tbody>{data.aiCosts.map((c: any, i: number) => <tr key={i}><td>{c.day}</td><td>{c.purpose}</td><td>{c.model}</td><td className="n">{c.calls}</td><td className="n">{num(c.cost, 4)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: 12 }}>
        <h2>Experimentos</h2>
        <p className="small muted">Regras, modelos e instruções ficam fixados em cada experimento. Para mudar algo, crie um novo experimento — ele começa no próximo pregão.</p>
        <table className="small">
          <thead><tr><th>Nome</th><th>Início</th><th>Prazo</th><th>Analista</th><th>Ativo</th></tr></thead>
          <tbody>
            {data.experiments.map((e: any) => (
              <tr key={e.id}>
                <td>{e.name}</td><td>{date(e.startedOn)}</td><td>{e.config.horizonSessions} preg.</td><td>{e.config.analystModel}</td>
                <td><button onClick={() => run(() => post(`/experiments/${e.id}/active`, { active: !e.active }), "Atualizado.")}>{e.active ? "Pausar" : "Retomar"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Novo experimento (copia as regras de outro)</h3>
        <div className="row">
          <select value={newExp.base} onChange={(e) => setNewExp({ ...newExp, base: e.target.value })}>
            {data.experiments.map((e: any) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <input placeholder="Nome" value={newExp.name} onChange={(e) => setNewExp({ ...newExp, name: e.target.value })} />
          <input placeholder={`Analista (${baseExp?.config.analystModel})`} value={newExp.analystModel} onChange={(e) => setNewExp({ ...newExp, analystModel: e.target.value })} />
          <input placeholder={`Slippage bps (${baseExp?.config.costs.slippageBps})`} size={16} value={newExp.slippageBps} onChange={(e) => setNewExp({ ...newExp, slippageBps: e.target.value })} />
          <input placeholder={`Meio spread bps (${baseExp?.config.costs.halfSpreadBps})`} size={18} value={newExp.halfSpreadBps} onChange={(e) => setNewExp({ ...newExp, halfSpreadBps: e.target.value })} />
          <input placeholder={`Máx. posições (${baseExp?.config.maxPositions})`} size={16} value={newExp.maxPositions} onChange={(e) => setNewExp({ ...newExp, maxPositions: e.target.value })} />
          <button
            disabled={!newExp.name || !baseExp}
            onClick={() => {
              const c = baseExp.config;
              const config = {
                ...c,
                universe: data.companies.filter((x: any) => x.active && !x.is_benchmark).map((x: any) => x.ticker),
                analystModel: newExp.analystModel || c.analystModel,
                maxPositions: newExp.maxPositions ? Number(newExp.maxPositions) : c.maxPositions,
                costs: { ...c.costs, slippageBps: newExp.slippageBps || c.costs.slippageBps, halfSpreadBps: newExp.halfSpreadBps || c.costs.halfSpreadBps },
              };
              run(() => post("/experiments", { name: newExp.name, config }), "Experimento criado.");
            }}
          >Criar</button>
        </div>
      </section>

      <section className="card" style={{ marginTop: 12 }}>
        <h2>Empresas acompanhadas</h2>
        <div className="scroll">
          <table className="small">
            <thead><tr><th>Ticker</th><th>Nome</th><th>Nomes para relevância</th><th>CIK (SEC)</th><th>Ativa</th></tr></thead>
            <tbody>
              {data.companies.map((c: any) => (
                <tr key={c.ticker}>
                  <td>{c.ticker}{c.is_benchmark ? " (referência)" : ""}</td><td>{c.name}</td><td>{c.aliases.join(", ")}</td><td>{c.cik ?? "—"}</td>
                  <td>{!c.is_benchmark && <input type="checkbox" checked={!!c.active} onChange={(e) => run(() => post("/companies", { ...c, active: e.target.checked }), "Atualizado.")} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="Ticker" size={8} value={company.ticker} onChange={(e) => setCompany({ ...company, ticker: e.target.value.toUpperCase() })} />
          <input placeholder="Nome" value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} />
          <input placeholder="Outros nomes, separados por vírgula" size={32} value={company.aliases} onChange={(e) => setCompany({ ...company, aliases: e.target.value })} />
          <button disabled={!company.ticker || !company.name} onClick={() => run(() => post("/companies", { ...company, aliases: company.aliases.split(",").map((s) => s.trim()).filter(Boolean) }), "Empresa salva.")}>Adicionar</button>
        </div>
      </section>

      <div className="grid" style={{ marginTop: 12 }}>
        <section className="card">
          <h2>Exportar CSV</h2>
          <div className="row">{EXPORTS.map((t) => <a key={t} href={`/api/export/${t}.csv`}>{t}</a>)}</div>
        </section>
        <section className="card">
          <h2>Importar CSV</h2>
          <p className="small muted">Notícias: ticker,published_at,title,summary,url,source · Barras: ticker,timeframe,ts,open,high,low,close,volume,adjusted</p>
          <div className="row">
            <label>Notícias <input type="file" accept=".csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) run(async () => api("/import/news", { method: "POST", headers: { "content-type": "text/csv" }, body: await f.text() }), "Importado."); }} /></label>
            <label>Barras <input type="file" accept=".csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) run(async () => api("/import/bars", { method: "POST", headers: { "content-type": "text/csv" }, body: await f.text() }), "Importado."); }} /></label>
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: 12 }}>
        <h2>Instruções do analista</h2>
        {Object.entries(data.analystPrompts).map(([k, v]) => (
          <details key={k}><summary>{k}</summary><pre>{String(v)}</pre></details>
        ))}
      </section>
    </>
  );
}
