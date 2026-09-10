const typeCode = (content: string): string | undefined => {
  const code = content.replace(/\s+/g, "").normalize("NFKC");
  return /^(?:[JMCGNDRSPAZ]|DB|CP|EB)(?:\/(?:OL|CD|DK|MT))?$/.test(code)
    ? code
    : undefined;
};

/** Conservatively identifies English GB-style citations from structural evidence. */
export function isEnglishGBCitation(text: string): boolean {
  if (/\p{Script=Han}/u.test(text)) return false;
  const type = [
    ...text.matchAll(/\[([^[\]\r\n]{1,24})\]|［([^［］\r\n]{1,24})］/g),
  ].find((match) => typeCode(match[1] ?? match[2]));
  if (!type) return false;
  const normalized = text.normalize("NFKC");
  const publicationTail =
    /\b(?:1[6-9]\d{2}|20\d{2})\s*[,;:]\s*\d{1,4}(?:\s*\(\s*\d{1,3}(?:\s*[-–—]\s*\d{1,3})?\s*\))?\s*:\s*[A-Za-z]?\d{1,7}(?:\s*[-–—]\s*[A-Za-z]?\d{1,7})?\b/.test(
      normalized,
    ) ||
    /\b(?:1[6-9]\d{2}|20\d{2})\s*:\s*[A-Za-z]?\d{1,7}(?:\s*[-–—]\s*[A-Za-z]?\d{1,7})?\b/.test(
      normalized,
    );
  const beforeType = text.slice(0, type.index);
  const authorTitleBoundary = /[A-Za-z]\s*[.．]\s+\p{L}/u.test(beforeType);
  return publicationTail || authorTitleBoundary;
}

/** Display-only PDF spacing repair. Raw citation, identifiers and edit text stay intact. */
export function formatCitationText(text: string): string {
  const publisherCode = (content: string): string | undefined => {
    const code = content.replace(/\s+/g, "").normalize("NFKC");
    return /^(?:S\.l\.|s\.n\.)$/.test(code) ? code : undefined;
  };
  const englishGB = isEnglishGBCitation(text);
  const compact = (part: string) => {
    let source = part;
    // Convert English fullwidth separators before the CJK whitespace rule so
    // a comma or colon cannot consume the following Latin word boundary.
    if (englishGB) {
      source = source
        .replace(/\s*，\s*/g, ", ")
        .replace(/\s*；\s*/g, "; ")
        .replace(/\s*：\s*/g, ": ");
    }
    let result = source
      .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
      .replace(/\s*([，。；：！？、（）【】《》〈〉「」『』〔〕])\s*/gu, "$1")
      .replace(
        /\[([^[\]\r\n]{1,24})\]|［([^［］\r\n]{1,24})］/g,
        (mark, narrow: string, wide: string) => {
          const code =
            typeCode(narrow ?? wide) ?? publisherCode(narrow ?? wide);
          return code ? `[${code}]` : mark;
        },
      )
      .replace(/(\p{Script=Han})\s+(?=\[[A-Z/]+\])/gu, "$1")
      .replace(/(\[[A-Z/]+\])\s+(?=\p{Script=Han})/gu, "$1")
      // A fullwidth period also appears between English words. Compact only
      // its Chinese-side boundaries, including a type mark before Chinese text.
      .replace(/(\p{Script=Han})\s+．/gu, "$1．")
      .replace(/(\[[A-Z/]+\])\s+(?=．\s*\p{Script=Han})/gu, "$1")
      .replace(/．\s+(?=\p{Script=Han})/gu, "．")
      // Only a complete year + volume/issue + pages tail is bibliographic.
      // Assignment/comparison contexts are statistics, not citation tails.
      .replace(
        /(?<![\dA-Za-z])(?:1\d{3}|20\d{2})\s*[,;，；]\s*\d{1,4}\s*(?:\(\s*\d{1,3}(?:\s*[-–—]\s*\d{1,3})?\s*\)|（\s*\d{1,3}(?:\s*[-–—]\s*\d{1,3})?\s*）)?\s*[:：]\s*[A-Za-z]?\d{1,7}(?:\s*[-–—]\s*[A-Za-z]?\d{1,7})?(?=\s*[.．。]?\s*(?:doi\s*[:：]?\s*)?$)/gi,
        (tail, offset: number, source: string) =>
          /(?:[=<>≤≥≈≠]|\b[nNpP])\s*$/.test(source.slice(0, offset))
            ? tail
            : tail.replace(/\s+/g, ""),
      );
    // These are bibliographic separators, not English word boundaries.
    result = result
      .replace(
        /\[([A-Z/]+)\]\s*\/\s*\/\s*(?=[\p{L}"“])/gu,
        (match, code: string, offset: number, source: string) =>
          englishGB && typeCode(code)
            ? `[${code}]//${/\p{Script=Han}/u.test(source[offset + match.length]) ? "" : " "}`
            : match,
      )
      .replace(/(\[(?:S\.l\.|s\.n\.)\])\s*[:：]\s*/g, "$1: ");
    // English GB-style entries often inherit fullwidth punctuation from a
    // Chinese PDF. Leave mixed/Chinese entries and ordinary numeric prose
    // on the existing path; never apply whole-string Unicode normalization.
    if (englishGB) {
      result = result
        .replace(/(?<=[A-Za-z0-9\]])\s*．(?=\s|$|\[)/g, ".")
        // A protected bracket splits compact() into spans, so its following
        // punctuation has no local left-hand character to inspect.
        .replace(/^\s*．(?=\s|$|\[)/, ".")
        .replace(/[\t \u00a0]{2,}/g, " ")
        .replace(/[\t \u00a0]+([,.;:])/g, "$1");
    }
    return result;
  };

  // Preserve continuous identifiers and unknown bracket content byte-for-byte.
  // Separate spans avoid placeholder tokens colliding with source text.
  const protectedSpans =
    /(?:https?:\/\/|www\.)\S+|\b10\.\d{4,9}\/\S+|\[[^[\]\r\n]*\]|［[^［］\r\n]*］/gi;
  let output = "";
  let end = 0;
  let hasBibliographicType = false;
  for (const match of text.matchAll(protectedSpans)) {
    if (/^[［[]/.test(match[0])) {
      if (typeCode(match[0].slice(1, -1))) {
        hasBibliographicType = true;
        continue;
      }
      // Keep a literal abbreviation in prose intact. A type marker must
      // establish the bibliography context before publisher metadata.
      if (hasBibliographicType && publisherCode(match[0].slice(1, -1)))
        continue;
    }
    output += compact(text.slice(end, match.index)) + match[0];
    end = match.index! + match[0].length;
  }
  return output + compact(text.slice(end));
}
