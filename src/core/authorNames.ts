import { cleanText } from "./text";

export interface ParsedAuthorName {
  firstName?: string;
  lastName: string;
  fieldMode?: 1;
}

const PARTICLES = new Set([
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
  "zu",
  "zur",
]);
const COLLECTIVE =
  /\b(?:group|team|consortium|collaboration|committee|organization|organisation|institute|association|society|network|investigators)\b/i;

/** Preserve supplied spelling/initials while distinguishing common byline forms.
 * Truncation markers are not people; collective and CJK names stay single-field. */
export function parseAuthorName(raw: string): ParsedAuthorName | undefined {
  const value = cleanText(raw)
    .replace(
      /(?:[,;\s]*\bet\s+al\.?|\s+and\s+others|[，,\s]*等(?:人)?[。.]?)\s*$/i,
      "",
    )
    .replace(/^[,;\s]+|[,;\s]+$/g, "")
    .trim();
  if (!value || /^(?:\.{3}|…)$/.test(value)) return undefined;
  if (
    COLLECTIVE.test(value) ||
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\s·・]+$/u.test(
      value,
    )
  ) {
    return { lastName: value, fieldMode: 1 };
  }
  let name = value;
  let suffix = "";
  const suffixMatch = name.match(/(?:,\s*|\s+)((?:Jr|Sr|II|III|IV)\.?)$/);
  if (
    suffixMatch &&
    (name.slice(0, suffixMatch.index).trim().includes(" ") ||
      suffixMatch[0].startsWith(","))
  ) {
    suffix = suffixMatch[1];
    name = name.slice(0, suffixMatch.index).trim();
  }
  const finish = (family: string, given = ""): ParsedAuthorName => ({
    ...(given.trim() ? { firstName: given.trim() } : {}),
    lastName: [family.trim(), suffix].filter(Boolean).join(" "),
  });
  const comma = name.indexOf(",");
  if (comma > 0 && name.slice(comma + 1).trim())
    return finish(name.slice(0, comma), name.slice(comma + 1));
  const tokens = name.split(/\s+/);
  if (tokens.length === 1) return finish(name);
  const initial = (token: string) =>
    /^(?:[A-Z]\.)+$/.test(token) || /^[A-Z]{1,3}$/.test(token);
  // "LI Y" / "CHU AB" can be a short uppercase surname plus initials.
  // Without a full-name token or comma, retain the supplied name intact.
  if (tokens.every(initial)) return { lastName: value, fieldMode: 1 };
  // Vancouver/PubMed: "Molina JR", "de la Cruz A B", "Smith J.R.".
  let givenStart = tokens.length;
  while (givenStart > 0 && initial(tokens[givenStart - 1])) givenStart--;
  if (givenStart > 0 && givenStart < tokens.length) {
    return finish(
      tokens.slice(0, givenStart).join(" "),
      tokens.slice(givenStart).join(" "),
    );
  }
  // Given-family: retain surname particles instead of storing "Waals" alone.
  let familyStart = tokens.length - 1;
  while (
    familyStart > 0 &&
    PARTICLES.has(tokens[familyStart - 1].toLowerCase())
  )
    familyStart--;
  return finish(
    tokens.slice(familyStart).join(" "),
    tokens.slice(0, familyStart).join(" "),
  );
}

export function authorFamilyName(raw?: string): string {
  return (
    parseAuthorName(raw || "")?.lastName.replace(
      /\s+(?:Jr|Sr|II|III|IV)\.?$/,
      "",
    ) || ""
  );
}
