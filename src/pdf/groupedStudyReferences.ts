/** A partition of the legacy parser's selected lines, not original PDF glyphs. */
export interface GroupedStudyDecision {
  lineIndex: number;
  label: "B" | "I" | "G" | "O";
  reason: string;
}
export interface GroupedStudyEntry {
  lineIndices: number[];
  group?: string;
}
interface StudyLine {
  text: string;
  x: number;
  y: number;
  height: number;
  pageNum?: number;
  column?: number;
  _x?: number;
  url?: string;
}
const CATEGORY =
  /^(?:references to (?:studies included in this review|studies excluded from this review|studies awaiting (?:assessment|classification)|ongoing studies|other published versions of this review)|additional references)$/i;
const STUDY_TAG =
  /^.{2,160}\s*\{(?:published(?: and unpublished)?|unpublished) data(?: only)?\}\s*$/i;
const LEGEND = /^[*∗]\s*Indicates the major publication for the study\.?$/i;
const YEAR = /\b(?:1[5-9]\d{2}|20\d{2})[a-z]?\b/i;
const PUBLICATION_YEAR = /\b(?:1[5-9]\d{2}|20\d{2})\s*[;,]\s*(?:\d|$)/i;
const LABEL = /^[\p{L}\p{M}\d'’() .–-]{2,140}$/u;
const VOLUME_END =
  /\b\d{1,4}\s*(?:Suppl\s*)?(?:\([^)]{1,24}\)\s*)?:\s*(?:suppl\s*\d{1,3}\s+)?[a-z]?\d{1,7}[a-z]?(?:\s*[-–‒]\s*[a-z]?\d{1,7})?(?:\s*\(abstr(?:act)?\s+\d{1,7}\))?[.。]?\s*$/i;
const IDENTIFIER_END =
  /(?:\b10\.\d{4,9}\/[^\s]+|https?:\/\/[^\s]+|\bPMID\s*:?\s*\d{5,9})[\].。]?\s*$/i;
const WEBSITE_END =
  /\b(?:www\.[\w.-]+\.[a-z]{2,}|https?:\/\/[^\s]+)\s*\(accessed\s+[^)]{4,70}\)[.。]?\s*$/i;
