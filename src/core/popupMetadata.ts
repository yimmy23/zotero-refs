import { cleanText, identifiersConflict, isHttpUrl, titlesMatch } from "./text";
import { normalizeAbstractText } from "./abstractText";
import {
  CITED_CHIP_COLOR,
  REFCOUNT_CHIP_COLOR,
  type Identifiers,
  type RefItem,
  type RefTag,
  type SourceID,
} from "./types";

/** Metadata from one lookup. Library records must be identity-checked too. */
export interface PopupCandidate {
  info: RefItem;
  kind: "library" | "remote";
}

export interface PopupMetadata {
  info: RefItem;
  content: string;
  contentKind: "abstract" | "citation";
  abstractSource?: string;
  citationSource?: string;
  referenceSource?: string;
  firstAuthors: string[];
  firstAuthorsByOrder: boolean;
  correspondingAuthors: string[];
  lastAuthors: string[];
  sources: Array<{ source: string; url?: string }>;
}

/** Navigation order is separate from metrics, tags, and source provenance. */
export function popupLinks(info: RefItem): Array<{
  kind: "pdf" | "doi" | "pubmed" | "scholar" | "zotero";
  url?: string;
  itemID?: number;
}> {
  const links: ReturnType<typeof popupLinks> = [];
  const ids = info.identifiers || {};
  const pdf = popupURL(info.oaUrl);
  if (pdf) links.push({ kind: "pdf", url: pdf });
  const doi = ids.DOI && normalizedID("DOI", ids.DOI);
  const paper = doi
    ? `https://doi.org/${encodeURIComponent(doi)}`
    : ids.arXiv
      ? `https://arxiv.org/abs/${encodeURIComponent(ids.arXiv)}`
      : popupURL(ids.CNKI) || popupURL(info.url);
  if (paper && paper !== pdf) links.push({ kind: "doi", url: paper });
  if (/^\d+$/.test(ids.PMID || ""))
    links.push({
      kind: "pubmed",
      url: `https://pubmed.ncbi.nlm.nih.gov/${ids.PMID}/`,
    });
  const title = cleanText(info.title);
  if (title)
    links.push({
      kind: "scholar",
      url: `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`,
    });
  if (Number.isSafeInteger(info.libItemID) && info.libItemID! > 0)
    links.push({ kind: "zotero", itemID: info.libItemID });
  return links;
}

// Fixed preference order, never promise resolution order. Registered/curated
// records win descriptive fields; citation counts have their own stable order.
const ORDER: SourceID[] = [
  "pubmed",
  "crossref",
  "arxiv",
  "cnki",
  "semanticscholar",
  "openalex",
  "readpaper",
  "unpaywall",
  "connectedpapers",
];
const COUNT_ORDER: SourceID[] = [
  "semanticscholar",
  "openalex",
  "crossref",
  "readpaper",
  "connectedpapers",
];

