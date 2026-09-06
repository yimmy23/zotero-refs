/** Adapted from the local Zest abstract text formatter (zotero-style-rewrite). */
/** Abstracts are rendered as text only; neither helper creates or parses a DOM. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  hairsp: " ",
  NewLine: "\n",
  ndash: "–",
  mdash: "—",
  minus: "−",
  hyphen: "‐",
  shy: "",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  prime: "′",
  Prime: "″",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  equiv: "≡",
  asymp: "≈",
  approx: "≈",
  plusmn: "±",
  times: "×",
  divide: "÷",
  deg: "°",
  micro: "µ",
  permil: "‰",
  infin: "∞",
  radic: "√",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  copy: "©",
  reg: "®",
  trade: "™",
  dagger: "†",
  Dagger: "‡",
};

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "sec",
  "title",
  "abstract",
  "li",
  "list-item",
  "tr",
  "blockquote",
]);
const HIDDEN_TAGS = new Set(["script", "style", "template"]);
const INLINE_TAGS = new Set(
  (
    "a abbr acronym b big cite code del dfn em font i img ins kbd mark q s samp " +
    "small span strike strong sub sup tt u var wbr bold italic monospace " +
    "overline roman sans-serif sc styled-content underline ext-link xref " +
    "named-content inline-formula disp-formula inline-graphic graphic label " +
    "math mrow mi mn mo mtext ms mspace msub msup msubsup mfrac msqrt mroot " +
    "munder mover munderover mtable mtr mtd semantics annotation annotation-xml " +
    "ul ol dl dt dd table thead tbody tfoot td th caption"
  ).split(" "),
);
// Real attributes need a value, apart from HTML's standard boolean attributes.
// Accepting arbitrary bare words would mistake "A<B and C>D" for a bold tag.
const TAG_ATTRIBUTES =
  /^(?:\s+[a-z_:][a-z\d:_.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)|\s+(?:allowfullscreen|async|autofocus|autoplay|checked|controls|default|defer|disabled|formnovalidate|hidden|inert|ismap|itemscope|loop|multiple|muted|nomodule|novalidate|open|playsinline|readonly|required|reversed|selected)(?=\s|$))*\s*$/i;

function isMarkupTag(name: string, token: string): boolean {
  const local = name.toLowerCase().split(":").pop()!;
  if (HIDDEN_TAGS.has(local)) return true;
  if (!name.includes(":") && !BLOCK_TAGS.has(local) && !INLINE_TAGS.has(local))
    return false;
  const closing = token.startsWith("</");
  const attributes = token
    .slice(name.length + (closing ? 2 : 1), -1)
    .replace(/\/\s*$/, "");
  return closing ? /^\s*$/.test(attributes) : TAG_ATTRIBUTES.test(attributes);
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/gi,
    (entity, code: string) => {
      if (!code.startsWith("#"))
        return Object.hasOwn(ENTITIES, code) ? ENTITIES[code] : entity;
      const hex = code[1].toLowerCase() === "x";
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (
        point <= 0 ||
        point > 0x10ffff ||
        (point >= 0xd800 && point <= 0xdfff)
      ) {
        return entity;
      }
      return String.fromCodePoint(point);
    },
  );
}

function scriptText(text: string, tag: string): string {
  const from = "0123456789+-−=()";
  const to = tag === "sup" ? "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾" : "₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎";
  if (!text) return "";
  if ([...text].every((c) => from.includes(c)))
    return [...text].map((c) => to[from.indexOf(c)]).join("");
  // Flattening <sup>n</sup> to n would change the formula. Keep explicit
  // notation for symbols without a Unicode counterpart; decode entities once
  // at the normal final boundary, not inside this operation.
  return `${tag === "sup" ? "^" : "_"}(${text})`;
}

export function normalizeAbstractText(raw: string): string {
  // A tag must start with a letter and have a tag-name boundary. In particular,
  // a clinical result such as P<0.001 ... >90% is not markup.
  const markup =
    /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)\]\]>|<\/?([a-z][a-z\d:_-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const parts: string[] = [];
  const scripts: Array<{ tag: string; start: number }> = [];
  let end = 0;
  let hidden: string | undefined;
  for (const match of raw.matchAll(markup)) {
    const token = match[0];
    if (!hidden) parts.push(raw.slice(end, match.index));
    if (match[2] && !isMarkupTag(match[2], token)) {
      if (!hidden) parts.push(token);
      end = match.index + token.length;
      continue;
    }
    const tag = match[2]?.toLowerCase().split(":").pop();
    const closing = token.startsWith("</");
    if (hidden) {
      if (closing && tag === hidden) hidden = undefined;
    } else if (
      tag &&
      HIDDEN_TAGS.has(tag) &&
      !closing &&
      !token.endsWith("/>")
    ) {
      hidden = tag;
    } else if (match[1] !== undefined) {
      parts.push(match[1]);
    } else if (tag && BLOCK_TAGS.has(tag)) {
      parts.push("\n\n");
    } else if (tag === "sup" || tag === "sub") {
      if (closing && scripts.at(-1)?.tag === tag) {
        const { start } = scripts.pop()!;
        parts.push(scriptText(parts.splice(start).join(""), tag));
      } else if (!closing && !token.endsWith("/>")) {
        scripts.push({ tag, start: parts.length });
      }
    }
    end = match.index + token.length;
  }
  if (!hidden) parts.push(raw.slice(end));
  while (scripts.length) {
    const { tag, start } = scripts.pop()!;
    parts.push(scriptText(parts.splice(start).join(""), tag));
  }
  return normalizeWhitespace(decodeEntities(parts.join("")));
}

const HEADINGS = [
  "Background and objectives",
  "Background and aims",
  "Background and purpose",
  "Patients and methods",
  "Materials and methods",
  "Methods and results",
  "Design, setting, and participants",
  "Design, setting and participants",
  "Main outcomes and measures",
  "Main outcome measures",
  "Conclusions and relevance",
  "Clinical trial registration",
  "Trial registration",
  "Research in context",
  "Background",
  "Objectives",
  "Objective",
  "Purpose",
  "Importance",
  "Context",
  "Introduction",
  "Aims",
  "Aim",
  "Methods",
  "Design",
  "Setting",
  "Participants",
  "Interventions",
  "Intervention",
  "Results",
  "Findings",
  "Discussion",
  "Conclusions",
  "Conclusion",
  "Interpretation",
  "Funding",
  "Registration",
  "研究背景",
  "研究目的",
  "研究方法",
  "研究结果",
  "材料与方法",
  "患者与方法",
  "临床试验注册",
  "试验注册",
  "基金资助",
  "背景",
  "目的",
  "方法",
  "结果",
  "结论",
  "讨论",
  "意义",
  "资助",
].sort((a, b) => b.length - a.length);
const HEADING_PATTERN = HEADINGS.join("|");
const STANDALONE_HEADING = new RegExp(`^(?:${HEADING_PATTERN})[：:]?$`, "i");
const INLINE_HEADINGS = new RegExp(
  `(^|[\\s.!?;。！？；])(${HEADING_PATTERN})\\s*[：:]`,
  "gi",
);

export interface AbstractParagraph {
  heading?: string;
  text: string;
}

export function abstractParagraphs(
  raw: string,
  options: { plainText?: boolean } = {},
): AbstractParagraph[] {
  // Cached/provider text has already been decoded. Parsing it as markup again
  // would erase literal tags or decode an entity a second time.
  const normalized = options.plainText
    ? normalizeWhitespace(raw)
    : normalizeAbstractText(raw);
  if (!normalized) return [];
  const paragraphs: AbstractParagraph[] = [];
  let pendingHeading: string | undefined;
  const append = (text: string, heading?: string) => {
    const body = text.trim();
    if (body) {
      paragraphs.push({ ...(heading ? { heading } : {}), text: body });
    } else if (heading) {
      paragraphs.push({ text: heading });
    }
  };
  for (const line of normalized.split(/\n+/)) {
    if (STANDALONE_HEADING.test(line)) {
      // Preserve consecutive heading-only lines rather than silently dropping one.
      if (pendingHeading) append(pendingHeading);
      pendingHeading = line.replace(/[：:]$/, "");
      continue;
    }
    let start = 0;
    let heading = pendingHeading;
    pendingHeading = undefined;
    for (const match of line.matchAll(INLINE_HEADINGS)) {
      const index = match.index + match[1].length;
      if (index > 0) {
        let before = index - 1;
        while (before >= 0 && /\s/.test(line[before])) before--;
        const sentenceBoundary =
          before >= 0 && /[.!?;。！？；]/.test(line[before]);
        // A heading within ordinary prose needs a sentence boundary. Once a
        // structured section has begun, capitalized headings may follow just
        // a space; lower-case prose such as "these methods:" stays untouched.
        if (!heading && !sentenceBoundary) continue;
        if (/^[a-z]/.test(match[2]) && !(heading && sentenceBoundary)) continue;
      }
      append(line.slice(start, index), heading);
      heading = match[2];
      start = match.index + match[0].length;
    }
    append(line.slice(start), heading);
  }
  if (pendingHeading) append(pendingHeading);
  return paragraphs;
}
