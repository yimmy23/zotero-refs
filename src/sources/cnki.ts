import { isChinese, parseCNKIURL } from "../core/text";
import type { Identifiers, MetaSource, RefItem, RefTag } from "../core/types";
import { http } from "../core/http";
import { getPref, setPref } from "../utils/prefs";

/**
 * 中国知网 CNKI — no public API, ported from zotero-reference's HTML-scraping
 * + "知网研学" (CNKI Scholar) reader-token flow.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36";

/**
 * Search CNKI by keywords (typically a title) and return the canonical
 * detail-page URL of the first hit, or null on any failure.
 */
export async function getCNKIURL(keywords: string): Promise<string | null> {
  const body =
    `IsSearch=true&QueryJson={"Platform":"","DBCode":"CFLS",` +
    `"KuaKuCode":"CJFQ,CDMD,CIPD,CCND,CISD,SNAD,BDZK,CCJD,CCVD,CJFN",` +
    `"QNode":{"QGroup":[{"Key":"Subject","Title":"","Logic":1,` +
    `"Items":[{"Title":"主题","Name":"SU","Value":"${keywords}",` +
    `"Operate":"%=","BlurType":""}],"ChildItems":[]}]},"CodeLang":"ch"}` +
    `&PageName=defaultresult&DBCode=CFLS&CurPage=1&RecordsCntPerPage=20` +
    `&CurDisplayMode=listmode&CurrSortField=&CurrSortFieldType=desc` +
    `&IsSentenceSearch=false&Subject=`;

  const html = await http.postForm<string>(
    "https://kns.cnki.net/kns8/Brief/GetGridTableHtml",
    body,
    {
      credentials: true,
      responseType: "text",
      headers: {
        Accept: "text/html, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7",
        Referer:
          "https://kns.cnki.net/kns8/AdvSearch?dbprefix=SCDB&&crossDbcodes=" +
          "CJFQ%2CCDMD%2CCIPD%2CCCND%2CCISD%2CSNAD%2CBDZK%2CCJFN%2CCCJD",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );
  if (!html) return null;

  try {
    const hrefMatch = html.match(/href='(.+FileName=.+?&DbName=.+?)'/i);
    if (!hrefMatch) return null;
    const args = parseCNKIURL(hrefMatch[1]);
    if (!args) return null;
    return (
      `https://kns.cnki.net/kcms/detail/detail.aspx?FileName=${args.fileName}` +
      `&DbName=${args.dbName}&DbCode=${args.dbCode}`
    );
  } catch (e) {
    ztoolkit.log("[cnki] getCNKIURL parse failed", e);
    return null;
  }
}

async function getInfoByTitle(
  title: string,
  refText?: string,
): Promise<RefItem | null> {
  if (!isChinese(refText || title)) return null;

  const url = await getCNKIURL(title);
  if (!url) return null;

  const html = await http.getText(url, { credentials: true });
  if (!html) return null;

  try {
    const doc = ztoolkit.getDOMParser().parseFromString(html, "text/html");
    const titleText = doc.querySelector(".brief h1")!.textContent!.trim();
    const abstract = doc
      .querySelector("span#ChDivSummary")
      ?.textContent?.trim();
    const authors = Array.from(doc.querySelectorAll("#authorpart span a")).map(
      (a: any) => (a.textContent || "").trim(),
    );
    const topTip = doc.querySelectorAll(".top-tip span a");
    const primaryVenue = (topTip[0] as any)?.textContent?.trim();
    const year = (topTip[1] as any)?.textContent?.trim()?.split(",")[0];

    const tags: (RefTag | string)[] = Array.from(
      doc.querySelectorAll(".keywords a"),
    ).map((a: any) => (a.textContent || "").replace(/(\n|\s+|;)/g, ""));

    const downloadText = Array.from(
      doc.querySelectorAll("p.total-inform span"),
    )
      .map((s: any) => s.textContent || "")
      .find((t: string) => t.includes("下载"));
    const downloadCount = downloadText?.match(/\d+/)?.[0];
    if (downloadCount) {
      tags.push({ text: downloadCount, color: "#cc7c08", tip: "知网下载量" });
    }

    return {
      identifiers: { CNKI: url },
      title: titleText,
      abstract,
      authors,
      type: "journalArticle",
      primaryVenue,
      year,
      url,
      source: "cnki",
      tags,
    };
  } catch (e) {
    ztoolkit.log("[cnki] getInfoByTitle parse failed", e);
    return null;
  }
}

function randomIP(): string {
  const parts: string[] = [];
  for (let i = 0; i < 4; i++) {
    parts.push(String(Math.floor(Math.random() * 256)));
  }
  return parts.join(".");
}

/** log into 知网研学 with the configured account and cache the reader token */
async function updateToken(
  username: string,
  password: string,
): Promise<string | null> {
  const res = await http.postJSON<{ Content?: string }>(
    "https://apix.cnki.net/databusapi/api/v1.0/credential/namepasswithcleartext/personalaccount",
    { Username: username, Password: password, Clientip: randomIP() },
  );
  const token = res?.Content;
  if (!token) return null;
  setPref("CNKI.token", token);
  return token;
}

const TYPE_MAP: Record<string, string> = { journal: "journalArticle" };

async function fetchFileInfo(
  fileName: string,
  username: string,
  password: string,
  attempt = 0,
): Promise<RefItem[] | null> {
  const token = (getPref("CNKI.token") as string) || "";
  const infoApi =
    `https://x.cnki.net/readApi/api/v1/paperInfo?fileName=${fileName}` +
    `&tableName=CJFDTOTAL&dbCode=CJFD&from=ReadingHistory&type=psmc&fsType=1&taskId=0`;
  const refApi =
    `https://x.cnki.net/readApi/api/v1/paperRefreNotes?appId=CRSP_BASIC_PSMC` +
    `&dbcode=CJFD&tablename=CJFDTOTAL&filename=${fileName}&type=1&page=1`;
  const headers = { token, "user-agent": USER_AGENT };

  const infoData = await http.getJSON<any>(infoApi, {
    headers,
    noCache: true,
  });
  const refData = await http.getJSON<any>(refApi, {
    headers,
    noCache: true,
  });

  if (!refData || String(refData.code) !== "200") {
    if (attempt < 3) {
      const newToken = await updateToken(username, password);
      if (!newToken) return null;
      return fetchFileInfo(fileName, username, password, attempt + 1);
    }
    ztoolkit.log(
      `[cnki] references failed: ${refData?.code} ${refData?.promptMessage}`,
    );
    return null;
  }

  const refs: RefItem[] = [];

  if (infoData && String(infoData.code) === "200") {
    // richer source: the paper's own bibliography, cross-matched against
    // the reader-API reference list for CNKI urls/types.
    const bibliography: any[] = infoData.content?.paper?.bibliography || [];
    const refer: any[] = refData.content?.refer || [];
    for (const ref of bibliography) {
      const matched = refer.find(
        (r: any) => String(ref.title).indexOf(r.title) !== -1,
      );
      const text = String(ref.title).replace(/^\[\d+\]/, "");
      if (matched) {
        const cnkiURL =
          `https://kns.cnki.net/kcms/detail/detail.aspx?FileName=${matched.fileName}` +
          `&DbName=${matched.tableName}&DbCode=${String(matched.dbSource).split("_")[0]}`;
        refs.push({
          identifiers: { CNKI: cnkiURL },
          text,
          title: matched.title,
          authors: [],
          type: TYPE_MAP[matched.type] || "journalArticle",
          url: cnkiURL,
          source: "cnki",
        });
      } else {
        refs.push({
          identifiers: {},
          text,
          authors: [],
          type: "journalArticle",
          title: text,
          source: "cnki",
        });
      }
    }
  } else {
    // fallback: the reader-API reference list alone, ordered by citation
    // number as it appears in the bibliography.
    const refer: any[] = (refData.content?.refer || [])
      .slice()
      .sort(
        (a: any, b: any) => Number(a.citationNumber) - Number(b.citationNumber),
      );
    for (const ref of refer) {
      const title = String(ref.title).replace(/^\[\d+\]/, "");
      const cnkiURL =
        `https://kns.cnki.net/kcms/detail/detail.aspx?FileName=${ref.fileName}` +
        `&DbName=${ref.tableName}&DbCode=${String(ref.dbSource).split("_")[0]}`;
      refs.push({
        identifiers: { CNKI: cnkiURL },
        authors: (ref.author || "").split(";").filter((s: string) => s.length),
        type: TYPE_MAP[ref.type] || "journalArticle",
        text: `${ref.author}. ${title}[${ref.type?.[0] || ""}]. ${ref.source}, ${ref.year}, ${ref.volumn}:${ref.pageNumber}.`,
        title: ref.title,
        year: ref.year,
        url: cnkiURL,
        number: Number(ref.citationNumber),
        source: "cnki",
      });
    }
  }
  return refs.length ? refs : null;
}

async function getReferences(
  ids: Identifiers,
  title?: string,
): Promise<RefItem[] | null> {
  const username = ((getPref("CNKI.username") as string) || "").trim();
  const password = ((getPref("CNKI.password") as string) || "").trim();
  // no 知网研学 credentials configured — the caller's UI explains how to
  // set them, we just decline silently here.
  if (!username || !password) return null;

  let fileName = parseCNKIURL(ids.CNKI)?.fileName;
  if (!fileName && title) {
    const url = await getCNKIURL(title);
    fileName = parseCNKIURL(url || undefined)?.fileName;
  }
  if (!fileName) return null;

  try {
    return await fetchFileInfo(fileName, username, password);
  } catch (e) {
    ztoolkit.log("[cnki] getReferences failed", e);
    return null;
  }
}

export const cnki: MetaSource = {
  id: "cnki",
  getInfoByTitle,
  getReferences,
};
