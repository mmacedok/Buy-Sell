import { useEffect, useState } from "react";
import { useApi } from "./api";
import { Overview } from "./pages/Overview";
import { News } from "./pages/News";
import { Stock } from "./pages/Stock";
import { Portfolio } from "./pages/Portfolio";
import { Experiments } from "./pages/Experiments";
import { Settings } from "./pages/Settings";
import { PredictionModal } from "./components/PredictionModal";

const TABS = [
  ["overview", "Visão geral"],
  ["news", "Notícias"],
  ["stock", "Ação"],
  ["portfolio", "Carteira"],
  ["experiments", "Experimentos"],
  ["settings", "Configurações"],
] as const;

function parseHash() {
  const [tab, arg] = window.location.hash.replace(/^#\/?/, "").split("/");
  return { tab: tab || "overview", arg: arg ? decodeURIComponent(arg) : undefined };
}

export function go(tab: string, arg?: string | number) {
  window.location.hash = `/${tab}${arg !== undefined ? `/${encodeURIComponent(String(arg))}` : ""}`;
}

export function App() {
  const [route, setRoute] = useState(parseHash());
  const [predictionId, setPredictionId] = useState<number | null>(null);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    const open = (e: Event) => setPredictionId((e as CustomEvent).detail);
    window.addEventListener("open-prediction", open);
    return () => { window.removeEventListener("hashchange", on); window.removeEventListener("open-prediction", open); };
  }, []);
  const { data: status } = useApi("/status", 30_000);

  return (
    <>
      <header>
        <h1>Carteiras fictícias</h1>
        <nav>
          {TABS.map(([k, label]) => (
            <a key={k} href={`#/${k}`} className={route.tab === k ? "active" : ""}>{label}</a>
          ))}
        </nav>
        <span className="muted small" style={{ marginLeft: "auto" }}>
          {status ? `${status.market.open ? "Mercado aberto" : "Mercado fechado"} · preços: ${status.prices.feed ?? "—"}` : ""}
        </span>
      </header>
      <main>
        {status?.warnings?.map((w: string) => (
          <div key={w} className={`banner ${w.startsWith("MODO MOCK") ? "mock" : ""}`}>{w}</div>
        ))}
        <div className="banner small">Simulação com dinheiro fictício. Nenhuma ordem real é enviada. Resultados passados não garantem resultados futuros.</div>
        {route.tab === "overview" && <Overview status={status} />}
        {route.tab === "news" && <News ticker={route.arg} />}
        {route.tab === "stock" && <Stock ticker={route.arg ?? "NVDA"} />}
        {route.tab === "portfolio" && <Portfolio expId={route.arg ? Number(route.arg) : undefined} />}
        {route.tab === "experiments" && <Experiments />}
        {route.tab === "settings" && <Settings />}
      </main>
      {predictionId !== null && <PredictionModal id={predictionId} onClose={() => setPredictionId(null)} />}
    </>
  );
}

export function openPrediction(id: number) {
  window.dispatchEvent(new CustomEvent("open-prediction", { detail: id }));
}
