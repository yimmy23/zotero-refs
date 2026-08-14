import { htmlToText } from "../core/text";
import type { MetaSource, RefItem, RefTag } from "../core/types";
import { http } from "../core/http";

/** ReadPaper — 论文阅读平台 internal microservice API. */

const SEARCH_API =
  "https://readpaper.com/api/microService-app-aiKnowledge/aiKnowledge/paper/search";
const DETAIL_API =
  "https://readpaper.com/api/microService-app-aiKnowledge/aiKnowledge/paper/getPaperDetailInfo";

function mapPaper(data: any): RefItem {
  const tags: (RefTag | string)[] = [...(data.venueTags || [])];
  if (data.citationCount && data.citationCount > 0) {
    tags.push({
      text: data.citationCount,
      tip: "citationCount",
      color: "#1f71e0",
    });
  }
  return {
    identifiers: {},
    title: htmlToText(data.title),
    year: data.year,
    publishDate: data.publishDate,
    authors: (data.authorList || []).map((a: any) => htmlToText(a.name)),
    abstract: htmlToText(data.summary),
    primaryVenue: htmlToText(data.primaryVenue),
    tags,
    source: "readpaper",
    type: "journalArticle",
  };
}

async function search(title: string): Promise<any | null> {
  const res = await http.postJSON<any>(SEARCH_API, {
    keywords: title,
    page: 1,
    pageSize: 1,
    searchType: 0,
  });
  return res?.data?.list?.[0] || null;
}

async function getInfoByTitle(
  title: string,
  _refText?: string,
): Promise<RefItem | null> {
  const data = await search(title);
  if (!data) return null;
  return mapPaper(data);
}

/** search by title, then validate the hit actually matches `doi` before
 * trusting it — readpaper's search is fuzzy and can return the wrong paper. */
async function getInfoByTitleWithDOI(
  title: string,
  doi: string,
): Promise<RefItem | null> {
  const data = await search(title);
  if (!data) return null;

  const detail = await http.postJSON<any>(DETAIL_API, { paperId: data.id });
  const remoteDOI = (detail?.data?.doi as string) || "";
  if (!remoteDOI || remoteDOI.toUpperCase() !== doi.toUpperCase()) {
    return null;
  }

  const info = mapPaper(data);
  info.identifiers = { DOI: doi };
  return info;
}

export const readpaper: MetaSource & {
  getInfoByTitleWithDOI(title: string, doi: string): Promise<RefItem | null>;
} = {
  id: "readpaper",
  getInfoByTitle,
  getInfoByTitleWithDOI,
};
