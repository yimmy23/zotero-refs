import { cleanText } from "../core/text";
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
function directElements(parent: Node, name: string): Element[] {
  return Array.from(parent.childNodes).filter(
    (node): node is Element =>
      !!node && node.nodeType === 1 && node.nodeName === name,
  );
}

function extractAbstractText(raw: string, pmid: string): string | undefined {
  try {
    const doc = ztoolkit.getDOMParser().parseFromString(raw, "text/xml");
    if (
      doc.getElementsByTagName("parsererror").length ||
      doc.documentElement?.nodeName !== "PubmedArticleSet"
    )
      return undefined;
    // Direct-child traversal also works in XML DOMs without CSS selectors.
    // Never accept a cited/related PMID nested elsewhere in the response.
    const citation = directElements(doc.documentElement, "PubmedArticle")
      .flatMap((article) => directElements(article, "MedlineCitation"))
      .find(
        (node) => directElements(node, "PMID")[0]?.textContent?.trim() === pmid,
      );
    if (!citation) return undefined;
    const parts = directElements(citation, "Article")
      .flatMap((article) => directElements(article, "Abstract"))
      .flatMap((abstract) => directElements(abstract, "AbstractText"))
      .map((node) => {
        // XML textContent already removes inline elements and decodes
        // entities. Re-parsing it as HTML would erase literal <comparisons>.
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) return "";
        const label = (node.getAttribute("Label") || "")
          .replace(/\s+/g, " ")
          .trim();
        return label ? `${label}: ${text}` : text;
      })
      .filter(Boolean);
    return parts.join("\n\n") || undefined;
  } catch (error) {
    ztoolkit.log("[pubmed] abstract XML parse failed", error);
    return undefined;
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
    const abstract = raw ? extractAbstractText(raw, pmid) : undefined;

    const pubtypes: string[] = Array.isArray(result.pubtype)
      ? result.pubtype
      : [];
    return {
      identifiers,
      title: cleanText(result.title),
      authors,
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
