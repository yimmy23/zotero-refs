import { identifiersConflict, normalizeTitle, refTextToInfo } from "./text";
import type { RefItem } from "./types";

/**
 * Fuse the two readings of a bibliography into the single list the panel
 * shows: the PDF parse is the skeleton (it knows which entries the paper
 * actually prints, their order, numbering, raw text and in-page anchors),
 * and the API list (Crossref / S2 / OpenAlex) enriches each entry with the
 * metadata the PDF text lacks — above all the DOI.
 *
 * Historical validation of the earlier implementation used 699 papers with a DOI,
 * `.corpus/offline-harness/fuse-exp.mjs`): 83.9 % of PDF entries found
 * their API record, DOI coverage of the list rose from 19 % to 80 %, and
 * the title rule produced zero DOI-contradicted matches in a decoy test
 * against unrelated papers' reference lists. Those figures are not an accuracy
 * estimate for the current stricter matching rules.
 *
 * Matching keys, strictest first, each API record usable once:
 *  1. identifier equality (DOI / PMID / arXiv);
 *  2. the API title (≥ 25 normalized chars) appears inside the PDF entry
 *     text AND the year matches AND the first author's surname appears at
 *     the head of the entry AND exactly one candidate survives — a
 *     deliberate, narrow exception to the no-mid-string-containment rule:
 *     with all four conditions a false match requires two different papers
 *     sharing title, year and first author;
 *  3. volume + first page + year all present in the PDF entry (Crossref
 *     rows that carry no title and no DOI);
 *  4. position — only for Crossref (the deposited list is the publisher's
 *     own, in print order), only when the counts agree and the PDF
 *     numbering is 1..n, and only after the order is VERIFIED: by the
 *     DOI pairs both sides know (≥ 3, all agreeing), or, when the
 *     PDF prints no DOIs at all, by resolving up to five of the API DOIs
 *     and finding corroborated titles and years at the same index (at
 *     least two successful lookups, with no contradictory spot checks).
 *
 * Enrichment only fills what the PDF entry lacks; on conflict the PDF's
 * own identifier wins and the API record is not matched positionally.
 * The PDF entries are never dropped or reordered.
 *
 * API records that match nothing are appended at the tail ONLY when the
 * API list is genuinely longer than the PDF one (a truncated parse) —
 * when the counts agree, the unmatched remainders on both sides are almost
 * certainly the same entries pairwise, and appending would duplicate them.
 */

export interface FuseStats {
  /** PDF entries enriched, by matching key */
  id: number;
  title: number;
  volPage: number;
  positional: number;
  /** PDF entries left as parsed */
  unmatched: number;
  /** API-only records appended at the tail */
  appended: number;
  /** how the positional key was validated (for the debug log) */
  posMode: string;
}

export interface FuseResult {
  refs: RefItem[];
  /** index in `refs` where the appended API-only tail starts */
  tailStart: number;
  stats: FuseStats;
}

const normDOI = (d?: string) =>
  (d || "")
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .trim();

const surname = (author?: string) =>
  normalizeTitle((author || "").split(/[,\s]/)[0]);

/** A parsed title must agree completely; raw-text fallback needs an author. */
function titleEvidence(pdf: RefItem, remote: RefItem): boolean {
  const title = normalizeTitle(remote.title);
  if (!title) return false;
  const raw = normalizeTitle(pdf.text);
  const parsed = normalizeTitle(
    pdf.title || refTextToInfo(pdf.text || "").title,
  );
  if (parsed && parsed !== raw) return parsed === title;
  const author = surname(remote.authors?.[0]);
  return (
    title.length >= 25 &&
    raw.includes(title) &&
    author.length >= 2 &&
    normalizeTitle((pdf.text || "").slice(0, 80)).includes(author)
  );
}

/**
 * Merge one API record into a PDF entry. Identifiers printed in the PDF
 * are exact and win; everything else guessed from the raw text (title,
 * authors, year — parseRefText took the quoted span "real-world" for a
 * title once) loses to the API's structured metadata. The entry's text,
 * number and anchors are the PDF's and never change.
 */
