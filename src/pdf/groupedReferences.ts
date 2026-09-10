/** Conservative segmentation of flush-left, parenthesized author-year lists. */
interface BibliographyLine {
  text: string;
  x: number;
  y: number;
  height: number;
  pageNum?: number;
  column?: number;
  url?: string;
}

// Whitespace inside PDF glyph runs is only ignored by features. The original
// text and the first source line's navigation coordinates remain untouched.
const AUTHOR_YEAR = /\(\s*(?:1\s*9|2\s*0)\s*\d\s*\d[a-z]?\s*\)/;
/** Avoid ambiguous hyphen quantifiers: locate the comma before name checks. */
function startsWithAuthor(text: string): boolean {
  const comma = text.indexOf(",");
  if (comma <= 0 || comma > 256) return false;
  const name = text.slice(0, comma).trim();
  if (!/^[\p{L}'’.\s–-]+$/u.test(name)) return false;
  const words = name.split(/\s+/);
  while (/^(?:van|von|de|der|den|del|da|la|le)$/.test(words[0] ?? ""))
    words.shift();
  if (words.length > 12 || !/^\p{Lu}/u.test(words[0] ?? "")) return false;
  // The comma is the surname/initial separator. Given-name words are not
  // silently treated as initials, and the inspected suffix remains bounded.
  return /^\p{Lu}(?:\.|\p{Lu}?(?=[\s,;.]|$))/u.test(
    text.slice(comma + 1, comma + 41).trimStart(),
  );
}
const PUBLICATION_END =
  /(?:\b[a-z]*\d+\s*[-–‒]\s*[a-z]*\d+\.?|\d+\s*,\s*\d+[a-z\d]*\.?|\bdoi[:\s]*\S+|https?:\/\/\S+|\bPMID:?\s*\d+\.?|\babstr(?:act)?\s+\d+\)\)*\.?)\s*$/i;
