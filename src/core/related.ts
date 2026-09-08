import type { Identifiers, RefItem } from "./types";

export type RelatedSource = "semanticscholar" | "openalex";
export interface RelatedCandidate {
  ref: RefItem;
  evidence: Array<{ source: RelatedSource; rank: number }>;
  /** Reciprocal rank fusion (k=60), not a similarity probability. */
  score: number;
}
export interface RelatedResult {
  items: RelatedCandidate[];
  sources: Array<{
    source: RelatedSource;
    status: "loading" | "ready" | "unavailable";
    count: number;
  }>;
  complete: boolean;
}
export interface RelatedSnapshot {
  source: RelatedSource;
  status: RelatedResult["sources"][number]["status"];
  items: readonly RefItem[];
}

export const RELATED_SOURCES: readonly RelatedSource[] = [
  "semanticscholar",
  "openalex",
];
// Transient provider-list position, deliberately separate from bibliography
// `number`. It is stripped from the fused metadata and never persisted.
const LIST_RANK = Symbol("related-list-rank");
type RankedRef = RefItem & { [LIST_RANK]?: number };

export function relatedLimit(limit = 40): number {
  return Number.isFinite(limit)
    ? Math.max(1, Math.min(40, Math.floor(limit)))
    : 40;
}

export function withRelatedRank(ref: RefItem, rank: number): RefItem {
  return { ...ref, [LIST_RANK]: rank } as RankedRef;
}

function listRank(ref: RefItem, fallback: number): number {
  const rank = (ref as RankedRef)[LIST_RANK];
  return Number.isInteger(rank) && rank! > 0 ? rank! : fallback;
}

/** Clone every mutable metadata collection; source objects remain untouched. */
export function cloneRelatedRef(ref: RefItem): RefItem {
  const copy = {
    ...ref,
    identifiers: { ...ref.identifiers },
    authors: [...ref.authors],
  };
  delete (copy as RankedRef)[LIST_RANK];
  if (ref.firstAuthors) copy.firstAuthors = [...ref.firstAuthors];
  if (ref.correspondingAuthors)
    copy.correspondingAuthors = [...ref.correspondingAuthors];
  if (ref.tags)
    copy.tags = ref.tags.map((tag) =>
      typeof tag === "string" ? tag : { ...tag },
    );
  if (ref.references) copy.references = ref.references.map(cloneRelatedRef);
  return copy;
}

/** Own the snapshot, including its original positions, before publishing it. */
export function snapshotRelatedRefs(
  refs: readonly RefItem[],
  limit = 40,
): RefItem[] {
  return refs
    .slice(0, relatedLimit(limit))
    .map((ref, index) =>
      withRelatedRank(cloneRelatedRef(ref), listRank(ref, index + 1)),
    );
}

function normalizedID(namespace: string, raw?: string): string {
  if (typeof raw !== "string") return "";
  let value = raw.trim();
  if (!value) return "";
  try {
    value = decodeURIComponent(value);
  } catch {
    /* Keep malformed escapes literal. */
  }
  switch (namespace) {
    case "DOI":
      return value
        .replace(/^doi:\s*/i, "")
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
        .toLowerCase();
    case "PMID":
      return value
        .replace(/^pmid:\s*/i, "")
        .replace(
          /^https?:\/\/(?:pubmed\.ncbi\.nlm\.nih\.gov\/|www\.ncbi\.nlm\.nih\.gov\/pubmed\/)/i,
          "",
        )
        .replace(/\/$/, "")
        .replace(/^0+(?=\d)/, "");
    case "openAlex":
      return value
        .replace(/^https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?/i, "")
        .replace(/\/$/, "")
        .toUpperCase();
    case "s2":
      return value
        .replace(
          /^https?:\/\/(?:www\.)?semanticscholar\.org\/paper\/(?:[^/]+\/)?/i,
          "",
        )
        .replace(/\/$/, "")
        .toLowerCase();
    case "arXiv":
      return value
        .replace(/^arxiv:\s*/i, "")
        .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
        .replace(/\.pdf$/i, "")
        .replace(/v\d+$/i, "")
        .toLowerCase();
    default:
      return value;
  }
}

function validAnchor(namespace: string, value: string): boolean {
  switch (namespace) {
    case "DOI":
      return /^10\.\d{4,9}\/\S+$/.test(value);
    case "PMID":
      return /^[1-9]\d*$/.test(value);
    case "openAlex":
      return /^W\d+$/.test(value);
    case "s2":
      return /^[a-z0-9_-]+$/.test(value);
    case "arXiv":
      return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})$/.test(value);
    default:
      return false;
  }
}

/** Shared namespaced ID only; any explicit conflict vetoes a possible match.
 * Titles deliberately do not establish identity, even when long and equal.
 */
export function sameRelatedPaper(
  a: { identifiers: Identifiers },
  b: { identifiers: Identifiers },
): boolean {
  let shared = false;
  for (const namespace of new Set([
    ...Object.keys(a.identifiers),
    ...Object.keys(b.identifiers),
  ])) {
    const left = normalizedID(namespace, a.identifiers[namespace]);
    const right = normalizedID(namespace, b.identifiers[namespace]);
    if (!left || !right) continue;
    if (left !== right) return false;
    if (validAnchor(namespace, left)) shared = true;
  }
  return shared;
}

/** Recompute from fixed-order snapshots, never from provider arrival order. */
export function fuseRelated(
  snapshots: readonly RelatedSnapshot[],
  limit = 40,
): RelatedResult {
  const items: RelatedCandidate[] = [];
  const sources: RelatedResult["sources"] = [];
  for (const source of RELATED_SOURCES) {
    const snapshot = snapshots.find((entry) => entry.source === source);
    const refs =
      snapshot?.status === "ready"
        ? snapshot.items.slice(0, relatedLimit(limit))
        : [];
    sources.push({
      source,
      status: snapshot?.status || "loading",
      count: refs.length,
    });
    refs.forEach((ref, index) => {
      const matches = items.filter((candidate) =>
        sameRelatedPaper(candidate.ref, ref),
      );
      // A bridge matching multiple existing records is ambiguous. Retain it.
      let candidate = matches.length === 1 ? matches[0] : undefined;
      if (!candidate) {
        candidate = { ref: cloneRelatedRef(ref), evidence: [], score: 0 };
        items.push(candidate);
      } else {
        // Keep metadata/byline provenance together; only add missing IDs.
        for (const [key, value] of Object.entries(ref.identifiers)) {
          if (!candidate.ref.identifiers[key] && value)
            candidate.ref.identifiers[key] = value;
        }
      }
      if (!candidate.evidence.some((entry) => entry.source === source)) {
        const rank = listRank(ref, index + 1);
        candidate.evidence.push({ source, rank });
        candidate.score += 1 / (60 + rank);
      }
    });
  }
  items.sort((a, b) => b.score - a.score);
  return {
    // The panel excludes its host/manual relations before taking its display
    // limit. Keep the full bounded candidate pool (at most 40 per source).
    items,
    sources,
    complete: sources.every((source) => source.status !== "loading"),
  };
}
