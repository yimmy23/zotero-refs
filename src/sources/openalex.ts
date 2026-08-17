import { cleanText } from "../core/text";
import { http, politeEmail } from "../core/http";
import type {
  Identifiers,
  MetaSource,
  PagedRefs,
  RefItem,
  RefTag,
} from "../core/types";

/**
 * OpenAlex (api.openalex.org) — fully open scholarly catalog. Free, no key
 * required; a `mailto` param buys access to the "polite pool".
 *
 * Work ids are stored bare (e.g. "W2741809807", no URL prefix) in
 * `identifiers.openAlex`.
 */

const BASE = "https://api.openalex.org";

const SELECT =
  "id,doi,title,display_name,publication_year,publication_date," +
  "authorships,primary_location,cited_by_count,ids,open_access," +
  "abstract_inverted_index,type,is_retracted";
const FULL_SELECT = `${SELECT},referenced_works,related_works`;
/**
 * Lean projection for graph-node hydration: no abstracts / institutions /
 * locations (a graph node shows title · year · citations, nothing more).
 * Cuts the payload of a 200-reference hydration by roughly an order of
 * magnitude.
 */
const GRAPH_SELECT =
  "id,doi,title,display_name,publication_year,authorships,cited_by_count,ids,type,is_retracted";

const TYPE_MAP: Record<string, string> = {
  article: "journalArticle",
  preprint: "preprint",
  book: "book",
  "book-chapter": "bookSection",
  dissertation: "thesis",
};

function withMailto(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}mailto=${encodeURIComponent(politeEmail())}`;
}

/** "https://openalex.org/W123..." -> "W123..." (also passes bare ids through) */
function bareId(id?: string): string | undefined {
  if (!id) return undefined;
  const parts = id.split("/");
  return parts[parts.length - 1] || undefined;
}

/** "https://doi.org/10.x/y" -> "10.x/y" */
function stripDOI(doi?: string): string | undefined {
  if (!doi) return undefined;
  return doi.replace(/^https?:\/\/doi\.org\//i, "");
}

/** "https://pubmed.ncbi.nlm.nih.gov/12345678" -> "12345678" */
function extractPMID(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/(\d+)\/?$/);
  return m ? m[1] : undefined;
}

/** Rebuild plaintext abstract from OpenAlex's inverted-index encoding. */
function reconstructAbstract(
  inverted?: Record<string, number[]>,
): string | undefined {
  if (!inverted) return undefined;
  const positions: Array<[number, string]> = [];
  for (const word in inverted) {
    for (const pos of inverted[word]) {
      positions.push([pos, word]);
    }
  }
  if (!positions.length) return undefined;
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map((p) => p[1]).join(" ");
}

function mapWork(w: any): RefItem {
  const openAlexId = bareId(w.id);
  const doi = stripDOI(w.doi);
  const pmid = extractPMID(w.ids?.pmid);

  const identifiers: Identifiers = {};
  if (openAlexId) identifiers.openAlex = openAlexId;
  if (doi) identifiers.DOI = doi;
  if (pmid) identifiers.PMID = pmid;

  const authors: string[] = Array.isArray(w.authorships)
    ? w.authorships.map((a: any) => a.author?.display_name).filter(Boolean)
    : [];

  const citationCount =
    typeof w.cited_by_count === "number" ? w.cited_by_count : undefined;
  const tags: RefTag[] =
    citationCount && citationCount > 0
      ? [{ text: citationCount, color: "#e8710a", tip: "cited_by_count" }]
      : [];

  const oaUrl: string | undefined = w.open_access?.oa_url || undefined;
  const url = doi ? `https://doi.org/${doi}` : w.id;

  return {
    identifiers,
    title: cleanText(w.display_name),
    authors,
    year: w.publication_year != null ? String(w.publication_year) : undefined,
    publishDate: w.publication_date,
    primaryVenue: cleanText(w.primary_location?.source?.display_name),
    citationCount,
    tags: tags.length ? tags : undefined,
    oaUrl,
    url,
    abstract: reconstructAbstract(w.abstract_inverted_index),
    retracted: w.is_retracted === true ? true : undefined,
    source: "openalex",
    type: TYPE_MAP[w.type] || "journalArticle",
  };
}

/** work.id -> full REST path used for /works/{id} single-work lookups */
function workPathFromIds(ids: Identifiers): string | undefined {
  if (ids.openAlex) return `${BASE}/works/${ids.openAlex}`;
  if (ids.DOI) return `${BASE}/works/https://doi.org/${ids.DOI}`;
  if (ids.PMID) return `${BASE}/works/pmid:${ids.PMID}`;
  return undefined;
}

/** A hydrated OpenAlex work plus its referenced/related work ids. */
export interface OAWork {
  ref: RefItem;
  referencedWorks: string[];
  relatedWorks: string[];
}

/** Fetch a work (by openAlex/DOI/PMID id) with its full graph edges. */
export async function getWorkFull(ids: Identifiers): Promise<OAWork | null> {
  const path = workPathFromIds(ids);
  if (!path) return null;
  const url = withMailto(`${path}?select=${FULL_SELECT}`);
  const w = await http.getJSON(url);
  if (!w || !w.id) return null;
  return {
    ref: mapWork(w),
    referencedWorks: Array.isArray(w.referenced_works)
      ? (w.referenced_works
          .map((u: string) => bareId(u))
          .filter(Boolean) as string[])
      : [],
    relatedWorks: Array.isArray(w.related_works)
      ? (w.related_works
          .map((u: string) => bareId(u))
          .filter(Boolean) as string[])
      : [],
  };
}

