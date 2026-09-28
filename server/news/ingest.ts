import { createHash } from "node:crypto";
import type { DB, Row } from "../db/db.js";
import { iso } from "../db/db.js";
import type { RawArticle } from "../sources/types.js";

export interface Company {
  ticker: string;
  name: string;
  aliases: string[];
}

export function loadCompanies(db: DB, includeBenchmark = false): Company[] {
  return db
    .all<Row>(`SELECT * FROM companies WHERE active = 1 ${includeBenchmark ? "" : "AND is_benchmark = 0"} ORDER BY ticker`)
    .map((r) => ({ ticker: r.ticker, name: r.name, aliases: JSON.parse(r.aliases) }));
}

export function canonicalUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|guccounter|ref$|cmpid|mod$)/i.test(k)) u.searchParams.delete(k);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function contentLevel(title: string, summary: string | null): "title_only" | "summary" {
  if (!summary || summary.length < 40) return "title_only";
  const t = norm(title), sm = norm(summary);
  if (sm === t || sm.startsWith(t) && sm.length < t.length + 20) return "title_only";
  return "summary";
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function relevanceFor(c: Company, title: string, summary: string | null): "high" | "low" {
  const text = `${title} ${summary ?? ""}`;
  if (new RegExp(`(^|[^A-Z])\\$?${escapeRe(c.ticker)}([^A-Z]|$)`).test(text)) return "high";
  for (const a of [c.name.replace(/,? (Inc\.?|Corporation|Corp\.?|Co\.|Company|Platforms|Group|& Co\.)$/g, ""), ...c.aliases]) {
    if (a && new RegExp(`\\b${escapeRe(a)}\\b`, "i").test(text)) return "high";
  }
  return "low";
}

/** Grava artigos novos e versões alteradas. Retorna ids afetados. Idempotente. */
export function ingestArticles(db: DB, articles: RawArticle[], companies: Company[], now: Date) {
  const byTicker = new Map(companies.map((c) => [c.ticker, c]));
  let inserted = 0, updated = 0, linked = 0;
  db.tx(() => {
    for (const a of [...articles].sort((x, y) => x.publishedAt.getTime() - y.publishedAt.getTime())) {
      const sourceKey = `${a.provider}:${a.externalId}`;
      const urlC = canonicalUrl(a.url);
      const hash = sha(`${a.title}\n${a.summary ?? ""}`);
      let row = db.get("SELECT * FROM articles WHERE source_key = ?", sourceKey);
      if (!row && urlC) row = db.get("SELECT * FROM articles WHERE url_canonical = ?", urlC);
      let articleId: number;
      if (row) {
        articleId = row.id;
        if (row.content_hash !== hash && row.source_key === sourceKey) {
          db.run(
            "INSERT INTO article_versions(article_id, seen_at, title, summary, content_hash) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
            row.id, iso(now), a.title, a.summary, hash,
          );
          db.run(
            "UPDATE articles SET title = ?, summary = ?, content_hash = ?, content_level = ?, updated_at = ? WHERE id = ?",
            a.title, a.summary, hash, contentLevel(a.title, a.summary), iso(now), row.id,
          );
          updated++;
        }
      } else {
        articleId = db.run(
          `INSERT INTO articles(source_key, provider, outlet, url, url_canonical, title, summary, content_level,
             published_at, first_seen_at, content_hash, raw_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          sourceKey, a.provider, a.outlet, a.url, urlC, a.title, a.summary, contentLevel(a.title, a.summary),
          iso(a.publishedAt), iso(now), hash, JSON.stringify(a.raw ?? null),
        ).lastId;
        db.run(
          "INSERT INTO article_versions(article_id, seen_at, title, summary, content_hash) VALUES(?,?,?,?,?)",
          articleId, iso(now), a.title, a.summary, hash,
        );
        inserted++;
      }
      for (const t of new Set(a.related)) {
        const c = byTicker.get(t);
        if (!c) continue;
        const r = db.run(
          "INSERT INTO article_tickers(article_id, ticker, relevance) VALUES(?,?,?) ON CONFLICT DO NOTHING",
          articleId, t, relevanceFor(c, a.title, a.summary),
        );
        linked += r.changes;
      }
    }
  });
  return { inserted, updated, linked };
}

// ---------- Agrupamento em eventos ----------

const STOP = new Set(
  "a an the and or of to in on for with at by from as is are was were be its it this that update updated breaking exclusive report reports says said after amid new stock stocks shares inc corp co company".split(" "),
);

export function tokens(text: string, drop: string[] = []): Set<string> {
  const dropSet = new Set(drop.flatMap((d) => d.toLowerCase().split(/\W+/)));
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !dropSet.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const COMMENTARY = /\b(why .* (stock|shares)|what happened|week in review|recap|stocks to watch|top (stocks|movers)|here'?s why|should you buy|is it time to buy|market wrap|markets wrap)\b/i;

export const SIMILARITY_THRESHOLD = 0.5;
const WINDOW_MS = 48 * 3600_000;
const REPEAT_MS = 6 * 3600_000;

/**
 * Associa artigos ainda sem evento a um evento existente (mesmo acontecimento) ou cria um novo.
 * Dez sites repetindo um comunicado → um evento com article_count = 10.
 */
export function assignEvents(db: DB, companies: Company[]) {
  const byTicker = new Map(companies.map((c) => [c.ticker, c]));
  const pending = db.all<Row>(
    `SELECT a.*, at.ticker, at.relevance FROM article_tickers at JOIN articles a ON a.id = at.article_id
     WHERE NOT EXISTS (SELECT 1 FROM event_articles ea JOIN events e ON e.id = ea.event_id
                       WHERE ea.article_id = at.article_id AND e.ticker = at.ticker)
     ORDER BY a.published_at, a.id`,
  );
  let created = 0, joined = 0;
  db.tx(() => {
    for (const art of pending) {
      const c = byTicker.get(art.ticker);
      const drop = c ? [c.ticker, c.name, ...c.aliases] : [art.ticker];
      const tk = tokens(art.title, drop);
      const pub = new Date(art.published_at).getTime();
      const candidates = db.all<Row>(
        `SELECT e.*, a.title AS rep_title, a.url_canonical AS rep_url FROM events e JOIN articles a ON a.id = e.representative_article_id
         WHERE e.ticker = ? AND e.last_published_at >= ? AND e.first_published_at <= ?`,
        art.ticker, iso(new Date(pub - WINDOW_MS)), iso(new Date(pub + WINDOW_MS)),
      );
      let best: Row | undefined, bestScore = 0;
      for (const e of candidates) {
        // Compara com todos os títulos do evento, não só o representativo.
        const titles = db.all<Row>(
          "SELECT a.title FROM event_articles ea JOIN articles a ON a.id = ea.article_id WHERE ea.event_id = ?", e.id,
        );
        const score = Math.max(...titles.map((t) => jaccard(tk, tokens(t.title, drop))));
        if (score > bestScore) { bestScore = score; best = e; }
      }
      if (best && bestScore >= SIMILARITY_THRESHOLD) {
        const role = pub - new Date(best.first_published_at).getTime() <= REPEAT_MS ? "repeat" : "followup";
        db.run("INSERT INTO event_articles(event_id, article_id, role) VALUES(?,?,?)", best.id, art.id, role);
        db.run(
          `UPDATE events SET article_count = article_count + 1,
             last_published_at = MAX(last_published_at, ?), first_seen_at = MIN(first_seen_at, ?) WHERE id = ?`,
          art.published_at, art.first_seen_at, best.id,
        );
        joined++;
        continue;
      }
      let status = "ok", reason: string | null = null;
      if (art.relevance === "low") { status = "low_relevance"; reason = "empresa não citada no título/resumo"; }
      else if (COMMENTARY.test(art.title)) { status = "commentary"; reason = "comentário/resumo de mercado, não fato novo"; }
      else if (art.content_level === "title_only" && art.title.split(/\s+/).length < 5) { status = "insufficient"; reason = "só título, curto demais"; }
      const eventId = db.run(
        `INSERT INTO events(ticker, title, representative_article_id, first_published_at, last_published_at, first_seen_at, status, status_reason)
         VALUES(?,?,?,?,?,?,?,?)`,
        art.ticker, art.title, art.id, art.published_at, art.published_at, art.first_seen_at, status, reason,
      ).lastId;
      db.run("INSERT INTO event_articles(event_id, article_id, role) VALUES(?,?,?)", eventId, art.id, "original");
      created++;
    }
  });
  return { created, joined };
}
