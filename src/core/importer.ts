import { isChinese } from "./text";
import { libraryIndex, isRelated } from "./libmatch";
import type { RefItem } from "./types";
import { resolveDOIByTitle, sources } from "../sources";

/**
 * Import references into the library and manage bidirectional
 * related-item links.
 */

/** create an item through Zotero's search translators (DOI / arXiv / PMID) */
export async function createItemByIdentifier(
  identifiers: { DOI?: string; arXiv?: string; PMID?: string },
  collections: number[],
  libraryID?: number,
): Promise<Zotero.Item | null> {
  const translate = new Zotero.Translate.Search();
  translate.setIdentifier(identifiers as any);
  const translators = await translate.getTranslators();
  if (!translators?.length) return null;
  translate.setTranslator(translators);
  const items = await translate.translate({
    libraryID: libraryID ?? Zotero.Libraries.userLibraryID,
    collections,
    saveAttachments: true,
  });
  return items?.[0] ?? null;
}

/** create an item by directly filling fields from source metadata */
export async function createItemFromInfo(
  info: RefItem,
  collections: number[],
  libraryID?: number,
): Promise<Zotero.Item> {
  const item = new Zotero.Item((info.type as any) || "journalArticle");
  item.libraryID = libraryID ?? Zotero.Libraries.userLibraryID;
  if (info.title) item.setField("title", info.title);
  if (info.year) item.setField("date", String(info.year));
  if (info.publishDate) item.setField("date", String(info.publishDate));
  if (info.primaryVenue && item.itemType === "journalArticle") {
    item.setField("publicationTitle", info.primaryVenue);
  }
  if (info.abstract) item.setField("abstractNote", info.abstract);
  if (info.url) item.setField("url", info.url);
  if (info.identifiers.DOI && item.itemType === "journalArticle") {
    item.setField("DOI", info.identifiers.DOI);
  }
  const creators: any[] = [];
  for (const name of info.authors || []) {
    if (!name) continue;
    if (isChinese(name)) {
      creators.push({
        creatorType: "author",
        lastName: name,
        fieldMode: 1,
      });
    } else {
      const parts = name.trim().split(/\s+/);
      creators.push({
        creatorType: "author",
        firstName: parts.slice(0, -1).join(" "),
        lastName: parts.slice(-1)[0],
      });
    }
  }
  if (creators.length) item.setCreators(creators);
  for (const collectionID of collections) {
    item.addToCollection(collectionID);
  }
  await item.saveTx();
  return item;
}

/**
 * Full import pipeline for one reference:
 * local match -> identifier translate -> DOI resolution by title ->
 * CNKI metadata (Chinese) -> direct metadata creation.
 */
export async function importReference(
  hostItem: Zotero.Item,
  ref: RefItem,
  collections?: number[],
  onStatus?: (msg: string) => void,
): Promise<Zotero.Item | null> {
  const libraryID = hostItem.libraryID;
  const cols = collections ?? hostItem.getCollections();

  // 1. already in library?
  let refItem: Zotero.Item | null | undefined = await libraryIndex.match(
    ref,
    libraryID,
  );
  if (refItem) return refItem;

  const text = ref.text || ref.title || "";
  // 2. Chinese reference -> CNKI (or Jasminum-created item)
  if (isChinese(text)) {
    onStatus?.(`CNKI: ${ref.title || text}`);
    const info = await sources.cnki.getInfoByTitle?.(ref.title || text, text);
    if (info) {
      refItem = await createItemFromInfo(
        { ...ref, ...info, identifiers: { ...ref.identifiers, ...info.identifiers } },
        cols,
        libraryID,
      );
      libraryIndex.invalidate();
      return refItem;
    }
    return null;
  }

  // 3. identifiers -> Zotero translators
  let ids: { DOI?: string; arXiv?: string; PMID?: string } = {};
  if (ref.identifiers.DOI) ids = { DOI: ref.identifiers.DOI };
  else if (ref.identifiers.arXiv) ids = { arXiv: ref.identifiers.arXiv };
  else if (ref.identifiers.PMID) ids = { PMID: ref.identifiers.PMID };
  if (!Object.keys(ids).length && ref.title) {
    onStatus?.(`Searching DOI: ${ref.title}`);
    const DOI = await resolveDOIByTitle(ref.title);
    if (DOI) {
      ref.identifiers.DOI = DOI;
      ids = { DOI };
    }
  }
  if (Object.keys(ids).length) {
    onStatus?.(`Importing: ${Object.values(ids)[0]}`);
    try {
      refItem = await createItemByIdentifier(ids, cols, libraryID);
    } catch (e) {
      ztoolkit.log("[importer] translate failed", e);
      refItem = null;
    }
    if (refItem) {
      libraryIndex.invalidate();
      return refItem;
    }
  }

  // 4. last resort: create from whatever metadata we have
  if (ref.title && (ref.authors?.length || ref.year)) {
    onStatus?.(`Creating item: ${ref.title}`);
    refItem = await createItemFromInfo(ref, cols, libraryID);
    libraryIndex.invalidate();
    return refItem;
  }
  return null;
}

export async function addRelation(
  item: Zotero.Item,
  refItem: Zotero.Item,
): Promise<void> {
  item.addRelatedItem(refItem);
  refItem.addRelatedItem(item);
  await item.saveTx();
  await refItem.saveTx();
}

export async function removeRelation(
  item: Zotero.Item,
  refItem: Zotero.Item,
): Promise<void> {
  item.removeRelatedItem(refItem);
  refItem.removeRelatedItem(item);
  await item.saveTx();
  await refItem.saveTx();
}

/** import a batch of references sequentially with progress feedback */
export async function importAll(
  hostItem: Zotero.Item,
  refs: RefItem[],
  collections: number[] | undefined,
  onProgress: (done: number, total: number, msg: string) => void,
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const label = ref.title || ref.text || `#${i + 1}`;
    try {
      const refItem = await importReference(hostItem, ref, collections);
      if (refItem) {
        if (!isRelated(hostItem, refItem)) {
          await addRelation(hostItem, refItem);
        }
        ref.libItemID = refItem.id;
        ok++;
        onProgress(i + 1, refs.length, `✓ ${label}`);
      } else {
        fail++;
        onProgress(i + 1, refs.length, `✗ ${label}`);
      }
    } catch (e) {
      ztoolkit.log("[importer] importAll failed on", label, e);
      fail++;
      onProgress(i + 1, refs.length, `✗ ${label}`);
    }
  }
  return { ok, fail };
}