const ONGOING_END = /\bOngoing study\s+\d{1,2}\/\d{1,2}\/\d{4}[.。]?\s*$/i;
const BOOK_EVIDENCE = /\b(?:handbook|manual|publisher|press)\b|\(editors?\)/i;
const PUBLISHER_END =
  /(?:^|[.]\s+)\p{Lu}[\p{L}\s&.'’:-]{2,100},\s*(?:1[5-9]\d{2}|20\d{2})[.。]?\s*$/u;
const IDENTIFIER_CONTINUATION =
  /^(?:\[?\s*(?:DOI|PMID|PMCID|PubMed|ISBN)\b|https?:\/\/|www\.)/i;

/** Bounded surname/initial recognition without overlapping name quantifiers. */
function authorPrefix(text: string): boolean {
  const body = text.replace(/^[*∗]\s*/, "").slice(0, 180);
  const comma = body.indexOf(",");
  const period = body.indexOf(".");
  const separator =
    comma < 0 ? period : period < 0 ? comma : Math.min(comma, period);
  if (separator <= 0 || separator > 100) return false;
  const prefix = body.slice(0, separator).trim();
  if (!/^[\p{L}'’.\s‐–-]+$/u.test(prefix)) return false;
  const words = prefix.split(/\s+/);
  const initials = words[words.length - 1];
  if (
    words.length >= 2 &&
    words.length <= 8 &&
    /^[A-Z]{1,4}(?:-[A-Z])?$/.test(initials)
  )
    return true;
  return (
    separator === comma &&
    words.length <= 6 &&
    /^(?:\p{Lu}\.|\p{Lu}{1,4}(?=[,;.]|$))/u.test(
      body.slice(comma + 1).trimStart(),
    )
  );
}

/** Only an open author field can justify another author-shaped continuation. */
function openAuthors(text: string): boolean {
  if (!/(?:[,;]|\band|[-‐‑])\s*$/.test(text) || /\bet\s+al\./i.test(text))
    return false;
  if (/\b[A-Z]{1,4}\.\s+(?:[Aa]\s+)?[A-Z][a-z]{2}/.test(text)) return false;
  const words = text.match(/[\p{L}][\p{L}'’.‐-]*/gu) ?? [];
  return words.every(
    (word) =>
      /^\p{Lu}/u.test(word) ||
      /^(?:and|van|von|de|der|den|del|da|di|la|le)$/.test(word),
  );
}
const CORPORATE_START =
  /^(?:[\p{Lu}][\p{L}'’ -]{2,100}(?:Group|Consortium|Collaboration|Committee)\.|[A-Z][A-Z0-9 -]{1,30}\s+Trial\b)/u;
const NAMED_RESOURCE = /^[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,5}\./u;

/**
 * Strongly gated finite-state segmentation; null preserves the legacy result.
 * There is no page selection, sorting, deduplication, inferred numbering or API.
 * Work is O(input characters + lines), with bounded 512-character tail checks.
 */
export function segmentGroupedStudyReferences<T extends StudyLine>(
  lines: readonly T[],
): {
  refs: T[];
  entries: GroupedStudyEntry[];
  decisions: GroupedStudyDecision[];
} | null {
  if (!Array.isArray(lines) || lines.length < 9 || lines.length > 20_000)
    return null;
  const first = lines[0];
  if (
    !first ||
    typeof first.text !== "string" ||
    first.text.length > 32_000 ||
    !CATEGORY.test(first.text.trim().replace(/\s+/g, " "))
  )
    return null;
  const features: {
    text: string;
    tag: boolean;
    category: boolean;
    legend: boolean;
    author: boolean;
    year: boolean;
    publicationYear: boolean;
    book: boolean;
    authorOpen: boolean;
    namedResource: boolean;
    firstEvidence: boolean;
  }[] = [];
  let characters = 0,
    tags = 0,
    categories = 0,
    outerX = 0,
    bodyX = 0,
    bodyHeight = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (
      !l ||
      typeof l.text !== "string" ||
      l.text.length > 32_000 ||
      !Number.isFinite(l.x) ||
      !Number.isFinite(l.y) ||
      !Number.isFinite(l.height) ||
      l.height <= 0 ||
      !Number.isInteger(l.pageNum) ||
      l.pageNum! < 0 ||
      !Number.isInteger(l.column) ||
      l.column! < 0 ||
      (l._x !== undefined && !Number.isFinite(l._x))
    )
      return null;
    if (i) {
      const p = lines[i - 1],
        page = l.pageNum! - p.pageNum!,
        column = l.column! - p.column!;
      if (
        page < 0 ||
        page > 1 ||
        (page === 1 && l.column !== 0) ||
        (page === 0 &&
          (column < 0 || column > 1 || (column === 0 && l.y >= p.y)))
      )
        return null;
      if (
        page === 0 &&
        column === 1 &&
        (l._x === undefined || p._x === undefined || l._x <= p._x)
      )
        return null;
    }
    characters += l.text.length;
    if (characters > 8_000_000) return null;
    const text = l.text.trim().replace(/\s+/g, " ");
    if (
      /^(?:[[［]\s*[0-9０-９]{1,4}\s*[\]］]|[（(]\s*[0-9０-９]{1,4}\s*[）)]|[0-9０-９]{1,4}[.)．])\s*(?=[*∗]?\s*\p{L})/u.test(
        text,
      )
    )
      return null;
    const author = authorPrefix(text);
    const tag = STUDY_TAG.test(text),
      category = CATEGORY.test(text);
    if (tag) {
      const next = lines[i + 1];
      if (
        !next ||
        !Number.isFinite(next.x) ||
        !(next.x - l.x >= l.height * 0.5) ||
        next.x - l.x > l.height * 5
      )
        return null;
      if (!tags) {
        outerX = l.x;
        bodyX = next.x;
        bodyHeight = l.height;
      } else if (
        Math.abs(l.x - outerX) > bodyHeight * 0.3 ||
        Math.abs(next.x - bodyX) > bodyHeight * 0.3
      )
        return null;
      tags++;
    }
    if (category) categories++;
    features.push({
      text,
      tag,
      category,
      legend: LEGEND.test(text),
      author,
      year: YEAR.test(text),
      publicationYear: PUBLICATION_YEAR.test(text),
      book: BOOK_EVIDENCE.test(text),
      authorOpen: openAuthors(text),
      namedResource: NAMED_RESOURCE.test(text),
      firstEvidence:
        author || CORPORATE_START.test(text.replace(/^[*∗]\s*/, "")),
    });
  }
  if (tags < 3 || !categories || !features[0].category) return null;
  const refs: T[] = [],
    entries: GroupedStudyEntry[] = [],
    decisions: GroupedStudyDecision[] = [];
  let group: string | undefined,
    groupHasBody = false,
    additional = false,
    stopped = false;
  let active:
    | {
        first: number;
        indices: number[];
        pieces: string[];
        characters: number;
        tail: string;
        year: boolean;
        publicationYear: boolean;
        book: boolean;
        authorOpen: boolean;
        namedResource: boolean;
        firstEvidence: boolean;
        url?: string;
      }
    | undefined;
  const complete = (): boolean => {
    if (!active || /[-‐‑:]\s*$/.test(active.tail)) return false;
    const tail = active.tail.replace(/(?<=\d)\s+(?=\d)/g, "");
    return (
      IDENTIFIER_END.test(tail) ||
      (active.year &&
        ((active.publicationYear && VOLUME_END.test(tail)) ||
          /\[Epub ahead of print\][.。]?\s*$/i.test(tail) ||
          WEBSITE_END.test(tail) ||
          ONGOING_END.test(tail) ||
          (active.book && PUBLISHER_END.test(tail))))
    );
  };
  const close = (): boolean => {
    if (!active) return true;
    if (
      !complete() ||
      (!active.firstEvidence &&
        !(active.namedResource && WEBSITE_END.test(active.tail)))
    )
      return false;
    // Join each entry once after its partition has been validated. Numeric and
    // identifier/compound hyphens remain visible source characters.
    const chunks = [active.pieces[0].trimEnd()];
    for (let i = 1; i < active.pieces.length; i++) {
      const previous = active.pieces[i - 1].trimEnd();
      const next = active.pieces[i].trim();
      const ending = previous.slice(-64);
      const connector =
        /\d\s*[-–‒]\s*$/.test(ending) && /^\d/.test(next)
          ? " "
          : /[-‐‑]$/.test(ending)
            ? ""
            : " ";
      chunks.push(connector, next);
    }
    const text = chunks.join("");
    refs.push({
      ...lines[active.first],
      text,
      ...(active.url ? { url: active.url } : {}),
    });
    entries.push({ lineIndices: active.indices, ...(group ? { group } : {}) });
    active = undefined;
    return true;
  };
  const decide = (
    lineIndex: number,
    label: GroupedStudyDecision["label"],
    reason: string,
  ) => decisions.push({ lineIndex, label, reason });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      f = features[i];
    const outer = Math.abs(line.x - outerX) <= bodyHeight * 0.3;
    const body = Math.abs(line.x - bodyX) <= bodyHeight * 0.3;
    if (!f.text) {
      decide(i, "O", "empty-line");
      continue;
    }
    if (stopped) return null;
    if (f.category || f.legend) {
      if (!outer || !close() || (group && !groupHasBody)) return null;
      decide(i, "O", f.legend ? "publication-legend" : "category-heading");
      group = undefined;
      groupHasBody = false;
      additional =
        /^additional references$|^references to other published versions/i.test(
          f.text,
        );
      if (f.legend) stopped = true;
      continue;
    }
    if (outer) {
      if (
        (!f.tag && !(additional && LABEL.test(f.text))) ||
        !close() ||
        (group && !groupHasBody)
      )
        return null;
      const next = lines[i + 1];
      if (!next || Math.abs(next.x - bodyX) > bodyHeight * 0.3) return null;
      group = f.text;
      groupHasBody = false;
      decide(i, "G", f.tag ? "study-label" : "resource-label");
      continue;
    }
    if (
      !body ||
      !group ||
      line.height < bodyHeight * 0.55 ||
      line.height > bodyHeight * 1.3
    )
      return null;
    let beginning = !active;
    if (active) {
      const previous = lines[active.indices[active.indices.length - 1]];
      if (
        line.pageNum === previous.pageNum &&
        line.column === previous.column &&
        previous.y - line.y > 4.5 * Math.max(previous.height, line.height)
      )
        return null;
      const ended = complete();
      if (f.author) {
        if (ended) {
          if (!close()) return null;
          beginning = true;
        } else if (active.year || !active.authorOpen) return null;
      } else if (ended && !IDENTIFIER_CONTINUATION.test(f.text)) {
        // An unrecognized second publication must not be swallowed by the
        // prior entry. Identifiers can legitimately follow its volume/pages.
        return null;
      }
    }
    if (beginning) {
      if (!/^[*∗]?\s*\p{L}/u.test(f.text)) return null;
      active = {
        first: i,
        indices: [],
        pieces: [],
        characters: 0,
        tail: "",
        year: false,
        publicationYear: false,
        book: false,
        authorOpen: false,
        firstEvidence: f.firstEvidence,
        namedResource: f.namedResource,
      };
      groupHasBody = true;
    }
    if (!active) return null;
    active.characters += line.text.length;
    if (active.indices.length >= 128 || active.characters > 32_000) return null;
    active.indices.push(i);
    active.pieces.push(line.text);
    active.tail = (
      active.tail.endsWith("-")
        ? active.tail + f.text
        : `${active.tail} ${f.text}`
    ).slice(-512);
    active.year ||= f.year;
    active.publicationYear ||=
      f.publicationYear || PUBLICATION_YEAR.test(active.tail);
    active.book ||= f.book;
    active.authorOpen = f.authorOpen;
    if (line.url) active.url = line.url;
    decide(
      i,
      beginning ? "B" : "I",
      beginning ? "publication-start" : "publication-continuation",
    );
  }
  if (
    !close() ||
    (group && !groupHasBody) ||
    refs.length < 3 ||
    decisions.length !== lines.length
  )
    return null;
  return { refs, entries, decisions };
}
