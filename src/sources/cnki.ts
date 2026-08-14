import { isChinese, parseCNKIURL } from "../core/text";
import type { Identifiers, MetaSource, RefItem, RefTag } from "../core/types";
import { http } from "../core/http";
import { getPref, setPref } from "../utils/prefs";

/**
 * 中国知网 CNKI — no public API.
 *
 * Search uses the endpoints current jasminum (v1.1.37, 2026) uses:
 *   - mainland:  POST https://kns.cnki.net/kns8s/brief/grid
 *   - oversea:   POST https://chn.oversea.cnki.net/kns/Brief/GetGridTableHtml
 * (the 2023-era kns8/Brief/GetGridTableHtml endpoint is dead for mainland
 * users). Item import goes through Zotero's own CNKI web translator with an
 * EndNote-export fallback. Reference lists still use the 知网研学 reader API
 * (account required).
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) " +
  "Gecko/20100101 Firefox/147.0";

/** Zotero's built-in CNKI web translator */
const CNKI_WEB_TRANSLATOR = "5c95b67b-41c5-4f55-b71a-48d5d7183063";
/** Zotero's built-in Refer/BibIX (EndNote) import translator */
const ENDNOTE_IMPORT_TRANSLATOR = "7b6b135a-ed39-4d90-8e38-65516671c5bc";

export interface CNKISearchRow {
  url: string;
  title: string;
  authors: string[];
  venue?: string;
  date?: string;
  citation?: string;
  dbname?: string;
  filename?: string;
  exportID?: string;
}

/** top-level keys form-urlencoded; nested objects JSON-stringified */
function jsonToFormUrlEncoded(json: Record<string, any>): string {
  return Object.keys(json)
    .map(
      (key) =>
        encodeURIComponent(key) +
        "=" +
        encodeURIComponent(
          typeof json[key] === "object" ? JSON.stringify(json[key]) : json[key],
        ),
    )
    .join("&");
}

function buildSearchExp(title: string, author?: string): string {
  let exp = title.includes(" ") ? `(TI %= '${title}')` : `TI %= '${title}'`;
  if (author) exp += ` AND AU='${author}'`;
  return exp;
}

function mainlandOptions(title: string, author?: string) {
  const searchExp = buildSearchExp(title, author);
  return {
    url: "https://kns.cnki.net/kns8s/brief/grid",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Accept-Language": "zh-CN,en-US;q=0.9,en;q=0.8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://kns.cnki.net",
      Referer:
        "https://kns.cnki.net/kns8s/defaultresult/index?crossids=YSTT4HG0%2C" +
        "LSTPFY1C%2CJUP3MUPD%2CMPMFIG1A%2CWQ0UVIAA%2CBLZOG7CK%2CPWFIRAGL%2C" +
        "EMRPGLPA%2CNLBO1Z6R%2CNN3FJMUV&korder=SU&kw=",
    },
    body: jsonToFormUrlEncoded({
      boolSearch: "true",
      QueryJson: {
        Platform: "",
        Resource: "CROSSDB",
        Classid: "WD0FTY92",
        Products: "",
        QNode: {
          QGroup: [
            {
              Key: "Subject",
              Title: "",
              Logic: 0,
              Items: [
                {
                  Key: "Expert",
                  Title: "",
                  Logic: 0,
                  Field: "EXPERT",
                  Operator: 0,
                  Value: searchExp,
                  Value2: "",
                },
              ],
              ChildItems: [],
            },
            { Key: "ControlGroup", Title: "", Logic: 0, Items: [], ChildItems: [] },
          ],
        },
        ExScope: "1",
        SearchType: 4,
        Rlang: "CHINESE",
        KuaKuCode:
          "YSTT4HG0,LSTPFY1C,JUP3MUPD,MPMFIG1A,WQ0UVIAA,BLZOG7CK,PWFIRAGL," +
          "EMRPGLPA,NLBO1Z6R,NN3FJMUV",
        SearchFrom: 1,
      },
      pageNum: "1",
      pageSize: "20",
      sortField: "",
      sortType: "",
      dstyle: "listmode",
      productStr:
        "YSTT4HG0,LSTPFY1C,RMJLXHZ3,JQIRZIYA,JUP3MUPD,1UR4K4HZ,BPBAFJ5S," +
        "R79MZMCB,MPMFIG1A,WQ0UVIAA,NB3BWEHK,XVLO76FD,HR1YT1Z9,BLZOG7CK," +
        "PWFIRAGL,EMRPGLPA,J708GVCE,ML4DRIDX,NLBO1Z6R,NN3FJMUV,",
      aside: `(${searchExp.replace(/'/g, "&#39;")})`,
      searchFrom: "资源范围：总库;++中英文扩展;++时间范围：更新时间：不限;++",
      CurPage: "1",
    }),
  };
}

