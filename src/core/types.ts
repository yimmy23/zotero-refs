/**
 * Shared data contracts for the whole plugin.
 * Every module (sources, pdf parser, UI) speaks RefItem.
 */

export type SourceID =
  | "pdf"
  | "crossref"
  | "semanticscholar"
  | "openalex"
  | "arxiv"
  | "pubmed"
  | "unpaywall"
  | "cnki"
  | "readpaper"
  | "connectedpapers"
  | "zotero";

export interface Identifiers {
  DOI?: string;
  arXiv?: string;
  PMID?: string;
  /** CNKI detail page URL */
  CNKI?: string;
  /** OpenAlex work id, e.g. W2741809807 */
  openAlex?: string;
  /** Semantic Scholar paperId */
  s2?: string;
  [key: string]: string | undefined;
}

export interface RefTag {
  text: string | number;
  color?: string;
  /** tooltip shown on hover */
  tip?: string;
  /** click opens this URL */
  url?: string;
  /** click selects this zotero item in library */
  itemID?: number;
  /** marks the tag as a data-source badge */
  source?: SourceID;
}

/**
 * A reference / paper record. Produced by the PDF parser (text + identifiers
 * + anchor position) and enriched by metadata sources.
 */
export interface RefItem {
  identifiers: Identifiers;
  title?: string;
  authors: string[];
  /** zotero item type guess: journalArticle / preprint / ... */
  type?: string;
  /** raw reference string as it appears in the bibliography */
  text?: string;
  year?: string;
  url?: string;
  /** open-access PDF url if known */
  oaUrl?: string;
  /** reference number in the bibliography, 1-based */
  number?: number;
  abstract?: string;
  publishDate?: string;
  primaryVenue?: string;
  /** which source produced this metadata */
  source?: SourceID;
  tags?: (RefTag | string)[];
  /** extra line shown under the authors, e.g. citation context */
  description?: string;
  citationCount?: number;
  referenceCount?: number;
  /** references of this record (when a source returns the full list) */
  references?: RefItem[];
  /** matched local zotero item id (0 = none) */
  libItemID?: number;
  /** PDF anchor position of the reference entry (PDF source only) */
  x?: number;
  y?: number;
}

/** Paged result for citations ("cited by") queries. */
export interface PagedRefs {
  items: RefItem[];
  total?: number;
  nextOffset?: number;
}

/**
 * A metadata source. All methods return null when the source cannot answer
 * (not found / network error already logged). Methods are optional —
 * a source implements only what its API supports.
 */
export interface MetaSource {
  id: SourceID;
  /** single-record metadata lookups (used by the hover popup) */
  getInfoByDOI?(doi: string): Promise<RefItem | null>;
  getInfoByArXiv?(arxiv: string): Promise<RefItem | null>;
  getInfoByPMID?(pmid: string): Promise<RefItem | null>;
  /** title search; refText available for fuzzy/validation use */
  getInfoByTitle?(title: string, refText?: string): Promise<RefItem | null>;
  /** full reference list of a work */
  getReferences?(ids: Identifiers, title?: string): Promise<RefItem[] | null>;
  /** works citing this work */
  getCitations?(
    ids: Identifiers,
    offset?: number,
    limit?: number,
  ): Promise<PagedRefs | null>;
  /** recommended / related works */
  getRelated?(ids: Identifiers, limit?: number): Promise<RefItem[] | null>;
}

/** Graph structures for the citation graph view. */
export interface GraphNode {
  id: string;
  ref: RefItem;
  /** node kind relative to the origin */
  kind: "origin" | "reference" | "citation" | "related";
  inLibrary: boolean;
  /** layout state, filled by the force simulation */
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphEdge {
  source: string | GraphNode;
  target: string | GraphNode;
  /** co-citation strength, >= 1 */
  weight: number;
  kind: "direct" | "cocite";
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  originId: string;
}

/** short display names for source ids (popup dot tooltips, count line, …) */
export const SOURCE_NAME: Record<string, string> = {
  crossref: "Crossref",
  semanticscholar: "Semantic Scholar",
  openalex: "OpenAlex",
  pubmed: "PubMed",
  unpaywall: "Unpaywall",
  readpaper: "ReadPaper",
  connectedpapers: "Connected Papers",
  cnki: "CNKI",
  CNKI: "CNKI",
  arxiv: "arXiv",
  arXiv: "arXiv",
  zotero: "Zotero",
  Zotero: "Zotero",
  pdf: "PDF",
};

export const SOURCE_BADGE: Record<string, { color: string; tip?: string }> = {
  pdf: { color: "#a05a2c", tip: "Parsed from the PDF text layer" },
  arxiv: { color: "#b31b1b", tip: "arXiv — open-access preprint archive" },
  arXiv: { color: "#b31b1b", tip: "arXiv — open-access preprint archive" },
  readpaper: { color: "#1f71e0", tip: "ReadPaper 论文阅读平台" },
  semanticscholar: {
    color: "#1857b6",
    tip: "Semantic Scholar — AI-powered research tool by Allen Institute for AI",
  },
  crossref: {
    color: "#89bf04",
    tip: "Crossref — official DOI registration agency metadata",
  },
  openalex: {
    color: "#e8710a",
    tip: "OpenAlex — fully open catalog of scholarly works",
  },
  pubmed: {
    color: "#20558a",
    tip: "PubMed — biomedical literature from NLM",
  },
  connectedpapers: {
    color: "#35999a",
    tip: "Connected Papers — visual exploration of academic papers",
  },
  unpaywall: { color: "#00b8a9", tip: "Unpaywall — open-access status" },
  DOI: { color: "#fcb426" },
  Zotero: {
    color: "#d63b3b",
    tip: "This reference is in your Zotero library",
  },
  zotero: {
    color: "#d63b3b",
    tip: "This reference is in your Zotero library",
  },
  CNKI: { color: "#1b66e6", tip: "中国知网 CNKI" },
  cnki: { color: "#1b66e6", tip: "中国知网 CNKI" },
};
