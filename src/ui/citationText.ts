/** Display-only PDF spacing repair. Raw citation, identifiers and edit text stay intact. */
export function formatCitationText(text: string): string {
  const typeCode = (content: string): string | undefined => {
    const code = content.replace(/\s+/g, "").normalize("NFKC");
    return /^(?:[JMCGNDRSPAZ]|DB|CP|EB)(?:\/(?:OL|CD|DK|MT))?$/.test(code)
      ? code
      : undefined;
  };
  const compact = (part: string) =>
    part
      .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
      .replace(/\s*([，。；：！？、（）【】《》〈〉「」『』〔〕])\s*/gu, "$1")
      .replace(
        /\[([^[\]\r\n]{1,24})\]|［([^［］\r\n]{1,24})］/g,
        (mark, narrow: string, wide: string) => {
          const code = typeCode(narrow ?? wide);
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

  // Preserve continuous identifiers and unknown bracket content byte-for-byte.
  // Separate spans avoid placeholder tokens colliding with source text.
  const protectedSpans =
    /(?:https?:\/\/|www\.)\S+|\b10\.\d{4,9}\/\S+|\[[^[\]\r\n]*\]|［[^［］\r\n]*］/gi;
  let output = "";
  let end = 0;
  for (const match of text.matchAll(protectedSpans)) {
    if (/^[［[]/.test(match[0]) && typeCode(match[0].slice(1, -1))) continue;
    output += compact(text.slice(end, match.index)) + match[0];
    end = match.index! + match[0].length;
  }
  return output + compact(text.slice(end));
}