function enrich(p: RefItem, a: RefItem): RefItem {
  const tags = [...(p.tags || [])];
  for (const t of a.tags || []) {
    if (
      !tags.some(
        (x) =>
          (typeof x === "string" ? x : x.text) ===
          (typeof t === "string" ? t : t.text),
      )
    ) {
      tags.push(t);
    }
  }
  return {
    ...p,
    identifiers: { ...a.identifiers, ...p.identifiers },
    title: a.title || p.title,
    authors: a.authors?.length ? a.authors : p.authors,
    firstAuthors: a.firstAuthors?.length ? a.firstAuthors : p.firstAuthors,
    correspondingAuthors: a.correspondingAuthors?.length
      ? a.correspondingAuthors
      : p.correspondingAuthors,
    year: a.year || p.year,
    publishDate: a.publishDate || p.publishDate,
    primaryVenue: a.primaryVenue || p.primaryVenue,
    abstract: a.abstract || p.abstract,
    oaUrl: a.oaUrl || p.oaUrl,
    url: p.url || a.url,
    type: a.type || p.type,
    citationCount: p.citationCount ?? a.citationCount,
    referenceCount: p.referenceCount ?? a.referenceCount,
    source: a.source ?? p.source,
    retracted: p.retracted || a.retracted,
    tags: tags.length ? tags : undefined,
  };
}

