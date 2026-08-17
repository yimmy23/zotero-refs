import { cleanText } from "../core/text";
import { http, politeEmail } from "../core/http";
import type { Identifiers, MetaSource, RefItem, RefTag } from "../core/types";

/**
 * Unpaywall (api.unpaywall.org) — open-access status and OA location
 * lookup by DOI. Free, no key required; requires an `email` param.
 */

const TYPE_MAP: Record<string, string> = {
  "journal-article": "journalArticle",
  report: "report",
  "posted-content": "preprint",
  "book-chapter": "bookSection",
  "proceedings-article": "conferencePaper",
  book: "book",
};

export const unpaywall: MetaSource & {
  getInfoByDOI(doi: string): Promise<RefItem | null>;
} = {
  id: "unpaywall",

  async getInfoByDOI(doi: string): Promise<RefItem | null> {
    const url =
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}` +
      `?email=${encodeURIComponent(politeEmail())}`;
    const data = await http.getJSON(url);
    if (!data) return null;

    const identifiers: Identifiers = { DOI: doi };
    // current (OpenAlex-backed) Unpaywall returns raw_author_name only;
    // family/name cover the legacy shape
    const authors: string[] = Array.isArray(data.z_authors)
      ? data.z_authors
          .map((a: any) => a.raw_author_name ?? a.family ?? a.name)
          .filter(Boolean)
      : [];

    const oaUrl: string | undefined =
      data.best_oa_location?.url_for_pdf || data.best_oa_location?.url;
    const tags: RefTag[] = data.is_oa
      ? [{ text: "OA", color: "#00b8a9", tip: data.oa_status, url: oaUrl }]
      : [];

    return {
      identifiers,
      authors,
      title: cleanText(data.title),
      year: data.year != null ? String(data.year) : undefined,
      type: TYPE_MAP[data.genre] || "journalArticle",
      primaryVenue: data.journal_name,
      source: "unpaywall",
      publishDate: data.published_date,
      oaUrl,
      tags: tags.length ? tags : undefined,
    };
  },
};
