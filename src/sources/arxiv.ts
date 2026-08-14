import { identifiersToURL } from "../core/text";
import type { MetaSource, RefItem } from "../core/types";
import { http } from "../core/http";

/**
 * arXiv — Atom export API.
 * https://info.arxiv.org/help/api/user-manual.html
 */

/** find the first direct child (or descendant) element by (possibly
 * namespace-prefixed) tag name and return its trimmed text content */
function tagText(el: any, tag: string): string | undefined {
  const found = el?.getElementsByTagName?.(tag)?.[0];
  const text = found?.textContent;
  return typeof text === "string" ? text.trim() : undefined;
}

async function getInfoByArXiv(arxiv: string): Promise<RefItem | null> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxiv)}`;
  const xml = await http.getText(url);
  if (!xml) return null;

  let entry: any;
  try {
    const doc = ztoolkit.getDOMParser().parseFromString(xml, "text/xml");
    entry = doc.getElementsByTagName("entry")[0];
  } catch (e) {
    ztoolkit.log("[arxiv] parse failed", e);
    return null;
  }
  if (!entry) return null;

  const title = tagText(entry, "title")?.replace(/\n/g, " ");
  if (!title) return null;

  const abstract = tagText(entry, "summary")?.replace(/\n/g, " ");
  const authors: string[] = Array.from(entry.getElementsByTagName("author"))
    .map((a: any) => tagText(a, "name") || "")
    .filter(Boolean);

  const published = tagText(entry, "published");
  const year = published?.slice(0, 4);

  const categories: string[] = Array.from(
    entry.getElementsByTagName("category"),
  )
    .map((c: any) => c.getAttribute?.("term") as string | null)
    .filter((t: string | null): t is string => !!t);

  const comment = tagText(entry, "arxiv:comment");
  const doi = tagText(entry, "arxiv:doi");

  return {
    identifiers: { arXiv: arxiv, DOI: doi },
    title,
    abstract,
    authors,
    year,
    publishDate: published,
    primaryVenue: comment,
    tags: categories,
    type: "preprint",
    source: "arxiv",
    url: identifiersToURL({ arXiv: arxiv }),
  };
}

export const arxiv: MetaSource = {
  id: "arxiv",
  getInfoByArXiv,
};
