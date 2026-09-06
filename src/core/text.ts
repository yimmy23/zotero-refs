import type { Identifiers, RefItem } from "./types";

/**
 * Text analysis helpers: identifier extraction, raw reference-string parsing,
 * language detection, normalization. Pure functions, no Zotero UI access
 * except DOMParser via ztoolkit.
 */

export const REGEX = {
  DOI: /10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>]+[^.\]\s]/,
  /**
   * DOI as printed in a bibliography line: the text layer may break it
   * with a space after "." "/" or "-" ("10.1001/jama.2015. 13480",
   * "10.1080/ 01621459…", "doi.org/10. 1016/…"), so one whitespace run is
   * tolerated there — but only when the continuation carries a digit, so
   * "dyw323. pmid:28039382", "…0920. [PubMed]", "…01767-y. ll" and
   * "…pub2. Concurrent" stop at the DOI's real end.
   */
  DOI_PRINTED:
    /10\.\s?\d{4,9}\s?\/(?:[-._;()/:A-Za-z0-9<>]|(?<=[./-])\s+(?=[A-Za-z./]*\d))+/,
  arXiv: /arXiv[.:](\d{4}\.\d{4,5}(?:v\d+)?)/i,
  arXivOld: /arXiv[.:]([a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i,
  PMID: /PMID[:\s]*(\d{6,9})/i,
  URL: /https?:\/\/[^\s]+[^\s.,;)\]]/,
};

export function extractIdentifiers(text: string): Identifiers {
  const identifiers: Identifiers = {};
  const compact = text.replace(/\s+/g, "");
  // Two readings of the DOI. The whitespace-stripped text recovers DOIs
  // that the text layer broke anywhere ("doi. org/ 10. 1016/j. jclin epi.
  // 2016. 04. 014", "S0140 - 6736(21)02333 - 3") but runs the DOI into
  // whatever follows it ("…1234pmid:27891526", 6 % of all DOIs the parser
  // extracted) — so it is cut at the tokens a DOI never continues with.
  // The as-printed reading (DOI_PRINTED) tolerates a break only after
  // . / - and before a digit-bearing token, so it stops cleanly but
  // gives up on the badly broken ones. Take the longer of the two when
  // one is a prefix of the other, else the cut compact one.
  const cutDOI = (d: string) =>
    d
      .replace(
        /(pmid|pmcid|pmc\d|epub|accessed|available|published|retrieved|cited|erratum|http|www\.|\[).*$/i,
        "",
      )
      .replace(/\(\d{4}\).*$/, "") // "(2022)" a year in parens: citation text
      .replace(/(?<=\d)(?=[A-Z]\.).*$/, "") // "…0138944A.S.Goldfarb" initials
      // "…0597-xAvoidableflaws…": a capitalised word glued on — unless the
      // word is part of the DOI and continues with "." or a digit (eLife)
      .replace(/(?<=[\da-z])(?=[A-Z][a-z]{2,}(?![.\d])).*$/, "")
      .replace(/\.(?=[A-Z][a-z]{3,}).*$/, ""); // "…pub2.Concurrent"
  const printed = text.match(REGEX.DOI_PRINTED)?.[0].replace(/\s+/g, "");
  const compacted = compact.match(REGEX.DOI)?.[0];
  let doi: string | undefined;
  if (printed && compacted) {
    const cut = cutDOI(compacted);
    doi =
      printed.startsWith(cut) || cut.startsWith(printed)
        ? printed.length >= cut.length
          ? printed
          : cut
        : cut;
  } else if (compacted) {
    doi = cutDOI(compacted);
  } else {
    doi = printed;
  }
  if (doi) {
    // strip trailing punctuation that regex may swallow
    identifiers.DOI = doi.replace(/[.,;]+$/, "");
  }
  const arxiv = compact.match(REGEX.arXiv) || compact.match(REGEX.arXivOld);
  if (arxiv) {
    identifiers.arXiv = arxiv[1];
  }
  const pmid = text.match(REGEX.PMID);
  if (pmid) {
    identifiers.PMID = pmid[1];
  }
  return identifiers;
}

/**
 * Identifiers of a library item as the sources need them: DOI from the
 * field or Extra, PMID / arXiv from Extra or URL. Shared by every section
 * so a PubMed-imported item without a DOI field still gets references,
 * related works and a graph via PMID lookups.
 */
export function hostIdentifiers(item: Zotero.Item): Identifiers {
  const ids: Identifiers = {};
  const extra = (item.getField("extra") as string) || "";
  const url = (item.getField("url") as string) || "";
  let doi = ((item.getField("DOI") as string) || "").trim();
  if (!doi) doi = extra.match(/^DOI:\s*(10\.\S+)/im)?.[1] || "";
  if (doi) ids.DOI = doi;
  const arxiv =
    url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i)?.[1] ||
    extra.match(REGEX.arXiv)?.[1];
  if (arxiv) ids.arXiv = arxiv;
  const pmid =
    extra.match(/^PMID:\s*(\d+)/im)?.[1] ||
    url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/)?.[1];
  if (pmid) ids.PMID = pmid;
  return ids;
}