/**
 * Hydrate a list of bare OpenAlex work ids in batches of 50 (OpenAlex's
 * per-page ceiling for the `openalex_id:` OR filter).
 */
export async function getWorksBatch(
  wids: string[],
  withRefs = false,
  opts: { lean?: boolean } = {},
): Promise<Map<string, { ref: RefItem; referencedWorks: string[] }>> {
  const result = new Map<string, { ref: RefItem; referencedWorks: string[] }>();
  const base = opts.lean ? GRAPH_SELECT : SELECT;
  const select = withRefs ? `${base},referenced_works` : base;
  const urls: string[] = [];
  for (let i = 0; i < wids.length; i += 50) {
    const batch = wids.slice(i, i + 50).filter(Boolean);
    if (!batch.length) continue;
    urls.push(
      withMailto(
        `${BASE}/works?filter=openalex_id:${batch.join(
          "|",
        )}&per-page=50&select=${select}`,
      ),
    );
  }
  // pages in parallel — the per-host gate already bounds concurrency
  const pages = await Promise.all(urls.map((u) => http.getJSON(u)));
  for (const res of pages) {
    const results: any[] = res?.results;
    if (!Array.isArray(results)) continue;
    for (const w of results) {
      const id = bareId(w.id);
      if (!id) continue;
      result.set(id, {
        ref: mapWork(w),
        referencedWorks:
          withRefs && Array.isArray(w.referenced_works)
            ? (w.referenced_works
                .map((u: string) => bareId(u))
                .filter(Boolean) as string[])
            : [],
      });
    }
  }
  return result;
}

export const openalex: MetaSource & {
  getInfoByDOI(doi: string): Promise<RefItem | null>;
  getInfoByPMID(pmid: string): Promise<RefItem | null>;
  getInfoByTitle(title: string, refText?: string): Promise<RefItem | null>;
  getReferences(ids: Identifiers): Promise<RefItem[] | null>;
  getCitations(
    ids: Identifiers,
    offset?: number,
    limit?: number,
  ): Promise<PagedRefs | null>;
  getRelated(ids: Identifiers, limit?: number): Promise<RefItem[] | null>;
} = {
  id: "openalex",

  async getInfoByDOI(doi: string): Promise<RefItem | null> {
    const url = withMailto(
      `${BASE}/works/https://doi.org/${doi}?select=${SELECT}`,
    );
    const w = await http.getJSON(url);
    if (!w || !w.id) return null;
    return mapWork(w);
  },

  async getInfoByPMID(pmid: string): Promise<RefItem | null> {
    const url = withMailto(`${BASE}/works/pmid:${pmid}?select=${SELECT}`);
    const w = await http.getJSON(url);
    if (!w || !w.id) return null;
    return mapWork(w);
  },

  async getInfoByTitle(title: string): Promise<RefItem | null> {
    const cleaned = title.replace(/,/g, "");
    const url = withMailto(
      `${BASE}/works?filter=title.search:${encodeURIComponent(
        cleaned,
      )}&per-page=3&select=${SELECT}`,
    );
    const res = await http.getJSON(url);
    const results: any[] = res?.results;
    if (!Array.isArray(results) || !results.length) return null;
    return mapWork(results[0]);
  },

  async getReferences(ids: Identifiers): Promise<RefItem[] | null> {
    const full = await getWorkFull(ids);
    if (!full || !full.referencedWorks.length) return null;
    const batch = await getWorksBatch(full.referencedWorks);
    const refs: RefItem[] = full.referencedWorks.map((wid, index) => {
      const hit = batch.get(wid);
      const ref: RefItem = hit
        ? { ...hit.ref }
        : { identifiers: { openAlex: wid }, authors: [] };
      ref.number = index + 1;
      const firstAuthor = ref.authors?.[0];
      ref.text = firstAuthor
        ? `${firstAuthor} et al., ${ref.year || "n.d."}, ${ref.title || ""}`
        : `${ref.year || "n.d."}, ${ref.title || ""}`;
      return ref;
    });
    return refs;
  },

  async getCitations(
    ids: Identifiers,
    offset = 0,
    limit = 25,
  ): Promise<PagedRefs | null> {
    let wid = ids.openAlex;
    if (!wid) {
      const full = await getWorkFull(ids);
      wid = full?.ref.identifiers.openAlex;
    }
    if (!wid) return null;
    const page = Math.floor(offset / limit) + 1;
    const url = withMailto(
      `${BASE}/works?filter=cites:${wid}&per-page=${limit}&page=${page}` +
        `&sort=cited_by_count:desc&select=${SELECT}`,
    );
    const res = await http.getJSON(url);
    const results: any[] = res?.results;
    if (!Array.isArray(results)) return null;
    const items = results.map((w) => mapWork(w));
    return {
      items,
      total: res?.meta?.count,
      nextOffset: items.length ? offset + items.length : undefined,
    };
  },

  async getRelated(ids: Identifiers, limit = 20): Promise<RefItem[] | null> {
    const full = await getWorkFull(ids);
    if (!full || !full.relatedWorks.length) return null;
    const wids = full.relatedWorks.slice(0, limit);
    const batch = await getWorksBatch(wids);
    const refs: RefItem[] = [];
    for (const wid of wids) {
      const hit = batch.get(wid);
      if (hit) refs.push(hit.ref);
    }
    return refs.length ? refs : null;
  },
};
