import { identifiersToURL, cleanText } from "../core/text";
import type {
  Identifiers,
  MetaSource,
  PagedRefs,
  RefItem,
  RefTag,
} from "../core/types";
import { http } from "../core/http";
import { CITED_CHIP_COLOR } from "../core/types";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";

/**
 * Semantic Scholar — official Graph API.
 * https://api.semanticscholar.org/api-docs/graph
 *
 * Note: the *private* www.semanticscholar.org/api/1 endpoints used by the
 * original zotero-reference plugin are dead; this module talks only to the
 * public Graph API (+ the public recommendations API for "related works").
 */

const GRAPH_API = "https://api.semanticscholar.org/graph/v1";
const RECOMMENDATIONS_API =
  "https://api.semanticscholar.org/recommendations/v1";

const FIELDS =
  "title,abstract,year,authors,externalIds,venue,publicationDate," +
  "citationCount,referenceCount,openAccessPdf,publicationTypes";

/** the fields used for the references/citations "cited/citing paper" sub-object */
const REFERENCE_FIELDS = FIELDS.replace("referenceCount,", "");
const REFERENCE_PAGE_SIZE = 1000;
const MAX_REFERENCE_PAGES = 20;

function authHeaders(): Record<string, string> {
  const key = ((getPref("s2ApiKey") as string) || "").trim();
  return key ? { "x-api-key": key } : {};
}

/**
 * Builds a Semantic Scholar paper id from whatever identifier we have.
 * Prefers the raw s2 paperId (fastest, no cross-reference lookup needed).
 */
function pidFromIdentifiers(ids: Identifiers): string | null {
  if (ids.s2) return ids.s2;
  if (ids.DOI) return `DOI:${ids.DOI}`;
  if (ids.arXiv) return `arXiv:${ids.arXiv}`;
  if (ids.PMID) return `PMID:${ids.PMID}`;
  return null;
}

function mapType(data: any, identifiers: Identifiers): string {
  const types: string[] = data.publicationTypes || [];
  let type = "journalArticle";
  if (types.includes("JournalArticle")) type = "journalArticle";
  else if (types.includes("Conference")) type = "conferencePaper";
  // an arXiv-only record (no DOI) reads as a preprint regardless of the
  // publicationTypes S2 reports for it.
  if (identifiers.arXiv && !identifiers.DOI) type = "preprint";
  return type;
}

function mapPaper(data: any): RefItem {
  const identifiers: Identifiers = {
    s2: data.paperId,
    DOI: data.externalIds?.DOI,
    arXiv: data.externalIds?.ArXiv,
    PMID: data.externalIds?.PubMed,
  };
  const tags: (RefTag | string)[] = [];
  if (data.citationCount && data.citationCount > 0) {
    tags.push({
      text: data.citationCount,
      color: CITED_CHIP_COLOR,
      tip: getString("tag-cited-tip", {
        args: { source: "Semantic Scholar" },
      }),
    });
  }
  return {
    identifiers,
    title: cleanText(data.title),
    abstract: data.abstract,
    year: data.year != null ? String(data.year) : undefined,
    publishDate: data.publicationDate,
    authors: (data.authors || []).map((a: any) => a.name),
    primaryVenue: cleanText(data.venue),
    citationCount: data.citationCount,
    referenceCount: data.referenceCount,
    oaUrl: data.openAccessPdf?.url,
    url:
      identifiersToURL(identifiers) ||
      (data.paperId
        ? `https://www.semanticscholar.org/paper/${data.paperId}`
        : undefined),
    source: "semanticscholar",
    type: mapType(data, identifiers),
    tags,
  };
}

async function fetchByPid(pid: string): Promise<RefItem | null> {
  const data = await http.getJSON<any>(
    `${GRAPH_API}/paper/${encodeURIComponent(pid)}?fields=${FIELDS}`,
    { headers: authHeaders() },
  );
  if (!data) return null;
  return mapPaper(data);
}

async function getInfoByDOI(doi: string): Promise<RefItem | null> {
  return fetchByPid(`DOI:${doi}`);
}

async function getInfoByArXiv(arxiv: string): Promise<RefItem | null> {
  return fetchByPid(`arXiv:${arxiv}`);
}

async function getInfoByPMID(pmid: string): Promise<RefItem | null> {
  return fetchByPid(`PMID:${pmid}`);
}

async function firstFromList(url: string): Promise<any | null> {
  const res = await http.getJSON<any>(url, { headers: authHeaders() });
  return res?.data?.[0] || null;
}

