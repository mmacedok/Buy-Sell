import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import { date, money, pct } from "../fmt";

type Pt = { date: string; value: number };

const SERIES = [
  { key: "strategy", label: "Estratégia", color: "var(--s1)" },
  { key: "equalWeight", label: "Mesmas ações, pesos iguais", color: "var(--s2)" },
  { key: "benchmark", label: "SPY", color: "var(--s3)" },
] as const;

/** Patrimônio da estratégia × referências obrigatórias (caixa = linha de base). */
export function EquityChart({ series, initial, height = 240 }: { series: Record<string, Pt[]>; initial: number; height?: number }) {
  const dates = [...new Set(Object.values(series).flat().map((p) => p.date))].sort();
  const rows = dates.map((d) => {
    const r: Record<string, number | string | null> = { date: d };
    for (const s of SERIES) r[s.key] = series[s.key]?.find((p) => p.date === d)?.value ?? null;
    return r;
  });
  if (!rows.length) return <p className="muted small">Sem fechamentos registrados ainda.</p>;
  return (
    <div>
      <div className="legend">
        {SERIES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
        <span><i style={{ background: "var(--axis)" }} />Caixa (US$ {initial.toLocaleString("pt-BR")})</span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={(d) => date(d).slice(0, 5)} stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 11 }} />
          <YAxis domain={["auto", "auto"]} tickFormatter={(v) => `${(v / 1000).toFixed(1)}k`} stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 11 }} width={44} />
          <ReferenceLine y={initial} stroke="var(--axis)" strokeDasharray="4 3" />
          <Tooltip
            cursor={{ stroke: "var(--muted)", strokeWidth: 1 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="tt">
                  <div className="muted">{date(String(label))}</div>
                  {SERIES.map((s) => {
                    const v = payload.find((p) => p.dataKey === s.key)?.value as number | undefined;
                    return v === undefined || v === null ? null : (
                      <div key={s.key}>
                        <i style={{ display: "inline-block", width: 12, height: 2, background: s.color, marginRight: 6, verticalAlign: "middle" }} />
                        <strong>{money(v)}</strong> <span className="muted">{pct(v / initial - 1)} · {s.label}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null
            }
          />
          {SERIES.map((s) => (
            <Line key={s.key} type="linear" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Preço de fechamento (ajustado) com marcações dos eventos. Uma série: sem legenda. */
export function PriceChart({ bars, markers }: { bars: { ts: string; close: string }[]; markers: { date: string; label: string }[] }) {
  const rows = bars.map((b) => ({ date: b.ts.slice(0, 10), close: Number(b.close) }));
  if (!rows.length) return <p className="muted small">Sem histórico de preços.</p>;
  const markerDates = new Map(markers.map((m) => [m.date, m.label]));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="date" tickFormatter={(d) => date(d).slice(0, 5)} stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 11 }} minTickGap={24} />
        <YAxis domain={["auto", "auto"]} stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 11 }} width={48} />
        {[...markerDates.keys()].filter((d) => rows.some((r) => r.date === d)).map((d) => (
          <ReferenceLine key={d} x={d} stroke="var(--muted)" strokeDasharray="2 3" />
        ))}
        <Tooltip
          cursor={{ stroke: "var(--muted)", strokeWidth: 1 }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="tt">
                <strong>{money(payload[0].value as number)}</strong> <span className="muted">{date(String(label))}</span>
                {markerDates.get(String(label)) ? <div className="muted">{markerDates.get(String(label))}</div> : null}
              </div>
            ) : null
          }
        />
        <Line type="linear" dataKey="close" stroke="var(--s1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