// Some source entries omit their pages/e-locator. Accept a volume-only end
// only after a sentence boundary followed by a capitalized journal phrase.
const VOLUME_ONLY_END =
  /[.!?]\s+\p{Lu}[\p{L}\s&.'’-]{2,70}\s+\d{1,4}\s*\.\s*$/u;

/**
 * Returns null unless the whole block establishes this narrow layout/style.
 * A capitalized title line is not an author; a continued author list cannot
 * begin a new entry before the current entry has a year and publication end.
 * No numbering, deduplication, or metadata repair is performed here.
 */
export function mergeFlatAuthorYearReferences<T extends BibliographyLine>(
  lines: readonly T[],
  join: (
    left: string,
    right: string,
    leftURL?: string,
    rightURL?: string,
  ) => string,
): T[] | null {
  if (lines.length < 6 || lines.length > 20_000) return null;
  const first = lines[0];
  if (
    !first ||
    typeof first.text !== "string" ||
    first.text.length > 32_000 ||
    !Number.isFinite(first.x) ||
    !Number.isFinite(first.height) ||
    first.height <= 0 ||
    !startsWithAuthor(first.text.trim())
  )
    return null;
  let characters = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      typeof line.text !== "string" ||
      line.text.length > 32_000 ||
      !Number.isFinite(line.x) ||
      !Number.isFinite(line.y) ||
      (line.pageNum === undefined) !== (first.pageNum === undefined) ||
      (line.column === undefined) !== (first.column === undefined) ||
      (line.pageNum !== undefined &&
        (!Number.isInteger(line.pageNum) || line.pageNum < 0)) ||
      (line.column !== undefined &&
        (!Number.isInteger(line.column) || line.column < 0)) ||
      !Number.isFinite(line.height) ||
      line.height <= 0 ||
      Math.abs(line.x - first.x) > Math.min(first.height, line.height) * 0.2 ||
      line.height < first.height * 0.8 ||
      line.height > first.height * 1.25
    )
      return null;
    if (i > 0) {
      const previous = lines[i - 1];
      const pageStep = (line.pageNum ?? 0) - (previous.pageNum ?? 0);
      const columnStep = (line.column ?? 0) - (previous.column ?? 0);
      // Reading order is supplied by the legacy layout pass. This narrow
      // branch cannot repair skipped/reversed pages, columns or visual rows.
      if (
        pageStep < 0 ||
        pageStep > 1 ||
        (pageStep === 1 && line.column !== undefined && line.column !== 0) ||
        (pageStep === 0 &&
          (columnStep < 0 ||
            columnStep > 1 ||
            (columnStep === 0 && line.y >= previous.y)))
      )
        return null;
    }
    characters += line.text.length;
    if (characters > 8_000_000) return null;
  }
  // Bounded look-ahead covers wrapped author lists without making title words
  // into starts. A large vertical break or non-adjacent page ends the probe.
  const datedAuthor = (index: number): boolean => {
    if (!startsWithAuthor(lines[index].text.trim())) return false;
    let suffix = "";
    for (let i = index; i < Math.min(lines.length, index + 12); i++) {
      if (i > index) {
        const previous = lines[i - 1];
        const current = lines[i];
        if (
          (current.pageNum ?? 0) - (previous.pageNum ?? 0) > 1 ||
          (current.pageNum === previous.pageNum &&
            current.column === previous.column &&
            previous.y - current.y > 4 * current.height)
        )
          return false;
      }
      // Include the previous line suffix for a year such as "(20" / "21)".
      // This also protects the ambiguity check below from split glyph runs.
      const text = `${suffix} ${lines[i].text}`;
      if (AUTHOR_YEAR.test(text)) return true;
      suffix = text.slice(-64);
    }
    return false;
  };
  if (!datedAuthor(0)) return null;
  const result: T[] = [];
  let current: T | undefined;
  let currentHasYear = false;
  let currentLineCount = 0;
  const complete = (text: string) => {
    const tail = text.slice(-512).replace(/(?<=\d)\s+(?=\d)/g, "");
    return PUBLICATION_END.test(tail) || VOLUME_ONLY_END.test(tail);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextAuthor = datedAuthor(i);
    if (
      current &&
      currentHasYear &&
      startsWithAuthor(line.text.trim()) &&
      (!complete(current.text) || !nextAuthor)
    ) {
      // A book/report or an unknown ending may be followed by another real
      // citation. Missing evidence is not permission to merge publications.
      // Return the whole block to the established legacy path.
      return null;
    }
    if (!current || (currentHasYear && complete(current.text) && nextAuthor)) {
      current = { ...line };
      currentHasYear = AUTHOR_YEAR.test(line.text);
      currentLineCount = 1;
      result.push(current);
    } else {
      currentLineCount++;
      if (
        currentLineCount > 128 ||
        current.text.length + line.text.length > 32_000
      )
        return null;
      // Retain visible line-end hyphens in this source-preserving branch.
      // We cannot decide that a compound word, surname or DOI lost a literal
      // hyphen merely because the PDF wrapped there. Numeric ranges retain
      // their spacing; hyphenated identifiers concatenate without a new space.
      current.text =
        /\d\s*[-–‒]\s*$/.test(current.text) && /^\s*\d/.test(line.text)
          ? `${current.text.trimEnd()} ${line.text.trim()}`
          : /[-‐‑]\s*$/.test(current.text)
            ? current.text.trimEnd() + line.text.trimStart()
            : join(current.text, line.text, current.url, line.url);
      currentHasYear ||= AUTHOR_YEAR.test(current.text.slice(-1024));

      if (line.url) current.url = line.url;
    }
  }
  // Multiple independent complete records establish the format. A lone
  // author-year sentence in ordinary text must retain the existing fallback.
  if (
    result.length < 3 ||
    !currentHasYear ||
    !complete(result[result.length - 1].text)
  )
    return null;
  return result;
}