export function extractURL(text: string): string | undefined {
  const res = text.match(REGEX.URL);
  return res ? res[0] : undefined;
}

export function identifiersToURL(identifiers: Identifiers): string | undefined {
  if (identifiers.DOI)
    return `https://doi.org/${encodeURIComponent(identifiers.DOI)}`;
  if (identifiers.arXiv)
    return `https://arxiv.org/abs/${encodeURIComponent(identifiers.arXiv)}`;
  if (identifiers.PMID)
    return `https://pubmed.ncbi.nlm.nih.gov/${identifiers.PMID}/`;
  if (identifiers.CNKI) return identifiers.CNKI;
  if (identifiers.openAlex)
    return `https://openalex.org/${identifiers.openAlex}`;
  return undefined;
}

/** An explicit shared identifier conflict outweighs any title heuristic. */
export function identifiersConflict(a: Identifiers, b: Identifiers): boolean {
  for (const key of ["DOI", "arXiv", "PMID"] as const) {
    const normalize = (value: string) => {
      const normalized = value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
      // arXiv versions identify revisions of the same work, not distinct
      // papers. DOI/PMID disagreement still vetoes a metadata match.
      return key === "arXiv" ? normalized.replace(/v\d+$/, "") : normalized;
    };
    if (a[key] && b[key] && normalize(a[key]) !== normalize(b[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Only http(s) URLs may be persisted, written to items, or launched.
 * Remote APIs and untrusted PDFs can hand us file:/smb:/custom-scheme
 * URIs; Zotero.launchURL forwards anything but javascript/data/chrome to
 * the OS protocol handler.
 */
export function isHttpUrl(s?: string): s is string {
  return typeof s === "string" && /^https?:\/\/\S+$/i.test(s);
}

export function isDOI(text?: string): boolean {
  if (!text) return false;
  const res = text.match(REGEX.DOI);
  return !!res && res[0] === text && !/(cnki|issn)/i.test(text);
}

export function isChinese(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (!t.length) return false;
  return (t.match(/[一-龥]/g)?.length || 0) / t.length > 0.5;
}

export function htmlToText(html?: string): string {
  if (!html) return "";
  let text: string;
  try {
    const doc = ztoolkit
      .getDOMParser()
      .parseFromString(`<div>${html}</div>`, "text/html");
    text = doc.body?.textContent || html;
  } catch {
    text = html;
  }
  return text
    .replace(/<([\w:]+?)>([\s\S]+?)<\/\1>/g, (_m, _p1, p2) => p2)
    .replace(/\n+/g, " ")
    .trim();
}

/**
 * Strip HTML markup / entities that metadata APIs leave in titles
 * ("Resected <i>ALK</i>-Positive…", "&amp;"). Cheap path for the common
 * clean case; falls back to the DOM parser only when markup is present.
 */
export function cleanText<T extends string | undefined>(s: T): T {
  if (!s || (!s.includes("<") && !s.includes("&"))) return s;
  return (
    htmlToText(s)
      // markup boundaries leave whitespace scars: "<i>ALK</i>\n -Positive"
      .replace(/\s+/g, " ")
      .replace(/\s+([-–])(?=\S)/g, "$1")
      .replace(/\s+([,.;:!?)])/g, "$1")
      .replace(/\(\s+/g, "(")
      .trim() as T
  );
}

/** lowercase, keep only letters / digits / CJK — for title matching */
export function normalizeTitle(s?: string): string {
  if (!s) return "";
  return (
    s
      .toLowerCase()
      .match(/[0-9a-z一-龥]+/g)
      ?.join("") || ""
  );
}

/** Only exact normalized titles may promote a search result to metadata. */
export function titlesMatch(a?: string, b?: string): boolean {
  const title = normalizeTitle(cleanText(a));
  return !!title && title === normalizeTitle(cleanText(b));
}

/** A printed citation is not structured metadata. Only split at supported
 * author/date/document-type boundaries; never rank sentences by their length.
 */
function citationAuthors(value: string): string[] | undefined {
  const authorText = value
    .replace(/\bet\s+al\s*\./gi, "et al.")
    .replace(/(等|ほか)\s*\./g, "$1.")
    .replace(/([A-Za-z])\s*´\s*/g, "$1\u0301")
    .normalize("NFC")
    .replace(/,\s*(2nd|3rd|4th)\b/g, " $1")
    .replace(/^[\s,;.]+|[\s,;]+$/g, "")
    .replace(/\s*\(?\b(?:1[6-9]|20)\d{2}[a-z]?\)?\s*[.,;]?$/i, "")
    .trim();
  if (
    !authorText ||
    authorText.length > 600 ||
    /[\d:!?]/.test(authorText.replace(/\b(?:2nd|3rd|4th)\b/g, ""))
  )
    return undefined;
  const abbreviated = /\bet\s+al\.?$|(?:等|ほか)\.?$/i.test(authorText);
  const names = authorText
    .replace(/[,;\s]*(?:\bet\s+al\.?|等|ほか)[.,\s]*$/i, "")
    // APA's comma between a surname and its initials is part of one name.
    .replace(
      /([\p{L}’'\p{Pd}]),\s*((?:[A-Z]\.?[\s]*){1,5})(?=,|&|(?:2nd|3rd|4th)\b|$)/gu,
      "$1 $2",
    )
    .replace(/\s+(?:and|&)\s+/gi, ",")
    .replace(/,\s*&\s*/g, ",")
    .split(/[,;，；]/)
    .map((name) => name.trim().replace(/\.$/, ""))
    .filter(Boolean);
  const surname = "[\\p{L}’'\\p{Pd}]{2,}(?:\\s+[\\p{L}’'\\p{Pd}]{2,}){0,3}";
  const initials = "(?:[A-Z]\\.?\\s*){1,5}";
  const namePattern = new RegExp(
    `^(?:${surname}\\s+${initials}|${initials}\\s+${surname}|[\\p{Script=Han}]{2,5})$`,
    "u",
  );
  if (
    !names.length ||
    !names.every(
      (name) =>
        namePattern.test(
          name.replace(/\s+(?:Jr|Sr|II|III|IV|2nd|3rd|4th)\.?$/, ""),
        ) ||
        (!/[.?!:]/.test(name) &&
          /\b(?:group|team|consortium|collaboration|committee|organization|organisation|institute|association|society|network|investigators)$/i.test(
            name,
          )) ||
        (abbreviated && /^[\p{L}’'\p{Pd}]+$/u.test(name)),
    )
  )
    return undefined;
  // Keep the printed truncation marker: the final named author is not
  // necessarily the paper's last author when the bibliography says et al.
  if (abbreviated) names[names.length - 1] += " et al.";
  return names;
}

const CITATION_ABBREVIATION =
  /^(?:[A-Z]|e\.g|i\.e|vs|al|Dr|Prof|Jr|Sr|St|J|Am|Br|Can|Chin|Clin|Eur|Exp|Int|Nat|Natl|Engl|Med|Mol|Oncol|Res|Rev|Sci|Soc|Transl|Acad|Ann|Biol|Chem|Epidemiol|Gen|Immunol|Invest|Pathol|Pharmacol|Phys|Proc|Psychol|Rep|Stat|Surg|Ther|Vol|No|Thorac|Respir|Radiat|Environ|Biophys|Crit|Educ|Prev|Dis|Immunother|Front|Compr|Mod|Reg|Intern|Breath|Technol|Cardiothorac|Commun|Genet|Hematol|Deliv|Assoc)$/i;

/** Sentence boundaries, excluding initials and common journal abbreviations. */
function citationBreaks(value: string): { start: number; end: number }[] {
  const breaks: { start: number; end: number }[] = [];
  for (const match of value.matchAll(/[.!?。](?:\s*,)?\s+/g)) {
    const before = value.slice(0, match.index);
    const token = before.match(/([^\s]+)$/)?.[1] || "";
    if (match[0][0] === ".") {
      if (/^(?:e\.g|i\.e|vs|al|Dr|Prof|Jr|Sr|St)$/i.test(token)) continue;
      const segment = value.slice(breaks.at(-1)?.end || 0, match.index);
      const journalStart =
        /^(?:J|CA|Am|Br|Can|Chin|Clin|Eur|Exp|Int|Nat|Engl|Med|Mol|Oncol|Res|Rev|Sci|Transl|Ann|Biol|Chem|Epidemiol|Proc|Stat|Surg|Thorac|Respir|Radiat|Crit|Front|Curr|Cancer|Lancet|Cochrane|JNCI|Health|Dis|Mod)\b/;
      const journalWords = segment
        .split(/\s+/)
        .every(
          (word) =>
            /^[A-Z]/.test(word) || /^(?:of|the|and|in|for|de|&)$/.test(word),
        );
      if (
        (journalStart.test(segment) || /^[A-Z](?:$|\.\s)/.test(segment)) &&
        journalWords &&
        (CITATION_ABBREVIATION.test(token) || /^[A-Z][a-z]{1,8}$/.test(token))
      )
        continue;
    }
    breaks.push({ start: match.index!, end: match.index! + match[0].length });
  }
  return breaks;
}

function citationVenue(value: string): string | undefined {
  const venue = value
    .replace(/^[\s,;.。]+|[\s,;.。]+$/g, "")
    .replace(/^(?:In:\s*|Preprint at\s*)/i, "")
    .replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, "")
    .trim();
  if (
    !venue ||
    venue.length > 140 ||
    /[!?]|\b(?:https?|doi|PMID|ISBN)\b/i.test(venue) ||
    /\d/.test(venue)
  )
    return undefined;
  // The numeric publication suffix supplies the main evidence. This check
  // rules out prose endings while admitting full and abbreviated venues.
  const journalWord =
    /\b(?:journal|j|review|reviews|proceedings|transactions|bulletin|annals|nature|science|lancet|bmj|jama|nejm|plos|elife|medicine|medical|cancer|oncology|research|res|med|oncol|math|model|press|university|arxiv|medrxiv|biorxiv)\b|杂志|学报|出版社/i;
  const words = venue.split(/\s+/);
  const capitalized = words.every(
    (word) =>
      /^[A-Z\p{Script=Han}]/u.test(word) ||
      /^(?:of|the|and|in|for|de|&)$/.test(word),
  );
  return (words.length <= 9 && capitalized) ||
    (words.length === 1 && journalWord.test(venue))
    ? venue
    : undefined;
}

/** Local parsing for Vancouver, author-date/APA, quoted and GB/T citations.
 * Ambiguous citations retain their raw text instead of guessing a journal as
 * the title. The original citation always remains available in RefItem.text.
 */
export function parseRefText(text: string): {
  year?: string;
  authors?: string[];
  title: string;
  publicationVenue?: string;
} {
  const raw = text
    .replace(/^\s*(?:\[\d+\]|\(\d+\)|\d{1,3}[.)、．])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  // Identifier dates belong to identifiers, not the publication date. Do
  // not let a DOI such as tlcr.2020.03.40 replace the printed year 2021.
  const identifierStart = raw.search(
    /(?:\bdoi\s*:|https?:\/\/|\b10\.\d{4,9}\/|\bPMID\s*:|\bISBN\s*:|\bEpub\b)/i,
  );
  const body =
    identifierStart < 0
      ? raw
      : (
          raw.slice(0, identifierStart) +
          (raw
            .slice(identifierStart)
            .match(/\s+\((?:1[6-9]|20)\d{2}\)\.?$/)?.[0] || "")
        ).trim();
  const currentYear = new Date().getFullYear();
  const years = [...body.matchAll(/\b(1[6-9]\d{2}|20\d{2})[a-z]?\b/g)].filter(
    (match) => Number(match[1]) <= currentYear + 1,
  );
  let authors: string[] | undefined;
  let rest = "";
  let year: string | undefined;
  // APA/Harvard and comma-separated author-date citations have the most
  // explicit author/title boundary, including the year after dotted initials.
  for (const match of years) {
    if (match.index! > 605) break;
    const prefix = body.slice(0, match.index).replace(/[\s(,;.]+$/, "");
    const parsed = citationAuthors(prefix);
    const suffix = body.slice(match.index! + match[0].length);
    if (parsed && /^[)\s.,;:]+\S/.test(suffix)) {
      authors = parsed;
      year = match[1];
      rest = suffix.replace(/^[)\s.,;:]+/, "");
      break;
    }
  }
  if (!authors) {
    // Do not split A. B. Smith or an APA initials list at the first dot.
    for (const match of body.matchAll(/[.。:]\s*/g)) {
      if (match.index! > 600) break;
      const end = match.index! + 1;
      const parsed = citationAuthors(
        body.slice(0, match[0][0] === ":" ? match.index : end),
      );
      const suffix = body.slice(end).trim();
      if (
        parsed &&
        suffix &&
        !/^(?:[,;&]|[A-Z]\.(?:\s|,)|(?:and|et\s+al)\b)/.test(suffix)
      ) {
        authors = parsed;
        rest = suffix;
        break;
      }
    }
  }
  if (!authors || !rest) return { title: raw };

  const documentType = rest.match(
    /\[\s*(?:J|M|C|D|R|N|EB)(?:\s*\/\s*OL)?\s*\]/i,
  );
  const quoted = rest.match(/^[“"]([^”"]{4,})[”"]/);
  const quotedTitle =
    quoted &&
    (/[,.!?]$/.test(quoted[1]) ||
      /^\s*[,.;]/.test(rest.slice(quoted[0].length)));
  let title = "";
  let venueText = "";
  if (documentType) {
    title = rest.slice(0, documentType.index).trim();
    venueText = rest.slice(documentType.index! + documentType[0].length);
  } else if (quoted && quotedTitle) {
    title = quoted[1].replace(/,$/, "").trim();
    venueText = rest.slice(quoted[0].length);
  } else {
    // Publication metadata normally follows the venue. Search from the
    // right so years mentioned in the title cannot win over its printed date.
    const restYears = [
      ...rest.matchAll(/\b(1[6-9]\d{2}|20\d{2})[a-z]?\b/g),
    ].filter((match) => Number(match[1]) <= currentYear + 1);
    const numeric = [
      ...rest.matchAll(
        /\b\d{1,4}[A-Za-z]?\s*(?:\([^)]{1,20}\))?\s*[:,;]\s*(?:[A-Za-z]{0,8}\s*)?\d+[A-Za-z0-9]*\b/g,
      ),
    ];
    // Try each supported publication suffix. A year inside an APA title
    // must not prevent a later volume/page boundary from being examined.
    const metadataStarts = [
      ...new Set([
        ...restYears.map((match) => match.index!),
        ...numeric.map((match) => match.index!),
      ]),
    ].sort((a, b) => a - b);
    for (const metadataStart of metadataStarts) {
      const before = rest.slice(0, metadataStart).replace(/[\s,(.;]+$/, "");
      const boundaries = citationBreaks(before);
      for (const boundary of boundaries.reverse()) {
        const venue = citationVenue(before.slice(boundary.end));
        if (venue) {
          title = before
            .slice(
              0,
              boundary.start + (/[!?]/.test(before[boundary.start]) ? 1 : 0),
            )
            .trim();
          venueText = rest.slice(boundary.end);
          break;
        }
      }
      // Author-date citations often separate title and venue with a comma.
      // Only a journal-like suffix is accepted; commas inside titles stay.
      if (!title && year) {
        for (const match of [...before.matchAll(/,\s*/g)].reverse()) {
          const venue = citationVenue(
            before.slice(match.index! + match[0].length),
          );
          if (venue) {
            title = before
              .slice(0, match.index)
              .replace(/[.。]+$/, "")
              .trim();
            venueText = rest.slice(match.index! + match[0].length);
            break;
          }
        }
      }
      if (title) break;
    }
    // With a recognizable author segment but no journal boundary, a title
    // followed only by a date is still ambiguous (book vs truncated article).
    if (!title) return { title: raw };
  }
  if (!title || title.length < 3) return { title: raw };
  const venueYears = [
    ...venueText.matchAll(/\b(1[6-9]\d{2}|20\d{2})[a-z]?\b/g),
  ].filter((match) => Number(match[1]) <= currentYear + 1);
  const parentheticalYear = venueYears.find(
    (match) =>
      /(?:^|[^\d])\(\s*$/.test(venueText.slice(0, match.index)) &&
      /^\s*\)/.test(venueText.slice(match.index! + match[0].length)),
  );
  year ??=
    parentheticalYear?.[1] ||
    venueYears.find((match) => {
      const before = venueText.slice(0, match.index).trimEnd();
      const after = venueText.slice(match.index! + match[0].length).trimStart();
      return !/[-–‐:]$/.test(before) && !/^[-–‐]/.test(after);
    })?.[1];
  const venuePrefix = venueText
    .replace(/^[\s,;.。]+/, "")
    .split(/(?:,?\s*\(?\b(?:1[6-9]|20)\d{2}\b|[,;]\s*\d|\s+\d)/)[0];
  return {
    title: title
      .replace(/[.。]+$/, "")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, "")
      .trim(),
    authors,
    year,
    publicationVenue: citationVenue(venuePrefix),
  };
}

/** raw reference string -> minimal RefItem */
export function refTextToInfo(text: string): RefItem {
  const identifiers = extractIdentifiers(text);
  const parsed = parseRefText(text);
  return {
    identifiers,
    url: extractURL(text) || identifiersToURL(identifiers),
    authors: parsed.authors || [],
    title: parsed.title,
    year: parsed.year,
    primaryVenue: parsed.publicationVenue,
    text,
    type: identifiers.arXiv ? "preprint" : "journalArticle",
  };
}

export function parseCNKIURL(cnkiURL?: string) {
  if (!cnkiURL) return undefined;
  try {
    const fileName = cnkiURL.match(/filename=(\w+)/i)![1];
    const dbName = cnkiURL.match(/dbname=(\w+)/i)![1];
    const dbCode = cnkiURL.match(/dbcode=(\w+)/i)?.[1] || dbName.slice(0, 4);
    return { fileName, dbName, dbCode };
  } catch {
    return undefined;
  }
}

/** shorten long strings for progress windows */
export function collapseText(text: string, n?: number): string {
  const limit = n ?? (isChinese(text) ? 15 : 35);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}
