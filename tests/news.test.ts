import { describe, expect, it } from "vitest";
import { memDb } from "./helpers.js";
import { assignEvents, canonicalUrl, contentLevel, ingestArticles, relevanceFor } from "../server/news/ingest.js";
import type { RawArticle } from "../server/sources/types.js";

const companies = [
  { ticker: "NVDA", name: "NVIDIA Corporation", aliases: ["Nvidia"] },
  { ticker: "AMD", name: "Advanced Micro Devices", aliases: ["AMD"] },
];
const art = (id: string, title: string, at: string, related = ["NVDA"], extra: Partial<RawArticle> = {}): RawArticle => ({
  provider: "t", externalId: id, outlet: `O${id}`, url: `https://site${id}.com/a/${id}?utm_source=x`, title,
  summary: `${title}. Additional context about the company and the announcement for readers.`, publishedAt: new Date(at), related, raw: null, ...extra,
});

describe("notícias e eventos", () => {
  it("dez sites repetindo um comunicado viram um único evento", () => {
    const db = memDb();
    const now = new Date("2026-09-28T15:00:00Z");
    const arts = Array.from({ length: 10 }, (_, i) =>
      art(String(i), `${i % 2 ? "UPDATE: " : ""}Nvidia announces new supply agreement with major cloud customer`, `2026-09-28T1${i % 3}:0${i}:00Z`),
    );
    ingestArticles(db, arts, companies, now);
    assignEvents(db, companies);
    const events = db.all("SELECT * FROM events");
    expect(events).toHaveLength(1);
    expect(events[0].article_count).toBe(10);
  });

  it("acontecimentos diferentes ficam separados", () => {
    const db = memDb();
    const now = new Date("2026-09-28T15:00:00Z");
    ingestArticles(db, [
      art("1", "Nvidia beats quarterly estimates and raises guidance", "2026-09-28T12:00:00Z"),
      art("2", "Regulators open antitrust investigation into Nvidia chip sales", "2026-09-28T13:00:00Z"),
    ], companies, now);
    assignEvents(db, companies);
    expect(db.all("SELECT * FROM events")).toHaveLength(2);
  });

  it("reingestão e mesma URL em outro provedor não duplicam", () => {
    const db = memDb();
    const now = new Date("2026-09-28T15:00:00Z");
    const a = art("1", "Nvidia beats estimates", "2026-09-28T12:00:00Z");
    ingestArticles(db, [a], companies, now);
    ingestArticles(db, [a], companies, now);
    ingestArticles(db, [{ ...a, provider: "other", externalId: "zzz", url: "https://www.site1.com/a/1" }], companies, now);
    expect(db.all("SELECT * FROM articles")).toHaveLength(1);
  });

  it("guarda versões quando o conteúdo muda", () => {
    const db = memDb();
    const a = art("1", "Nvidia beats estimates", "2026-09-28T12:00:00Z");
    ingestArticles(db, [a], companies, new Date("2026-09-28T13:00:00Z"));
    ingestArticles(db, [{ ...a, title: "Nvidia beats estimates, shares jump" }], companies, new Date("2026-09-28T14:00:00Z"));
    expect(db.all("SELECT * FROM article_versions")).toHaveLength(2);
    expect(db.get("SELECT title FROM articles")!.title).toBe("Nvidia beats estimates, shares jump");
  });

  it("classifica relevância por empresa (uma matéria, várias empresas)", () => {
    const db = memDb();
    ingestArticles(db, [art("1", "Nvidia wins contract that AMD had bid for", "2026-09-28T12:00:00Z", ["NVDA", "AMD"]),
      art("2", "Chip stocks mixed in early trading", "2026-09-28T12:00:00Z", ["AMD"], { summary: null })], companies, new Date("2026-09-28T13:00:00Z"));
    assignEvents(db, companies);
    const ev = db.all("SELECT ticker, status FROM events ORDER BY ticker, id");
    expect(ev).toEqual([
      { ticker: "AMD", status: "ok" },
      { ticker: "AMD", status: "low_relevance" },
      { ticker: "NVDA", status: "ok" },
    ]);
  });

  it("marca comentários e conteúdo só com título", () => {
    expect(contentLevel("Nvidia beats", null)).toBe("title_only");
    expect(contentLevel("Nvidia beats", "Nvidia beats")).toBe("title_only");
    expect(relevanceFor(companies[0], "Why NVDA stock is up today", null)).toBe("high");
    const db = memDb();
    ingestArticles(db, [art("1", "Why Nvidia stock is up today", "2026-09-28T12:00:00Z")], companies, new Date("2026-09-28T13:00:00Z"));
    assignEvents(db, companies);
    expect(db.get("SELECT status FROM events")!.status).toBe("commentary");
  });

  it("normaliza URLs", () => {
    expect(canonicalUrl("https://www.x.com/a/b/?utm_source=1&id=2#top")).toBe("x.com/a/b?id=2");
  });
});
