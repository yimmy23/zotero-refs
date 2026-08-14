import { http } from "../core/http";
import type { Identifiers, MetaSource, RefItem } from "../core/types";

/**
 * PubMed via NCBI E-utilities (eutils.ncbi.nlm.nih.gov). Free, no key
 * required (though NCBI asks for an API key above ~3 req/s — we stay under
 * that via the host concurrency gate in core/http.ts).
 */

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

/**
 * efetch's plaintext "abstract" rettype returns the citation block, title,
 * abstract body, then an affiliation/PMID footer. We just trim the trailing
 * "PMID: ..." style footer lines — good enough for display purposes.
 */
function extractAbstractText(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const footerIdx = text.search(/\n\s*(PMID|DOI|PMCID)\s*:/i);
  return (footerIdx > -1 ? text.slice(0, footerIdx) : text).trim();
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
      `&rettype=abstract&retmode=text`;
    const raw = await http.getText(abstractUrl);
    const abstract = raw ? extractAbstractText(raw) : undefined;

    return {
      identifiers,
      title: result.title,
      authors,
      year,
      primaryVenue: result.fulljournalname,
      abstract,
      source: "pubmed",
      type: "journalArticle",
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    };
  },

  async getInfoByTitle(title: string): Promise<RefItem | null> {
    const searchUrl =
      `${BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(title)}` +
      `[Title]&retmode=json&retmax=1`;
    const res = await http.getJSON(searchUrl);
    const ids: string[] = res?.esearchresult?.idlist;
    if (!Array.isArray(ids) || !ids.length) return null;
    return pubmed.getInfoByPMID(ids[0]);
  },
};
