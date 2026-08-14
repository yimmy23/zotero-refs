import { isDOI } from "../core/text";
import type { MetaSource, RefItem, RefTag } from "../core/types";
import { http } from "../core/http";

/**
 * Connected Papers — unofficial REST API, used for its similarity-graph
 * search only. Known to occasionally 403 (bot protection); that is treated
 * as a normal "no answer" here, same as any other miss.
 */

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36";

export async function translateDOI(
  doi: string,
): Promise<{ paperId: string; title?: string } | null> {
  const res = await http.getJSON<{ paperId?: string; title?: string }>(
    `https://rest.connectedpapers.com/id_translator/doi/${encodeURIComponent(doi)}`,
    { headers: { "user-agent": CHROME_UA } },
  );
  if (!res?.paperId) return null;
  return { paperId: res.paperId, title: res.title };
}

function mapPaper(item: any): RefItem {
  const tags: (RefTag | string)[] = [];
  if (item.citationStats) {
    tags.push({
      text: item.citationStats.numCitations,
      tip: "citationStats.numCitations",
      color: "rgba(53, 153, 154, 0.5)",
    });
    tags.push({
      text: item.citationStats.numReferences,
      tip: "citationStats.numReferences",
      color: "rgba(53, 153, 154, 0.75)",
    });
  }
  return {
    identifiers: { DOI: item.doiInfo?.doi },
    title: item.title?.text,
    authors: (item.authors || []).map((a: any) => a?.[0]?.name).filter(Boolean),
    year: item.year?.text,
    type: "journalArticle",
    text: item.title?.text,
    url: item.doiInfo?.doiUrl,
    abstract: item.paperAbstract?.text,
    source: "connectedpapers",
    primaryVenue: item.venue?.text,
    tags,
  };
}

async function getInfoByTitle(
  title: string,
  _refText?: string,
): Promise<RefItem | null> {
  let query = title;
  if (isDOI(title)) {
    const translated = await translateDOI(title);
    if (!translated) return null;
    query = translated.title || title;
  }

  const res = await http.postJSON<any>(
    `https://rest.connectedpapers.com/search/${encodeURIComponent(query)}/1`,
    {},
  );
  const item = res?.results?.[0];
  if (!item) return null;
  return mapPaper(item);
}

export const connectedpapers: MetaSource = {
  id: "connectedpapers",
  getInfoByTitle,
};