export async function fuseReferences(
  pdfRefs: RefItem[],
  apiRefs: RefItem[],
  apiSource: string | null | undefined,
  /** metadata lookup for the positional spot check (crossref.getInfoByDOI) */
  resolveDOI?: (doi: string) => Promise<RefItem | null>,
): Promise<FuseResult> {
  const stats: FuseStats = {
    id: 0,
    title: 0,
    volPage: 0,
    positional: 0,
    unmatched: 0,
    appended: 0,
    posMode: "off",
  };
  if (!pdfRefs.length || !apiRefs.length) {
    const refs = pdfRefs.length ? pdfRefs : apiRefs;
    stats.unmatched = pdfRefs.length;
    stats.appended = pdfRefs.length ? 0 : apiRefs.length;
    return { refs: [...refs], tailStart: refs.length, stats };
  }

  const api = apiRefs.map((r) => ({
    r,
    doi: normDOI(r.identifiers?.DOI),
    pmid: r.identifiers?.PMID,
    arxiv: r.identifiers?.arXiv,
    title: normalizeTitle(r.title),
    year: r.year,
    sur: surname(r.authors?.[0]),
    /** crossref structured text ends "…, volume, first-page" */
    volPage: r.text?.match(/(?:^|,\s*)(\d{1,4}),\s*([A-Za-z]?\d{1,6})\s*$/),
  }));

  // ---- positional pre-check (key 4) ----
  let posOK = false;
  if (
    apiSource === "crossref" &&
    pdfRefs.length === apiRefs.length &&
    pdfRefs.every((r, i) => r.number === i + 1)
  ) {
    let checked = 0;
    let agree = 0;
    pdfRefs.forEach((p, i) => {
      const a = api[i].doi;
      const b = normDOI(p.identifiers?.DOI);
      if (a && b) {
        checked++;
        if (a === b) agree++;
      }
    });
    if (checked > 0) {
      posOK = agree >= 3 && agree === checked;
      stats.posMode = posOK
        ? `doi-verified ${agree}/${checked}`
        : `rejected ${agree}/${checked}`;
    } else if (resolveDOI) {
      // no DOIs printed in the PDF: resolve a few API DOIs and look for
      // their titles in the PDF entries at the same index
      const n = apiRefs.length;
      const idx = new Set<number>();
      for (let k = 0; k < Math.min(5, n); k++) {
        idx.add(Math.floor((k * n) / Math.min(5, n)));
      }
      let tried = 0;
      let ok = 0;
      for (const i of idx) {
        const doi = apiRefs[i]?.identifiers?.DOI;
        if (!doi) continue;
        let meta: RefItem | null = null;
        try {
          meta = await resolveDOI(doi);
        } catch {
          // lookup failure = no evidence
        }
        if (!meta) continue;
        tried++;
        const p = pdfRefs[i];
        const author = surname(meta.authors?.[0]);
        const supportedShortTitle =
          normalizeTitle(meta.title).length >= 15 ||
          (author.length >= 2 &&
            normalizeTitle((p.text || "").slice(0, 80)).includes(author));
        if (
          titleEvidence(p, meta) &&
          supportedShortTitle &&
          meta.year &&
          (p.text || "").includes(String(meta.year)) &&
          !identifiersConflict({ DOI: doi }, meta.identifiers) &&
          !identifiersConflict(p.identifiers, meta.identifiers)
        )
          ok++;
      }
      posOK = tried >= 2 && ok === tried;
      stats.posMode = tried
        ? `${posOK ? "spot-verified" : "spot-rejected"} ${ok}/${tried}`
        : "unverified";
    } else {
      stats.posMode = "unverified";
    }
  }

  const used = new Set<number>();
  const out: RefItem[] = [];
  for (let pi = 0; pi < pdfRefs.length; pi++) {
    const p = pdfRefs[pi];
    const pText = p.text || "";
    const pDoi = normDOI(p.identifiers?.DOI);
    const conflicts = (j: number) =>
      identifiersConflict(p.identifiers, api[j].r.identifiers);
    let hit = -1;
    let how: "id" | "title" | "volPage" | "positional" | "" = "";
    // 1. identifier equality
    if (pDoi) {
      const i = api.findIndex(
        (a, j) => !used.has(j) && !conflicts(j) && a.doi && a.doi === pDoi,
      );
      if (i >= 0) {
        hit = i;
        how = "id";
      }
    }
    if (hit < 0 && p.identifiers?.PMID) {
      const i = api.findIndex(
        (a, j) =>
          !used.has(j) &&
          !conflicts(j) &&
          a.pmid &&
          a.pmid === p.identifiers.PMID,
      );
      if (i >= 0) {
        hit = i;
        how = "id";
      }
    }
    if (hit < 0 && p.identifiers?.arXiv) {
      const i = api.findIndex(
        (a, j) =>
          !used.has(j) &&
          !conflicts(j) &&
          a.arxiv &&
          a.arxiv === p.identifiers.arXiv,
      );
      if (i >= 0) {
        hit = i;
        how = "id";
      }
    }
    // 2. title + year + first-author surname, unique
    if (hit < 0) {
      const cands: number[] = [];
      api.forEach((a, j) => {
        if (used.has(j) || conflicts(j) || a.title.length < 25 || !a.year)
          return;
        if (!titleEvidence(p, a.r)) return;
        if (!pText.includes(String(a.year))) return;
        if (
          a.sur &&
          a.sur.length >= 2 &&
          !normalizeTitle(pText.slice(0, 80)).includes(a.sur)
        ) {
          return;
        }
        cands.push(j);
      });
      if (cands.length === 1) {
        hit = cands[0];
        how = "title";
      }
    }
    // 3. year + volume + first page
    if (hit < 0) {
      const cands: number[] = [];
      api.forEach((a, j) => {
        if (used.has(j) || conflicts(j) || !a.year || !a.volPage) return;
        if (
          a.sur.length < 2 ||
          !normalizeTitle(pText.slice(0, 80)).includes(a.sur)
        )
          return;
        if (a.title && !titleEvidence(p, a.r)) return;
        const [, vol, fp] = a.volPage;
        const re = new RegExp(
          `(?<!\\d)${vol}(?!\\d).{0,12}?(?<!\\d)${fp}(?!\\d)`,
        );
        if (!pText.includes(String(a.year)) || !re.test(pText)) return;
        if (
          a.sur &&
          a.sur.length >= 2 &&
          !normalizeTitle(pText.slice(0, 80)).includes(a.sur)
        ) {
          return;
        }
        cands.push(j);
      });
      if (cands.length === 1) {
        hit = cands[0];
        how = "volPage";
      }
    }
    // 4. verified position — never against a conflicting identifier or year
    if (hit < 0 && posOK) {
      const a = api[pi];
      if (
        a &&
        !used.has(pi) &&
        (!a.year || pText.includes(String(a.year))) &&
        (!a.title || titleEvidence(p, a.r)) &&
        !conflicts(pi)
      ) {
        hit = pi;
        how = "positional";
      }
    }
    if (hit >= 0 && how) {
      used.add(hit);
      stats[how]++;
      out.push(enrich(p, api[hit].r));
    } else {
      stats.unmatched++;
      out.push({ ...p });
    }
  }

  // ---- API-only tail: only when the API list is genuinely longer ----
  const tailStart = out.length;
  const leftover = apiRefs.length - used.size;
  if (
    apiRefs.length > pdfRefs.length &&
    leftover > Math.max(2, 0.1 * pdfRefs.length)
  ) {
    apiRefs.forEach((a, j) => {
      if (used.has(j)) return;
      stats.appended++;
      // no anchors: the reader hover/jump must skip these
      out.push({ ...a, x: undefined, y: undefined, page: undefined });
    });
  }
  return { refs: out, tailStart, stats };
}
