import { cleanText } from "../core/text";
import { normalizeAbstractText } from "../core/abstractText";
import { http } from "../core/http";
import type { Identifiers, MetaSource, RefItem } from "../core/types";

/**
 * PubMed via NCBI E-utilities (eutils.ncbi.nlm.nih.gov). Free, no key
 * required (though NCBI asks for an API key above ~3 req/s — we stay under
 * that via the host concurrency gate in core/http.ts).
 */

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

/**
 * Only the primary article's AbstractText elements are abstract content.
 * The plaintext efetch format also contains titles, authors and affiliations.
 */
function directElements(parent: Node | undefined, name: string): Element[] {
  return Array.from(parent?.childNodes || []).filter(
    (node): node is Element =>
      !!node && node.nodeType === 1 && node.nodeName === name,
  );
}

function abstractMarkup(node: Node | null): string {
  if (!node) return "";
  if (node.nodeType === 3 || node.nodeType === 4) {
    return (node.nodeValue || "")
      .replace(/\s+/g, " ")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  const text = Array.from(node.childNodes).map(abstractMarkup).join("");
  const tag = node.nodeName.toLowerCase();
  if (tag === "sup" || tag === "sub") return `<${tag}>${text}</${tag}>`;
  return tag === "p" || tag === "br" ? `\n\n${text}\n\n` : text;
}

/** EFetch alone is enough to fill an abstract; avoid an extra summary request. */
export function extractAbstractRecord(
  raw: string,
  pmid: string,
  expectedDOI?: string,
): RefItem | null {
  try {
    if (typeof raw !== "string" || raw.length > 2_000_000) return null;
    // NCBI sends this external DTD routinely. Strip it without resolving it;
    // reject internal entities or unexpected declarations before parsing.
    const safe = raw.replace(
      /<!DOCTYPE\s+PubmedArticleSet\s+PUBLIC\s+"[^"[\]]*"\s+"https?:\/\/dtd\.nlm\.nih\.gov\/ncbi\/pubmed\/out\/pubmed_\d+\.dtd"\s*>/i,
      "",
    );
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(safe)) return null;
    const doc = ztoolkit.getDOMParser().parseFromString(safe, "text/xml");
    if (
      doc.getElementsByTagName("parsererror").length ||
      doc.documentElement?.nodeName !== "PubmedArticleSet"
    )
      return null;
    // Direct-child traversal also works in XML DOMs without CSS selectors.
    // Never accept a cited/related PMID nested elsewhere in the response.
    const record = directElements(doc.documentElement, "PubmedArticle").find(
      (node) =>
        directElements(
          directElements(node, "MedlineCitation")[0],
          "PMID",
        )[0]?.textContent?.trim() === pmid,
    );
    if (!record) return null;
    const citation = directElements(record, "MedlineCitation")[0];
    const article = directElements(citation, "Article")[0];
    if (!article) return null;
    const doiNodes = directElements(article, "ELocationID")
      .filter(
        (node) =>
          node.getAttribute("EIdType") === "doi" &&
          node.getAttribute("ValidYN") !== "N",
      )
      .concat(
        directElements(record, "PubmedData")
          .flatMap((data) => directElements(data, "ArticleIdList"))
          .flatMap((list) => directElements(list, "ArticleId"))
          .filter((node) => node.getAttribute("IdType") === "doi"),
      );
    const dois = doiNodes
      .map((node) => (node.textContent || "").trim().toLowerCase())
      .filter((doi) => /^10\.\d{4,9}\/[^\s"<>]+$/.test(doi));
    if (expectedDOI && !dois.includes(expectedDOI)) return null;
    const parts = directElements(article, "Abstract")
      .flatMap((abstract) => directElements(abstract, "AbstractText"))
      .map((node) => {
        // Escape decoded DOM text before the one normalization boundary so
        // comparisons/entities survive alongside scientific superscripts.
        const text = normalizeAbstractText(abstractMarkup(node));
        if (!text) return "";
        const label = (
          node.getAttribute("Label") ||
          node.getAttribute("NlmCategory") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        return label && label !== "UNASSIGNED" ? `${label}: ${text}` : text;
      })
      .filter(Boolean);
    const journal = directElements(article, "Journal")[0];
    const date = directElements(journal, "JournalIssue").flatMap((issue) =>
      directElements(issue, "PubDate"),
    )[0];
    const year = (
      directElements(date, "Year")[0]?.textContent ||
      directElements(date, "MedlineDate")[0]?.textContent ||
      ""
    ).match(/\b\d{4}\b/)?.[0];
    const authorLists = directElements(article, "AuthorList");
    const authors = authorLists
      .flatMap((list) => directElements(list, "Author"))
      .map((author) => {
        const last = directElements(author, "LastName")[0]?.textContent?.trim();
        const given =
          directElements(author, "ForeName")[0]?.textContent?.trim() ||
          directElements(author, "Initials")[0]?.textContent?.trim();
        return last
          ? [given, last].filter(Boolean).join(" ")
          : directElements(author, "CollectiveName")[0]?.textContent?.trim() ||
              "";
      });
    return {
      identifiers: {
        PMID: pmid,
        ...(dois.length ? { DOI: expectedDOI || dois[0] } : {}),
      },
      title:
        directElements(article, "ArticleTitle")[0]?.textContent?.trim() ||
        undefined,
      authors:
        authorLists.every((list) => list.getAttribute("CompleteYN") !== "N") &&
        authors.every(Boolean)
          ? authors
          : [],
      authorsTruncated:
        authorLists.some((list) => list.getAttribute("CompleteYN") === "N") ||
        authors.some((name) => !name) ||
        undefined,
      year,
      primaryVenue:
        directElements(journal, "Title")[0]?.textContent?.trim() || undefined,
      abstract: parts.join("\n\n") || undefined,
      source: "pubmed",
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    };
  } catch (error) {
    ztoolkit.log("[pubmed] abstract XML parse failed", error);
    return null;
  }
}

export const pubmed: MetaSource & {
  getInfoByPMID(pmid: string): Promise<RefItem | null>;
  getInfoByTitle(title: string, refText?: string): Promise<RefItem | null>;
} = {
  id: "pubmed",

  async getInfoByPMID(pmid: string): Promise<RefItem | null> {
    const summaryUrl =
      `${BASE}/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}` +
      `&retmode=json`;
    const summaryRes = await http.getJSON(summaryUrl);
    const result = summaryRes?.result?.[pmid];
    if (!result || result.error) return null;

    const authors: string[] = Array.isArray(result.authors)
      ? result.authors.map((a: any) => a.name).filter(Boolean)
      : [];
    const year: string | undefined = result.pubdate
      ? result.pubdate.match(/\d{4}/)?.[0]
      : undefined;
    const doiEntry = Array.isArray(result.articleids)
      ? result.articleids.find((a: any) => a.idtype === "doi")
      : undefined;

    const identifiers: Identifiers = { PMID: pmid };
    if (doiEntry?.value) identifiers.DOI = doiEntry.value;

    const abstractUrl =
      `${BASE}/efetch.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}` +
      `&retmode=xml`;
    const raw = await http.getText(abstractUrl);
    const full = raw ? extractAbstractRecord(raw, pmid) : null;
    const abstract = full?.abstract;

    const pubtypes: string[] = Array.isArray(result.pubtype)
      ? result.pubtype
      : [];
    return {
      identifiers,
      title: cleanText(result.title),
      authors: full?.authors.length ? full.authors : authors,
      authorsTruncated: full?.authorsTruncated,
      year,
      primaryVenue: cleanText(result.fulljournalname),
      abstract,
      source: "pubmed",
      type: "journalArticle",
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      retracted: pubtypes.some((t) => /^retracted publication$/i.test(t))
        ? true
        : undefined,
    };
  },

  async getInfoByTitle(title: string): Promise<RefItem | null> {
    // default esearch order is most-recent-first, which ranks "Author
    // Correction: X" above X — ask for relevance and skip errata
    const searchUrl =
      `${BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(title)}` +
      `[Title]&retmode=json&retmax=3&sort=relevance`;
    const res = await http.getJSON(searchUrl);
    const ids: string[] = res?.esearchresult?.idlist;
    if (!Array.isArray(ids) || !ids.length) return null;
    for (const id of ids) {
      const info = await pubmed.getInfoByPMID(id);
      if (!info) continue;
      if (
        /^(author correction|correction|erratum|retraction)/i.test(
          info.title || "",
        )
      ) {
        continue;
      }
      return info;
    }
    return null;
  },
};
