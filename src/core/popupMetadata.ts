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
  "europepmc",
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

const ABBREVIATED_BYLINE =
  /\bet\s+al\b|\band\s+others\b|等(?:人)?[。.]?$|…|\.\.\./i;

interface AuthorName {
  family: string;
  given: string[];
}

const familyParticles = new Set([
  "al",
  "bin",
  "da",
  "de",
  "del",
  "den",
  "der",
  "di",
  "dos",
  "la",
  "le",
  "van",
  "von",
]);
const nameWord = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const nameTokens = (value: string) =>
  value.match(/[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*/gu) || [];

/** Parse common given-family, family-initials and family-comma-given forms. */
function authorName(value: string): AuthorName | undefined {
  if (!value || ABBREVIATED_BYLINE.test(value)) return undefined;
  const pieces = value.split(",");
  const tokens = nameTokens(value);
  if (!tokens.length) return undefined;
  const suffixAfterComma = /,\s*(?:Jr|Sr|jr|sr|II|III|IV)\.?\s*$/.test(value);
  // PubMed's surname-first "Molina JR" contains initials, not "Junior".
  // Keep uppercase JR/SR as given-name evidence; recognize suffixes only in
  // a full byline name or an explicit comma-suffix form.
  if (
    (tokens.length > 2 || suffixAfterComma) &&
    /^(?:Jr|Sr|jr|sr|II|III|IV)$/.test(tokens.at(-1) || "")
  )
    tokens.pop();
  if (!tokens.length) return undefined;
  let family: string[], given: string[];
  const initial = (token: string) =>
    /^\p{L}$/u.test(token) || /^[A-Z]{2,3}$/.test(token);
  if (
    pieces.length === 2 &&
    nameTokens(pieces[1]).length &&
    !/^(?:jr|sr|ii|iii|iv)\.?$/i.test(pieces[1].trim())
  ) {
    family = nameTokens(pieces[0]);
    given = nameTokens(pieces[1]);
  } else if (
    tokens.length > 1 &&
    tokens.slice(1).every(initial) &&
    !initial(tokens[0]!)
  ) {
    family = tokens.slice(0, 1);
    given = tokens.slice(1);
  } else {
    let start = tokens.length - 1;
    while (start > 0 && familyParticles.has(nameWord(tokens[start - 1])))
      start--;
    family = tokens.slice(start);
    given = tokens.slice(0, start);
  }
  if (!family.length) return undefined;
  return {
    family: family.map(nameWord).join(" "),
    given: given.flatMap((token) =>
      /^[A-Z]{2,3}$/.test(token) ? [...token].map(nameWord) : [nameWord(token)],
    ),
  };
}

function authorMatching() {
  // One merge can compare several long consortium bylines. Parse each name
  // once, index by surname and reuse alignment checks instead of rescanning
  // every author for each displayed endpoint or explicit-role member.
  const parsed = new Map<string, AuthorName | undefined>();
  const families = new Map<string[], Map<string, string[]>>();
  const alignments = new Map<string[], Map<string[], boolean>>();
  const parse = (name: string) => {
    if (!parsed.has(name)) parsed.set(name, authorName(name));
    return parsed.get(name);
  };
  const compatible = (a: string, b: string): boolean => {
    const left = parse(a),
      right = parse(b);
    if (!left || !right || left.family !== right.family) return false;
    return left.given.slice(0, right.given.length).every((part, index) => {
      const other = right.given[index];
      return (
        part === other ||
        (part.length === 1 && other.startsWith(part)) ||
        (other.length === 1 && part.startsWith(other))
      );
    });
  };
  const uniqueMatch = (name: string, byline: string[]) => {
    let index = families.get(byline);
    if (!index) {
      index = new Map();
      for (const member of byline) {
        const family = parse(member)?.family;
        if (!family) continue;
        const group = index.get(family) || [];
        group.push(member);
        index.set(family, group);
      }
      families.set(byline, index);
    }
    let matches = 0;
    for (const member of index.get(parse(name)?.family || "") || []) {
      if (compatible(name, member) && ++matches > 1) return false;
    }
    return matches === 1;
  };
  const pair = (a: string, b: string, lineA: string[], lineB: string[]) => {
    if (!compatible(a, b)) return false;
    if (nameWord(a) === nameWord(b)) return true;
    // Position alone cannot resolve multiple Wang/Smith authors when a source
    // omitted given names, or two authors share the same initials.
    return uniqueMatch(a, lineB) && uniqueMatch(b, lineA);
  };
  const aligned = (a: string[], b: string[]): boolean => {
    let comparisons = alignments.get(a);
    if (!comparisons) {
      comparisons = new Map();
      alignments.set(a, comparisons);
    }
    if (!comparisons.has(b))
      comparisons.set(
        b,
        !!a.length &&
          !!b.length &&
          !a.some((name) => ABBREVIATED_BYLINE.test(name)) &&
          !b.some((name) => ABBREVIATED_BYLINE.test(name)) &&
          a
            .slice(0, b.length)
            .every((name, index) => pair(name, b[index], a, b)),
      );
    return comparisons.get(b)!;
  };
  const detail = (name: string) => {
    // Spelled-out given names beat initials. Character length alone must
    // never choose between different full names (Paul versus Peter).
    return (parse(name)?.given || []).reduce(
      (score, part) => score + (part.length > 1 ? 10 : 1),
      0,
    );
  };
  return { compatible, aligned, detail };
}

/** Coalesce successive results from one verified source without losing names
 * when its summary (initials) arrives after its full article record. */
export function mergePopupSource(old: RefItem, incoming: RefItem): RefItem {
  const populated = Object.fromEntries(
    Object.entries(incoming).filter(
      ([, value]) =>
        value !== undefined &&
        value !== "" &&
        !(Array.isArray(value) && value.length === 0),
    ),
  );
  const merged: RefItem = {
    ...old,
    ...populated,
    identifiers: { ...old.identifiers, ...incoming.identifiers },
  };
  if (incoming.authors?.length) {
    // Completeness belongs to the selected byline, not to the merged record.
    merged.authorsTruncated = incoming.authorsTruncated;
    const matching = authorMatching();
    const before = names(old.authors, false);
    const after = names(incoming.authors, false);
    if (matching.aligned(before, after)) {
      if (
        (incoming.authorsTruncated || before.length > after.length) &&
        !old.authorsTruncated &&
        before.length >= after.length
      ) {
        merged.authors = before;
        merged.authorsTruncated = old.authorsTruncated;
      } else {
        merged.authors = after.map((name, index) =>
          before[index] &&
          matching.detail(before[index]) > matching.detail(name)
            ? before[index]
            : name,
        );
      }
    }
  }
  return merged;
}

/** Presentation only: keep the authoritative internal byline and role groups. */
function authorDisplay(
  baseline: string[],
  baselineTruncated: boolean,
  all: PopupCandidate[],
  firstOwner?: PopupCandidate,
  correspondingOwner?: PopupCandidate,
) {
  const matching = authorMatching();
  const bylines = all
    .map((candidate) => ({
      names: names(candidate.info.authors, false),
      truncated: candidate.info.authorsTruncated === true,
    }))
    .filter((line) => line.names.length);
  // Partial lists can identify first or explicit-role authors, but only a
  // verified complete byline can identify the actual last author.
  let displayLine = baseline;
  let displayTruncated = baselineTruncated;
  for (const line of bylines) {
    if (
      line.truncated ||
      line.names.length < baseline.length ||
      !matching.aligned(baseline, line.names)
    )
      continue;
    if (displayTruncated || line.names.length > displayLine.length) {
      displayLine = line.names;
      displayTruncated = false;
    }
  }
  const expand = (
    name: string,
    index: number,
    anchor: string[],
    requireComplete = false,
  ) => {
    let best = name;
    for (const candidate of bylines) {
      if (requireComplete && candidate.truncated) continue;
      const line = candidate.names;
      const proposed = line[index];
      if (
        !proposed ||
        !matching.aligned(anchor, line) ||
        !matching.compatible(best, proposed)
      )
        continue;
      if (matching.detail(proposed) > matching.detail(best)) best = proposed;
    }
    return best;
  };
  const group = (
    owner: PopupCandidate | undefined,
    field: "firstAuthors" | "correspondingAuthors",
  ) => {
    const values = names(owner?.info[field]);
    const anchor = names(owner?.info.authors, false);
    return values.map((name) => {
      const positions = anchor
        .map((author, index) =>
          matching.compatible(name, author) ? index : -1,
        )
        .filter((index) => index >= 0);
      return positions.length === 1 ? expand(name, positions[0], anchor) : name;
    });
  };
  const explicitFirst = group(firstOwner, "firstAuthors");
  const corresponding = group(correspondingOwner, "correspondingAuthors");
  const first = displayLine[0]
    ?.replace(/\s*\bet\s+al\.?$|\s*等(?:人)?[。.]?$/i, "")
    .trim();
  return {
    first: explicitFirst.length
      ? explicitFirst
      : first
        ? [expand(first, 0, displayLine)]
        : [],
    corresponding,
    last:
      corresponding.length ||
      displayTruncated ||
      displayLine.length < 2 ||
      displayLine.some((name) => ABBREVIATED_BYLINE.test(name))
        ? []
        : [
            expand(
              displayLine.at(-1)!,
              displayLine.length - 1,
              displayLine,
              true,
            ),
          ],
  };
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
    i.authorsTruncated,
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
  if (source === "readpaper" || source === "europepmc")
    return popupURL(info.url);
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
  const authorOwner = all.find(
    (candidate) => names(candidate.info.authors, false).length,
  );
  const authors = names(authorOwner?.info.authors, false);
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
  const firstOwner = all.find(
    (candidate) => names(candidate.info.firstAuthors).length,
  );
  const correspondingOwner = all.find(
    (candidate) => names(candidate.info.correspondingAuthors).length,
  );
  const explicitFirst = firstOwner
    ? names(firstOwner.info.firstAuthors)
    : undefined;
  const explicitCorresponding = correspondingOwner
    ? names(correspondingOwner.info.correspondingAuthors)
    : [];
  const authorNames = authorDisplay(
    authors,
    authorOwner?.info.authorsTruncated === true,
    all,
    firstOwner,
    correspondingOwner,
  );
  const firstAuthors = authorNames.first;
  const correspondingAuthors = authorNames.corresponding;
  const lastAuthors = authorNames.last;
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
    authorsTruncated: authorOwner?.info.authorsTruncated || undefined,
    firstAuthors: explicitFirst,
    correspondingAuthors: explicitCorresponding.length
      ? explicitCorresponding
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
