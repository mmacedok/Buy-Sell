import { DateTime } from "luxon";

/**
 * Calendário da bolsa americana (NYSE/Nasdaq). Horários internos em UTC;
 * a conversão para America/New_York acontece só aqui.
 *
 * Feriados e pregões encurtados fixados manualmente. Atualizar a cada ano
 * (fonte: calendário oficial da NYSE). Anos fora da lista geram erro para
 * evitar operar num feriado desconhecido.
 */
export const TZ = "America/New_York";

const HOLIDAYS: Record<number, string[]> = {
  2024: ["2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25"],
  2025: ["2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"],
  2026: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
  2027: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
};

// Pregões que fecham às 13h (horário de Nova York).
const EARLY_CLOSES = new Set([
  "2024-07-03", "2024-11-29", "2024-12-24",
  "2025-07-03", "2025-11-28", "2025-12-24",
  "2026-11-27", "2026-12-24",
  "2027-11-26",
]);

const holidaySet = new Set(Object.values(HOLIDAYS).flat());

export function isCalendarKnown(date: string): boolean {
  return Number(date.slice(0, 4)) in HOLIDAYS;
}

// Aritmética de datas-calendário (sem fuso) em UTC puro — rápida e sem ambiguidade.
const toUtcMs = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
const fromUtcMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** 1 = segunda … 7 = domingo */
const weekday = (date: string) => ((new Date(toUtcMs(date)).getUTCDay() + 6) % 7) + 1;

/** date no formato YYYY-MM-DD (data de Nova York). */
export function isTradingDay(date: string): boolean {
  if (!isCalendarKnown(date)) throw new Error(`Calendário da bolsa não cadastrado para ${date.slice(0, 4)}`);
  if (weekday(date) >= 6) return false;
  return !holidaySet.has(date);
}

// Mudanças de horário de verão ocorrem em horas cheias; a data de NY é constante dentro de cada hora UTC.
const nyDateCache = new Map<number, string>();
export function nyDate(t: Date): string {
  const hour = Math.floor(t.getTime() / 3600_000);
  let d = nyDateCache.get(hour);
  if (!d) {
    d = DateTime.fromMillis(hour * 3600_000, { zone: TZ }).toISODate()!;
    if (nyDateCache.size > 200_000) nyDateCache.clear();
    nyDateCache.set(hour, d);
  }
  return d;
}

const nyTimeCache = new Map<string, number>();
/** Converte data + "HH:mm" de Nova York para instante UTC. */
export function nyTime(date: string, hhmm: string): Date {
  const key = `${date} ${hhmm}`;
  let ms = nyTimeCache.get(key);
  if (ms === undefined) {
    const [h, m] = hhmm.split(":").map(Number);
    ms = DateTime.fromISO(date, { zone: TZ }).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toMillis();
    nyTimeCache.set(key, ms);
  }
  return new Date(ms);
}

export function sessionOpen(date: string): Date {
  return nyTime(date, "09:30");
}

export function sessionClose(date: string): Date {
  return nyTime(date, EARLY_CLOSES.has(date) ? "13:00" : "16:00");
}

export function isEarlyClose(date: string): boolean {
  return EARLY_CLOSES.has(date);
}

function shiftDay(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * 86400_000);
}

/** Soma n pregões (n pode ser negativo). addSessions(d, 0) exige que d seja pregão. */
export function addSessions(date: string, n: number): string {
  if (n === 0) {
    if (!isTradingDay(date)) throw new Error(`${date} não é pregão`);
    return date;
  }
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  let d = date;
  while (left > 0) {
    d = shiftDay(d, step);
    if (isTradingDay(d)) left--;
  }
  return d;
}

export function nextTradingDay(date: string): string {
  return addSessions(date, 1);
}

export function previousTradingDay(date: string): string {
  return addSessions(date, -1);
}

/** Pregões no intervalo [from, to], inclusive. */
export function tradingDaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let d = from;
  while (d <= to) {
    if (isTradingDay(d)) out.push(d);
    d = shiftDay(d, 1);
  }
  return out;
}

export function isMarketOpen(t: Date): boolean {
  const d = nyDate(t);
  if (!isTradingDay(d)) return false;
  return t >= sessionOpen(d) && t < sessionClose(d);
}

/** Semana ISO (segunda-feira) de uma data de pregão, para relatórios semanais. */
export function weekStart(date: string): string {
  return shiftDay(date, -(weekday(date) - 1));
}

export { shiftDay };