/** An absolute, parseable HTTP(S) URL, never an OS protocol handler. */
export function popupURL(value?: string): string | undefined {
  if (!isHttpUrl(value)) return undefined;
  try {
    const url = new URL(value);
    return url.hostname && /^(https?:)$/.test(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizedID(key: string, value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
  return key === "arXiv" ? normalized.replace(/v\d+$/, "") : normalized;
}

/** A matching identifier is stronger than title spelling; a conflict vetoes. */
export function samePopupPaper(
  reference: RefItem,
  candidate: RefItem,
  titleSearch = false,
): boolean {
  const a = reference.identifiers || {};
  const b = candidate.identifiers || {};
  if (identifiersConflict(a, b)) return false;
  const exactTitle = titlesMatch(reference.title, candidate.title);
  if (titleSearch) return exactTitle;
  return (
    ["DOI", "PMID", "arXiv", "openAlex", "s2"].some(
      (key) =>
        a[key] &&
        b[key] &&
        normalizedID(key, a[key]!) === normalizedID(key, b[key]!),
    ) || exactTitle
  );
}

function names(values?: string[], unique = true): string[] {
  const cleaned = (values || [])
    .map((value) => cleanText(value))
    .filter(Boolean);
  return unique ? [...new Set(cleaned)] : cleaned;
}

function rank(candidate: PopupCandidate): number {
  if (candidate.kind === "library") return -2;
  const index = ORDER.indexOf(candidate.info.source!);
  return index < 0 ? ORDER.length : index;
}

function sortKey(candidate: PopupCandidate): string {
  // Stable even if two responses have the same source, without depending on
  // property insertion order in an API payload.
  const i = candidate.info;
  return JSON.stringify([
    i.source,
    Object.entries(i.identifiers || {}).sort(),
    i.title,
    i.authors,
    i.publishDate,
    i.year,
    i.abstract,
    i.primaryVenue,
    i.url,
    i.oaUrl,
    i.citationCount,
    i.referenceCount,
    i.firstAuthors,
    i.correspondingAuthors,
  ]);
}

function sourceName(candidate: PopupCandidate): string {
  return candidate.kind === "library"
    ? "zotero"
    : candidate.info.source || "pdf";
}

function sourceURL(source: string, info: RefItem): string | undefined {
  const ids = info.identifiers || {};
  const doi = ids.DOI && normalizedID("DOI", ids.DOI);
  if (source === "crossref" && doi)
    return `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  if (source === "semanticscholar" && ids.s2)
    return `https://www.semanticscholar.org/paper/${encodeURIComponent(ids.s2)}`;
  if (source === "openalex" && ids.openAlex)
    return `https://openalex.org/${encodeURIComponent(ids.openAlex.replace(/^https?:\/\/openalex\.org\//i, ""))}`;
  if (source === "pubmed" && /^\d+$/.test(ids.PMID || ""))
    return `https://pubmed.ncbi.nlm.nih.gov/${ids.PMID}/`;
  if (source === "arxiv" && ids.arXiv)
    return `https://arxiv.org/abs/${encodeURIComponent(ids.arXiv)}`;
  if (source === "cnki") return popupURL(ids.CNKI || info.url);
  if (source === "readpaper") return popupURL(info.url);
  return undefined;
}

function metric(info: RefItem, field: "citationCount" | "referenceCount") {
  const value = info[field];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.floor(value);
  // Some older mappers supplied counts only as typed/color-coded tags.
  const color =
    field === "citationCount" ? CITED_CHIP_COLOR : REFCOUNT_CHIP_COLOR;
  const tag = info.tags?.find(
    (t) =>
      typeof t === "object" &&
      t.color === color &&
      typeof t.text === "number" &&
      Number.isFinite(t.text) &&
      t.text >= 0,
  );
  return tag && typeof tag === "object"
    ? Math.floor(Number(tag.text))
    : undefined;
}

/**
 * Recompute a single paper card from all resolved sources. No abstract is
 * concatenated, no count is summed, and library IDs never come from a cache.
 */
export function mergePopupMetadata(
  reference: RefItem,
  candidates: PopupCandidate[],
  titleSearch = false,
): PopupMetadata {
  const ordered = candidates
    .filter((candidate) =>
      samePopupPaper(reference, candidate.info, titleSearch),
    )
    .sort((a, b) => rank(a) - rank(b) || sortKey(a).localeCompare(sortKey(b)));
  const ids: Identifiers = { ...reference.identifiers };
  const accepted: PopupCandidate[] = [];
  for (const candidate of ordered) {
    if (identifiersConflict(ids, candidate.info.identifiers || {})) continue;
    accepted.push(candidate);
    for (const [key, value] of Object.entries(
      candidate.info.identifiers || {},
    )) {
      if (!ids[key] && value && (key !== "CNKI" || popupURL(value)))
        ids[key] = value;
    }
  }
  if (ids.CNKI && !popupURL(ids.CNKI)) delete ids.CNKI;
  const base: PopupCandidate = { info: reference, kind: "remote" };
  // A fused/API reference already has structured metadata. A PDF-only parse
  // remains the last resort; it must not outrank later authoritative records.
  const all = [...accepted, base].sort((a, b) => {
    const aRank =
      a === base && (!reference.source || reference.source === "pdf")
        ? ORDER.length + 1
        : rank(a);
    const bRank =
      b === base && (!reference.source || reference.source === "pdf")
        ? ORDER.length + 1
        : rank(b);
    return (
      aRank - bRank ||
      (a === base ? 1 : b === base ? -1 : sortKey(a).localeCompare(sortKey(b)))
    );
  });
  const field = (key: "title" | "primaryVenue" | "type" | "description") =>
    all.map((c) => cleanText(c.info[key])).find(Boolean);
  const authors =
    all.map((c) => names(c.info.authors, false)).find((a) => a.length) || [];
  const date = all.find((c) => c.info.publishDate || c.info.year)?.info;
  const abstractText = (candidate: PopupCandidate) =>
    candidate.kind === "library"
      ? normalizeAbstractText(candidate.info.abstract || "")
      : candidate.info.abstract?.trim();
  const abstract = all
    .filter((c) => abstractText(c))
    .sort((a, b) => {
      // A curated library abstract always wins. Otherwise prefer a complete
      // source over an explicitly clipped one, then the fixed source order.
      if (a.kind === "library" || b.kind === "library")
        return rank(a) - rank(b);
      const clipped = (c: PopupCandidate) =>
        /(?:…|\.\.\.)\s*$/.test(c.info.abstract || "") ? 1 : 0;
      return (
        clipped(a) - clipped(b) ||
        rank(a) - rank(b) ||
        sortKey(a).localeCompare(sortKey(b))
      );
    })[0];
  const counter = (key: "citationCount" | "referenceCount") =>
    all
      .filter((c) => c.kind !== "library" && metric(c.info, key) !== undefined)
      .sort((a, b) => {
        const order = (c: PopupCandidate) => {
          const i = COUNT_ORDER.indexOf(c.info.source!);
          return i < 0 ? COUNT_ORDER.length : i;
        };
        return order(a) - order(b) || sortKey(a).localeCompare(sortKey(b));
      })[0];
  const citation = counter("citationCount");
  const references = counter("referenceCount");
  const explicitFirst = all
    .map((c) => names(c.info.firstAuthors))
    .find((a) => a.length);
  const correspondingAuthors =
    all.map((c) => names(c.info.correspondingAuthors)).find((a) => a.length) ||
    [];
  const abbreviatedByline = authors.some((author) =>
    /\bet\s+al\b|\band\s+others\b|等(?:人)?[。.]?$|…|\.\.\./i.test(author),
  );
  const firstAuthors =
    explicitFirst ||
    authors
      .slice(0, 1)
      .map((author) =>
        author.replace(/\s*\bet\s+al\.?$|\s*等(?:人)?[。.]?$/i, "").trim(),
      )
      .filter(Boolean);
  const lastAuthors =
    correspondingAuthors.length || authors.length < 2 || abbreviatedByline
      ? []
      : authors.slice(-1);
  // Keep keywords/library tags, but counts and source/navigation chips are
  // assembled separately so their meaning and order cannot change by source.
  const tags: RefTag[] = [];
  const tagNames = new Set<string>();
  for (const c of all) {
    for (const value of c.info.tags || []) {
      const tag = typeof value === "string" ? { text: value } : value;
      if (
        tag.source ||
        typeof tag.text !== "string" ||
        tag.color === CITED_CHIP_COLOR ||
        tag.color === REFCOUNT_CHIP_COLOR ||
        tag.text === "OA"
      )
        continue;
      const text = cleanText(tag.text);
      if (!text || tagNames.has(text)) continue;
      tagNames.add(text);
      tags.push({ text, color: tag.color, tip: cleanText(tag.tip) });
    }
  }
  const library = accepted.find((c) => c.kind === "library");
  const info: RefItem = {
    identifiers: ids,
    title: field("title"),
    authors,
    firstAuthors: explicitFirst,
    correspondingAuthors: correspondingAuthors.length
      ? correspondingAuthors
      : undefined,
    year: date?.year,
    publishDate: date?.publishDate,
    primaryVenue: field("primaryVenue"),
    type: field("type"),
    description: field("description"),
    abstract: abstract ? abstractText(abstract) : undefined,
    text: reference.text,
    url: all.map((c) => popupURL(c.info.url)).find(Boolean),
    oaUrl: all.map((c) => popupURL(c.info.oaUrl)).find(Boolean),
    libItemID: library?.info.libItemID,
    citationCount: citation
      ? metric(citation.info, "citationCount")
      : undefined,
    referenceCount: references
      ? metric(references.info, "referenceCount")
      : undefined,
    retracted: all.some((c) => c.info.retracted === true) || undefined,
    tags,
  };
  const sourceEntries = new Map<string, { source: string; url?: string }>();
  for (const c of all) {
    const source = sourceName(c);
    if (!sourceEntries.has(source))
      sourceEntries.set(source, { source, url: sourceURL(source, c.info) });
  }
  return {
    info,
    content: info.abstract || cleanText(reference.text) || "",
    contentKind: info.abstract ? "abstract" : "citation",
    abstractSource: abstract ? sourceName(abstract) : undefined,
    citationSource: citation ? sourceName(citation) : undefined,
    referenceSource: references ? sourceName(references) : undefined,
    firstAuthors,
    firstAuthorsByOrder: !explicitFirst,
    correspondingAuthors,
    lastAuthors,
    sources: [...sourceEntries.values()],
  };
}