function overseaOptions(title: string, author?: string) {
  const searchExp = buildSearchExp(title, author);
  return {
    url: "https://chn.oversea.cnki.net/kns/Brief/GetGridTableHtml",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html, */*; q=0.01",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://www.cnki.net",
      Referer: "https://www.cnki.net/kns/defaultresult/index",
    },
    body: jsonToFormUrlEncoded({
      IsSearch: "true",
      QueryJson: {
        Platform: "",
        DBCode: "CFLS",
        KuaKuCode:
          "CJFQ,CDMD,CIPD,CCND,CYFD,CCJD,BDZK,CISD,CJFQ,CDMD,CIPD,CCND," +
          "CYFD,CCJD,BDZK,CISD,CJFN",
        QNode: {
          QGroup: [
            {
              Key: "Subject",
              Title: "",
              Logic: 4,
              Items: [
                {
                  Key: "Expert",
                  Title: "",
                  Logic: 0,
                  Name: "",
                  Operate: "",
                  Value: searchExp,
                  ExtendType: 12,
                  ExtendValue: "中英文对照",
                  Value2: "",
                  BlurType: "",
                },
              ],
              ChildItems: [],
            },
            { Key: "ControlGroup", Title: "", Logic: 1, Items: [], ChildItems: [] },
          ],
        },
        ExScope: 1,
        CodeLang: "",
      },
      PageName: "AdvSearch",
      DBCode: "CFLS",
      KuaKuCodes:
        "CJFQ,CDMD,CIPD,CCND,CYFD,CCJD,BDZK,CISD,CJFQ,CDMD,CIPD,CCND,CYFD," +
        "CCJD,BDZK,CISD,CJFN",
      CurPage: "1",
      RecordsCntPerPage: "20",
      CurDisplayMode: "listmode",
      CurrSortField: "",
      CurrSortFieldType: "desc",
      IsSentenceSearch: "false",
      Subject: "",
    }),
  };
}

function parseSearchRows(html: string, overseaHost: boolean): CNKISearchRow[] {
  const doc = ztoolkit.getDOMParser().parseFromString(html, "text/html");
  const rows = doc.querySelectorAll("table.result-table-list > tbody > tr");
  const results: CNKISearchRow[] = [];
  rows.forEach((row: Element) => {
    try {
      const link = row.querySelector("a.fz14");
      if (!link) return;
      let url = link.getAttribute("href") || "";
      if (!url) return;
      if (!url.startsWith("http")) {
        url = (overseaHost ? "https://chn.oversea.cnki.net" : "https://kns.cnki.net") + url;
      }
      const text = (sel: string) =>
        (row.querySelector(sel)?.textContent || "").trim();
      const op = row.querySelector("td.operat > [data-dbname]");
      results.push({
        url,
        title: text("td.name a"),
        authors: text("td.author")
          .split(/[;,\s]+/)
          .filter(Boolean),
        venue: text("td.source"),
        date: text("td.date"),
        citation: text("td.quote"),
        dbname: op?.getAttribute("data-dbname") || undefined,
        filename: op?.getAttribute("data-filename") || undefined,
        exportID:
          row
            .querySelector("td.seq input")
            ?.getAttribute("value") || undefined,
      });
    } catch {
      /* skip malformed row */
    }
  });
  return results;
}

/**
 * Search CNKI by title. Tries the mainland endpoint first, then the
 * oversea mirror. Returns parsed result rows or null.
 */
export async function searchCNKI(
  title: string,
  author?: string,
): Promise<CNKISearchRow[] | null> {
  for (const [build, oversea] of [
    [mainlandOptions, false],
    [overseaOptions, true],
  ] as const) {
    const opt = build(title, author);
    const html = await http.postForm<string>(opt.url, opt.body, {
      credentials: true,
      responseType: "text",
      headers: opt.headers,
      retries: 0,
    });
    if (!html) continue;
    try {
      const rows = parseSearchRows(html, oversea);
      if (rows.length) return rows;
    } catch (e) {
      ztoolkit.log("[cnki] search parse failed", e);
    }
  }
  return null;
}

/**
 * Canonical detail-page URL of the best CNKI hit for the keywords,
 * or null on any failure.
 */
export async function getCNKIURL(keywords: string): Promise<string | null> {
  const rows = await searchCNKI(keywords);
  return rows?.[0]?.url || null;
}

/** fetch a URL as a translator-ready Document (location wrapped) */
async function requestDocument(url: string): Promise<Document | null> {
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "document",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://kns.cnki.net/kns8s/AdvSearch",
        "Accept-Language": "zh-CN,en-US;q=0.7,en;q=0.3",
        "User-Agent": USER_AGENT,
      },
      timeout: 15000,
    });
    let doc: Document | null = xhr.response;
    if (doc && !(doc as any).location) {
      doc = (Zotero.HTTP as any).wrapDocument(doc, xhr.responseURL || url);
    }
    return doc;
  } catch (e) {
    ztoolkit.log("[cnki] requestDocument failed", e);
    return null;
  }
}

