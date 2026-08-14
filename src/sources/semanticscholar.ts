import { identifiersToURL } from "../core/text";
import type {
  Identifiers,
  MetaSource,
  PagedRefs,
  RefItem,
  RefTag,
} from "../core/types";
import { http } from "../core/http";
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
      color: "#1857b6",
      tip: "citationCount",
    });
  }
  return {
    identifiers,
    title: data.title,
    abstract: data.abstract,
    year: data.year != null ? String(data.year) : undefined,
    publishDate: data.publicationDate,
    authors: (data.authors || []).map((a: any) => a.name),
    primaryVenue: data.venue,
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
    `${GRAPH_API}/paper/${pid}?fields=${FIELDS}`,
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
  const url = `${GRAPH_API}/paper/${pid}/references?fields=${fields}&limit=1000`;
  const res = await http.getJSON<any>(url, { headers: authHeaders() });
  const data: any[] = res?.data || [];
  const refs: RefItem[] = [];
  let idx = 0;
  for (const entry of data) {
    if (!entry?.citedPaper) continue;
    idx++;
    const item = mapPaper(entry.citedPaper);
    item.number = idx;
    const contexts: string[] = entry.contexts || [];
    const intents: string[] = entry.intents || [];
    if (contexts.length) {
      item.description = `${intents[0] || "unknown"}: ${contexts[0]}`;
    }
    refs.push(item);
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
  const url = `${GRAPH_API}/paper/${pid}/citations?offset=${offset}&limit=${limit}&fields=${FIELDS}`;
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
  const url = `${RECOMMENDATIONS_API}/papers/forpaper/${pid}?fields=${fields}&limit=${limit}`;
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
