import { getPref } from "../utils/prefs";
import { cleanText } from "../core/text";
import { http } from "../core/http";
import { relatedLimit, withRelatedRank } from "../core/related";
import { CITED_CHIP_COLOR } from "../core/types";
import { getString } from "../utils/locale";
import type {
  Identifiers,
  MetaSource,
  PagedRefs,
  RefItem,
  RefTag,
} from "../core/types";

/**
 * OpenAlex (api.openalex.org) — fully open scholarly catalog. Basic queries work without a key; an optional API key raises
 * the account budget. The historical mailto polite pool is no longer used.
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

/** Keep API keys in a header, out of URLs and URL-based debug messages. */
function getJSON(url: string) {
  const key = String(getPref("openAlexApiKey") || "").trim();
  return http.getJSON<any>(
    url,
    key ? { headers: { Authorization: `Bearer ${key}` } } : {},
  );
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
    ? w.authorships
        .map((a: any) => cleanText(a.author?.display_name))
        .filter(Boolean)
    : [];
  // List endpoints cap the byline at 100; the cap's final author still has
  // author_position=middle. Never promote that member to a last-author claim.
  const authorsTruncated =
    w.is_authors_truncated === true ||
    (Array.isArray(w.authorships) &&
      (authors.length !== w.authorships.length ||
        (w.authorships.length >= 100 &&
          !w.authorships.some((a: any) => a.author_position === "last"))));
  // Only an explicit flag establishes correspondence. author_position=last
  // is a byline position and must never become a corresponding-author claim.
  const correspondingAuthors: string[] = Array.isArray(w.authorships)
    ? w.authorships
        .filter((a: any) => a.is_corresponding === true)
        .map((a: any) => cleanText(a.author?.display_name))
        .filter(Boolean)
    : [];

  const citationCount =
    typeof w.cited_by_count === "number" ? w.cited_by_count : undefined;
  const tags: RefTag[] =
    citationCount && citationCount > 0
      ? [
          {
            text: citationCount,
            color: CITED_CHIP_COLOR,
            tip: getString("tag-cited-tip", { args: { source: "OpenAlex" } }),
          },
        ]
      : [];

  const oaUrl: string | undefined = w.open_access?.oa_url || undefined;
  const url = doi ? `https://doi.org/${doi}` : w.id;

  return {
    identifiers,
    title: cleanText(w.title || w.display_name),
    authors,
    authorsTruncated: authorsTruncated || undefined,
    correspondingAuthors: correspondingAuthors.length
      ? correspondingAuthors
      : undefined,
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
  if (ids.openAlex) return `${BASE}/works/${encodeURIComponent(ids.openAlex)}`;
  if (ids.DOI)
    return `${BASE}/works/https://doi.org/${encodeURIComponent(ids.DOI)}`;
  if (ids.PMID) return `${BASE}/works/pmid:${encodeURIComponent(ids.PMID)}`;
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
  const url = `${path}?select=${FULL_SELECT}`;
  const w = await getJSON(url);
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
      `${BASE}/works?filter=openalex_id:${batch.join(
        "|",
      )}&per-page=50&select=${select}`,
    );
  }
  // pages in parallel — the per-host gate already bounds concurrency
  const pages = await Promise.all(urls.map((u) => getJSON(u)));
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
  getRelated(
    ids: Identifiers,
    limit?: number,
    shouldContinue?: () => boolean,
  ): Promise<RefItem[] | null>;
} = {
  id: "openalex",

  async getInfoByDOI(doi: string): Promise<RefItem | null> {
    const url = `${BASE}/works/https://doi.org/${encodeURIComponent(doi)}?select=${SELECT}`;
    const w = await getJSON(url);
    if (!w || !w.id) return null;
    return mapWork(w);
  },

  async getInfoByPMID(pmid: string): Promise<RefItem | null> {
    const url = `${BASE}/works/pmid:${encodeURIComponent(pmid)}?select=${SELECT}`;
    const w = await getJSON(url);
    if (!w || !w.id) return null;
    return mapWork(w);
  },

  async getInfoByTitle(title: string): Promise<RefItem | null> {
    const cleaned = title.replace(/,/g, "");
    const url = `${BASE}/works?filter=title.search:${encodeURIComponent(
      cleaned,
    )}&per-page=3&select=${SELECT}`;
    const res = await getJSON(url);
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
    const url =
      `${BASE}/works?filter=cites:${wid}&per-page=${limit}&page=${page}` +
      `&sort=cited_by_count:desc&select=${SELECT}`;
    const res = await getJSON(url);
    const results: any[] = res?.results;
    if (!Array.isArray(results)) return null;
    const items = results.map((w) => mapWork(w));
    return {
      items,
      total: res?.meta?.count,
      nextOffset: items.length ? offset + items.length : undefined,
    };
  },

  async getRelated(
    ids: Identifiers,
    limit = 40,
    shouldContinue: () => boolean = () => true,
  ): Promise<RefItem[] | null> {
    const path = workPathFromIds(ids);
    if (!path || !shouldContinue()) return null;
    const bounded = relatedLimit(limit);
    // Keep the raw list: hydrating fewer works must not renumber later ranks.
    const full = await getJSON(`${path}?select=id,related_works`);
    if (!shouldContinue() || !full?.id || !Array.isArray(full.related_works))
      return null;
    const ranked = full.related_works
      .slice(0, bounded)
      .map((id: unknown, index: number) => ({
        wid: typeof id === "string" ? bareId(id) : undefined,
        rank: index + 1,
      }))
      .filter(
        (entry: { wid?: string }) => entry.wid && /^W\d+$/.test(entry.wid),
      );
    if (!ranked.length) return full.related_works.length ? null : [];
    if (!shouldContinue()) return null;
    const wids = [
      ...new Set(ranked.map((entry: { wid: string }) => entry.wid)),
    ];
    const result = await getJSON(
      `${BASE}/works?filter=openalex_id:${wids.join("|")}&per-page=${bounded}&select=${SELECT}`,
    );
    if (!shouldContinue() || !Array.isArray(result?.results)) return null;
    const batch = new Map<string, RefItem>();
    for (const work of result.results.slice(0, bounded)) {
      if (typeof work?.id !== "string") continue;
      const wid = bareId(work.id);
      if (!wid || !wids.includes(wid) || batch.has(wid)) continue;
      try {
        batch.set(wid, mapWork(work));
      } catch (error) {
        ztoolkit.log("[openalex] invalid related record", error);
      }
    }
    const refs: RefItem[] = [];
    for (const { wid, rank } of ranked) {
      const hit = batch.get(wid);
      if (hit) refs.push(withRelatedRank(hit, rank));
    }
    // A known non-empty recommendation list with no hydrated records is not
    // evidence that the provider has no recommendations.
    return refs.length ? refs : null;
  },
};