/** EndNote export text for a search row (mainland API), or null */
async function getEndNoteText(row: CNKISearchRow): Promise<string | null> {
  if (!row.exportID && !row.filename) return null;
  const postData =
    (row.exportID
      ? `filename=${encodeURIComponent(row.exportID)}&uniplatform=NZKPT`
      : `filename=${row.dbname}!${row.filename}!1!0`) +
    "&displaymode=GBTREFER%2Celearning%2CEndNote";
  try {
    const xhr = await Zotero.HTTP.request(
      "POST",
      "https://kns.cnki.net/dm8/API/GetExport",
      {
        body: postData,
        headers: {
          Accept: "text/plain, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://www.cnki.net",
          Referer: row.url,
          "User-Agent": USER_AGENT,
        },
        timeout: 10000,
        successCodes: [200],
      },
    );
    const json = JSON.parse(xhr.responseText || "{}");
    if (String(json.code) !== "1") return null;
    const endnote = (json.data || []).find(
      (i: Record<string, any>) => i.key === "EndNote",
    );
    return endnote?.value?.[0]?.replace(/<br>/g, "\n") || null;
  } catch (e) {
    ztoolkit.log("[cnki] EndNote export failed", e);
    return null;
  }
}

/**
 * Import a CNKI paper as a proper Zotero item:
 * detail page -> Zotero's CNKI web translator; on captcha/failure ->
 * EndNote export -> import translator. Returns the created item or null.
 */
export async function importCNKIItem(
  row: CNKISearchRow,
  libraryID: number,
  collections: number[] = [],
): Promise<Zotero.Item | null> {
  // 1. web translator on the detail page
  try {
    const doc = await requestDocument(row.url);
    if (doc && doc.title !== "知网节超时验证" && doc.title !== "captcha") {
      const translator = new (Zotero.Translate as any).Web();
      translator.setTranslator(CNKI_WEB_TRANSLATOR);
      translator.setDocument(doc);
      const items: Zotero.Item[] = await translator.translate({
        libraryID,
        collections,
        saveAttachments: false,
      });
      if (items?.length) return items[0];
    }
  } catch (e) {
    ztoolkit.log("[cnki] web translation failed", e);
  }
  // 2. EndNote export fallback
  try {
    const endnote = await getEndNoteText(row);
    if (endnote) {
      const translate = new (Zotero.Translate as any).Import();
      translate.setTranslator(ENDNOTE_IMPORT_TRANSLATOR);
      translate.setString(endnote);
      const items: Zotero.Item[] = await translate.translate({
        libraryID,
        collections,
        saveAttachments: false,
      });
      if (items?.length) {
        const item = items[0];
        if (row.url && !item.getField("url")) {
          item.setField("url", row.url);
          await item.saveTx();
        }
        return item;
      }
    }
  } catch (e) {
    ztoolkit.log("[cnki] EndNote import failed", e);
  }
  return null;
}

async function getInfoByTitle(
  title: string,
  refText?: string,
): Promise<RefItem | null> {
  if (!isChinese(refText || title)) return null;

  const rows = await searchCNKI(title);
  const row = rows?.[0];
  if (!row) return null;

  // base info straight from the result row (survives captcha-gated details)
  const tags: (RefTag | string)[] = [];
  if (row.citation && /\d/.test(row.citation)) {
    tags.push({ text: row.citation, color: "#1b66e6", tip: "知网被引" });
  }
  const info: RefItem = {
    identifiers: { CNKI: row.url },
    title: row.title || title,
    authors: row.authors,
    type: "journalArticle",
    primaryVenue: row.venue,
    year: row.date?.match(/\d{4}/)?.[0],
    url: row.url,
    source: "cnki",
    tags,
  };

  // enrich with abstract/keywords from the detail page, best effort
  const html = await http.getText(row.url, {
    credentials: true,
    headers: { "User-Agent": USER_AGENT },
  });
  if (html) {
    try {
      const doc = ztoolkit.getDOMParser().parseFromString(html, "text/html");
      const abstract =
        doc.querySelector("span#ChDivSummary")?.textContent?.trim() ||
        doc.querySelector("#ChDivSummary")?.textContent?.trim();
      if (abstract) info.abstract = abstract;
      const detailTitle = doc.querySelector(".brief h1, .wx-tit h1");
      if (detailTitle?.textContent?.trim()) {
        info.title = detailTitle.textContent.trim();
      }
      doc.querySelectorAll(".keywords a").forEach((a: Element) => {
        const kw = (a.textContent || "").replace(/[\n\s;]+/g, "");
        if (kw) tags.push(kw);
      });
      const downloadText = (
        Array.from(
          doc.querySelectorAll("p.total-inform span"),
        ) as Element[]
      )
        .map((s) => s.textContent || "")
        .find((t) => t.includes("下载"));
      const downloadCount = downloadText?.match(/\d+/)?.[0];
      if (downloadCount) {
        tags.push({ text: downloadCount, color: "#cc7c08", tip: "知网下载量" });
      }
    } catch (e) {
      ztoolkit.log("[cnki] detail parse failed", e);
    }
  }
  return info;
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
    const rows = await searchCNKI(title);
    const url = rows?.[0]?.url;
    fileName = rows?.[0]?.filename || parseCNKIURL(url || undefined)?.fileName;
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