async function getInfoByTitle(
  title: string,
  _refText?: string,
): Promise<RefItem | null> {
  const matchUrl = `${GRAPH_API}/paper/search/match?query=${encodeURIComponent(title)}&fields=${FIELDS}`;
  let data = await firstFromList(matchUrl);
  if (!data) {
    const searchUrl = `${GRAPH_API}/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=${FIELDS}`;
    data = await firstFromList(searchUrl);
  }
  if (!data) return null;
  return mapPaper(data);
}

async function getReferences(
  ids: Identifiers,
  _title?: string,
): Promise<RefItem[] | null> {
  const pid = pidFromIdentifiers(ids);
  if (!pid) return null;
  const fields = `${REFERENCE_FIELDS},contexts,intents`;
  const url = `${GRAPH_API}/paper/${encodeURIComponent(pid)}/references?fields=${fields}&limit=${REFERENCE_PAGE_SIZE}`;
  const refs: RefItem[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < MAX_REFERENCE_PAGES; page++) {
    // Each page uses the shared cache, in-flight deduplication and host gate.
    const res = await http.getJSON<any>(`${url}&offset=${offset}`, {
      headers: authHeaders(),
    });
    if (!Array.isArray(res?.data) || !res.data.length) break;
    const before = refs.length;
    for (const entry of res.data) {
      if (!entry?.citedPaper) continue;
      const item = mapPaper(entry.citedPaper);
      const keys = Object.entries(item.identifiers).flatMap(([name, value]) =>
        typeof value === "string" && value.trim()
          ? [`${name}:${value.trim().toLowerCase()}`]
          : [],
      );
      // Identifier-free entries need a stable fallback without collapsing
      // distinct, identified papers that happen to share a title.
      if (!keys.length && item.title) {
        keys.push(
          `title:${JSON.stringify([item.title.normalize("NFKC").toLowerCase(), item.year || "", item.authors || []])}`,
        );
      }
      if (!keys.length) continue;
      const duplicate = keys.some((key) => seen.has(key));
      for (const key of keys) seen.add(key);
      if (duplicate) continue;
      item.number = refs.length + 1;
      const contexts: string[] = entry.contexts || [];
      const intents: string[] = entry.intents || [];
      if (contexts.length) {
        item.description = `${intents[0] || "unknown"}: ${contexts[0]}`;
      }
      refs.push(item);
    }
    const next = res.next;
    if (next == null) break;
    // Reject looping/invalid cursors and repeated pages, even when a broken
    // endpoint keeps claiming that more data is available.
    if (
      !Number.isSafeInteger(next) ||
      next <= offset ||
      refs.length === before
    ) {
      ztoolkit.log("[s2] stopped reference pagination without progress");
      break;
    }
    if (page === MAX_REFERENCE_PAGES - 1) {
      ztoolkit.log("[s2] reached reference pagination limit", refs.length);
    }
    offset = next;
  }
  return refs.length ? refs : null;
}

async function getCitations(
  ids: Identifiers,
  offset = 0,
  limit = 25,
): Promise<PagedRefs | null> {
  const pid = pidFromIdentifiers(ids);
  if (!pid) return null;
  const url = `${GRAPH_API}/paper/${encodeURIComponent(pid)}/citations?offset=${offset}&limit=${limit}&fields=${FIELDS}`;
  const res = await http.getJSON<any>(url, { headers: authHeaders() });
  if (!res?.data) return null;
  const items: RefItem[] = res.data
    .filter((entry: any) => entry?.citingPaper)
    .map((entry: any) => mapPaper(entry.citingPaper));
  return { items, nextOffset: res.next, total: undefined };
}

async function getRelated(
  ids: Identifiers,
  limit = 20,
): Promise<RefItem[] | null> {
  const pid = pidFromIdentifiers(ids);
  if (!pid) return null;
  const fields = "title,year,authors,abstract,externalIds,venue,citationCount";
  const url = `${RECOMMENDATIONS_API}/papers/forpaper/${encodeURIComponent(pid)}?fields=${fields}&limit=${limit}`;
  const res = await http.getJSON<any>(url, { headers: authHeaders() });
  const list: any[] = res?.recommendedPapers || [];
  if (!list.length) return null;
  return list.map((item: any) => mapPaper(item));
}

export const semanticscholar: MetaSource = {
  id: "semanticscholar",
  getInfoByDOI,
  getInfoByArXiv,
  getInfoByPMID,
  getInfoByTitle,
  getReferences,
  getCitations,
  getRelated,
};
