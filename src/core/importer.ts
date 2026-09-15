import {
  hostIdentifiers,
  identifiersConflict,
  isChinese,
  isHttpUrl,
  titlesMatch,
} from "./text";
import { libraryIndex, isRelated } from "./libmatch";
import type { Identifiers, RefItem } from "./types";
import { getString } from "../utils/locale";
import { resolveDOIByTitle, sources } from "../sources";
import { importCNKIItem, searchCNKI } from "../sources/cnki";
import { parseAuthorName } from "./authorNames";
import { itemStateKey } from "./storage";

/**
 * Import references into the library and manage bidirectional
 * related-item links.
 */

type PendingImport = {
  identifiers: Identifiers;
  keys: Set<string>;
  promise: Promise<Zotero.Item | null>;
};
// Public host methods present in Zotero 7–10, omitted by zotero-types 4.1.3.
type RelationIndexUpdate = (
  type: "item",
  id: number,
  predicate: string,
  object: string,
) => void;
type HostRelationIndex = {
  register: RelationIndexUpdate;
  unregister: RelationIndexUpdate;
};
const pendingImports = new Map<string, PendingImport>();
// Mutate the shared Zotero objects only once their write is ready to start.
// This also keeps rollback/reload ahead of another plugin write to an item.
let itemWrites: Promise<unknown> = Promise.resolve();
function writeItems<T>(run: () => Promise<T>): Promise<T> {
  const result = itemWrites.then(run);
  itemWrites = result.catch(() => {});
  return result;
}

function importKeys(ids: Identifiers, libraryID: number): string[] {
  return (["DOI", "arXiv", "PMID"] as const).flatMap((kind) => {
    let id = ids[kind]?.trim().toLowerCase();
    if (!id) return [];
    if (kind === "DOI") id = id.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
    if (kind === "arXiv") id = id.replace(/v\d+$/, "");
    return [JSON.stringify([libraryID, kind, id])];
  });
}

/** Share only validated/printed identifiers, never a title search key. */
function shareImport(
  ids: Identifiers,
  libraryID: number,
  create: () => Promise<Zotero.Item | null>,
): Promise<Zotero.Item | null> {
  const keys = importKeys(ids, libraryID);
  const matches = [
    ...new Set(
      keys.flatMap((key) => {
        const pending = pendingImports.get(key);
        return pending ? [pending] : [];
      }),
    ),
  ];
  // Validate every matching task before publishing aliases. The DOI and PMID
  // may already point at conflicting tasks; selecting the first hides that.
  for (let i = 0; i < matches.length; i++) {
    if (
      identifiersConflict(ids, matches[i].identifiers) ||
      matches
        .slice(i + 1)
        .some((other) =>
          identifiersConflict(matches[i].identifiers, other.identifiers),
        )
    ) {
      return Promise.reject(
        new Error("Conflicting identifiers for pending import"),
      );
    }
  }
  if (matches.length) {
    const pending = matches[0];
    for (const alias of keys) {
      // A caller can corroborate an additional DOI/PMID/arXiv alias while
      // creation is pending. Make that alias visible to later entry points.
      if (!pendingImports.has(alias)) {
        pendingImports.set(alias, pending);
        pending.keys.add(alias);
      }
    }
    pending.identifiers = { ...pending.identifiers, ...ids };
    return pending.promise;
  }
  const pending: PendingImport = {
    identifiers: { ...ids },
    keys: new Set(keys),
    promise: Promise.resolve()
      .then(create)
      .finally(() => {
        for (const key of pending.keys) {
          if (pendingImports.get(key) === pending) pendingImports.delete(key);
        }
      }),
  };
  for (const key of keys) pendingImports.set(key, pending);
  return pending.promise;
}

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
  const typeID = item.itemTypeID;
  const validField = (field: string) => {
    try {
      return Zotero.ItemFields.isValidForType(
        Zotero.ItemFields.getID(field),
        typeID,
      );
    } catch {
      return false;
    }
  };
  if (info.primaryVenue && validField("publicationTitle")) {
    item.setField("publicationTitle", info.primaryVenue);
  }
  if (info.abstract) item.setField("abstractNote", info.abstract);
  if (isHttpUrl(info.url)) item.setField("url", info.url);
  const extraLines: string[] = [];
  if (info.identifiers.DOI) {
    // preprint / conferencePaper also carry DOI fields in Zotero 7+
    if (validField("DOI")) {
      item.setField("DOI", info.identifiers.DOI);
    } else {
      extraLines.push(`DOI: ${info.identifiers.DOI}`);
    }
  }
  // keep PMID / arXiv so the item can be re-matched by identifier later
  // (otherwise a second import creates a duplicate)
  if (info.identifiers.PMID) extraLines.push(`PMID: ${info.identifiers.PMID}`);
  if (info.identifiers.arXiv)
    extraLines.push(`arXiv: ${info.identifiers.arXiv}`);
  if (extraLines.length) {
    const extra = (item.getField("extra") as string) || "";
    item.setField("extra", [extra, ...extraLines].filter(Boolean).join("\n"));
  }
  const creators: any[] = [];
  for (const name of info.authors || []) {
    if (!name) continue;
    const parsed = parseAuthorName(name);
    if (parsed) creators.push({ creatorType: "author", ...parsed });
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
 * local match -> CNKI (Chinese) -> identifier translate ->
 * DOI resolution by title / direct metadata creation (non-Chinese).
 */
export async function importReference(
  hostItem: Zotero.Item,
  ref: RefItem,
  collections?: number[],
  onStatus?: (msg: string) => void,
  shouldContinue: () => boolean = () => true,
): Promise<Zotero.Item | null> {
  if (
    ref.retracted &&
    !Services.prompt.confirm(
      Zotero.getMainWindow() as any,
      getString("retracted-badge"),
      getString("retracted-import-confirm"),
    )
  ) {
    return null;
  }
  const libraryID = hostItem.libraryID;
  const identity = itemStateKey(hostItem);
  const cols = [...(collections ?? hostItem.getCollections())];
  const active = () =>
    shouldContinue() &&
    !hostItem.deleted &&
    itemStateKey(hostItem) === identity;
  if (!active()) return null;
  const hasIdentity = importKeys(ref.identifiers, libraryID).length > 0;
  const create = async () => {
    const item = await importReferenceItem(
      libraryID,
      ref,
      onStatus,
      hasIdentity,
    );
    if (item) libraryIndex.invalidate();
    return item;
  };
  const item = hasIdentity
    ? await shareImport(ref.identifiers, libraryID, create)
    : await create();
  if (!item || !active()) return null;
  const targetIdentity = itemStateKey(item);
  // Each subscriber keeps its own collection/cancellation intent. No caller's
  // collections are committed by the shared translator before it completes.
  return writeItems(async () => {
    if (!active()) return null;
    const current = Zotero.Items.get(item.id) as Zotero.Item | undefined;
    if (
      !current ||
      current.deleted ||
      current.libraryID !== libraryID ||
      itemStateKey(current) !== targetIdentity ||
      !current.isRegularItem() ||
      identifiersConflict(ref.identifiers, hostIdentifiers(current))
    )
      return null;
    const existing = new Set(current.getCollections());
    const added = cols.filter((id) => !existing.has(id));
    if (added.length) {
      for (const id of added) current.addToCollection(id);
      await current.saveTx();
    }
    return current;
  });
}

async function importReferenceItem(
  libraryID: number,
  ref: RefItem,
  onStatus: ((msg: string) => void) | undefined,
  identityAlreadyShared: boolean,
): Promise<Zotero.Item | null> {
  const cols: number[] = [];

  // 1. already in library?
  let refItem: Zotero.Item | null | undefined = await libraryIndex.match(
    ref,
    libraryID,
  );
  if (refItem) return refItem;

  const text = ref.text || ref.title || "";
  const chinese = isChinese(text);
  // 2. Chinese reference -> CNKI: search, then import through Zotero's own
  //    CNKI web translator (full metadata); scraped-metadata fallback.
  if (chinese) {
    onStatus?.(`CNKI: ${ref.title || text}`);
    const rows = await searchCNKI(ref.title || text);
    const row = rows?.find((candidate) =>
      titlesMatch(candidate.title, ref.title || text),
    );
    if (row) {
      refItem = await importCNKIItem(row, libraryID, cols);
      if (refItem) return refItem;
    }
    const info = await sources.cnki.getInfoByTitle?.(ref.title || text, text);
    if (info) {
      refItem = await createItemFromInfo(
        {
          ...ref,
          ...info,
          identifiers: { ...ref.identifiers, ...info.identifiers },
        },
        cols,
        libraryID,
      );
      return refItem;
    }
    // A CNKI miss does not invalidate identifiers printed in the citation.
    // Keep the existing no-identifier path conservative: an unverified
    // Chinese citation should not become a metadata-only library item.
    if (
      !ref.identifiers.DOI &&
      !ref.identifiers.arXiv &&
      !ref.identifiers.PMID
    ) {
      return null;
    }
  }

  // 3. identifiers -> Zotero translators
  let ids: { DOI?: string; arXiv?: string; PMID?: string } = {};
  if (ref.identifiers.DOI) ids = { DOI: ref.identifiers.DOI };
  else if (ref.identifiers.arXiv) ids = { arXiv: ref.identifiers.arXiv };
  else if (ref.identifiers.PMID) ids = { PMID: ref.identifiers.PMID };
  if (!Object.keys(ids).length && ref.title) {
    onStatus?.(`${getString("importer-search-doi")}: ${ref.title}`);
    const DOI = await resolveDOIByTitle(ref);
    if (DOI) {
      ref.identifiers.DOI = DOI;
      ids = { DOI };
    }
  }
  const create = async (): Promise<Zotero.Item | null> => {
    if (Object.keys(ids).length) {
      // The resolver may finish after another entry point imported this DOI.
      const existing = await libraryIndex.match(
        { ...ref, identifiers: ids },
        libraryID,
      );
      if (existing) return existing;
      onStatus?.(
        `${getString("importer-importing")}: ${Object.values(ids)[0]}`,
      );
      try {
        refItem = await createItemByIdentifier(ids, cols, libraryID);
      } catch (e) {
        ztoolkit.log("[importer] translate failed", e);
        refItem = null;
      }
      if (refItem) return refItem;
    }

    if (chinese) return null;

    // 4. last resort: create from whatever metadata we have
    if (ref.title && (ref.authors?.length || ref.year)) {
      onStatus?.(`${getString("importer-create")}: ${ref.title}`);
      refItem = await createItemFromInfo(ref, cols, libraryID);
      return refItem;
    }
    return null;
  };
  return Object.keys(ids).length && !identityAlreadyShared
    ? shareImport(ids, libraryID, create)
    : create();
}

export async function addRelation(
  item: Zotero.Item,
  refItem: Zotero.Item,
): Promise<void> {
  return changeRelation(item, refItem, true);
}

export async function removeRelation(
  item: Zotero.Item,
  refItem: Zotero.Item,
): Promise<void> {
  return changeRelation(item, refItem, false);
}

function changeRelation(
  item: Zotero.Item,
  refItem: Zotero.Item,
  add: boolean,
): Promise<void> {
  const itemIdentity = itemStateKey(item);
  const refIdentity = itemStateKey(refItem);
  return writeItems(async () => {
    if (item.id === refItem.id) return;
    const originals = new Map<
      Zotero.Item,
      ReturnType<Zotero.Item["getRelations"]>
    >();
    const changed = new Map<
      Zotero.Item,
      ReturnType<Zotero.Item["getRelations"]>
    >();
    try {
      await Zotero.DB.executeTransaction(async () => {
        if (
          item.deleted ||
          refItem.deleted ||
          item.libraryID !== refItem.libraryID ||
          itemStateKey(item) !== itemIdentity ||
          itemStateKey(refItem) !== refIdentity
        ) {
          throw new Error(
            "Related items must retain their identities in the same library",
          );
        }
        for (const target of [item, refItem]) {
          const relations = target.getRelations();
          originals.set(target, {
            ...relations,
            ...Object.fromEntries(
              Object.entries(relations).map(([key, values]) => [
                key,
                Array.isArray(values) ? [...values] : values,
              ]),
            ),
          });
        }
        if (add) {
          item.addRelatedItem(refItem);
          refItem.addRelatedItem(item);
        } else {
          await item.removeRelatedItem(refItem);
          await refItem.removeRelatedItem(item);
        }
        for (const target of [item, refItem])
          changed.set(target, target.getRelations());
        // saveTx starts a NEW transaction and waits for the outer one. Host
        // save() participates in the existing transaction instead.
        await item.save();
        await refItem.save();
      });
    } catch (error) {
      // A successful first save has already cleared that object's change
      // tracking. Reload after DB rollback, then preserve any original
      // unsaved relation edits rather than erasing unrelated user intent.
      for (const [target, relations] of originals) {
        try {
          const attempted = changed.get(target) || target.getRelations();
          await target.reload(["relations"], true);
          const persisted = target.getRelations();
          const relationIndex = (
            Zotero as unknown as { Relations: HostRelationIndex }
          ).Relations;
          // save() calls DataObject._postSave even inside an outer transaction,
          // updating Zotero.Relations before SQL commit. reload() does not undo
          // that reverse index. Reconcile only this subject's affected pairs
          // against the rolled-back database, not its possibly unsaved edits.
          for (const snapshot of [relations, attempted, persisted]) {
            for (const [predicate, values] of Object.entries(snapshot)) {
              for (const value of Array.isArray(values) ? values : [values])
                relationIndex.unregister("item", target.id, predicate, value);
            }
          }
          for (const [predicate, values] of Object.entries(persisted)) {
            for (const value of Array.isArray(values) ? values : [values])
              relationIndex.register("item", target.id, predicate, value);
          }
          target.setRelations(relations);
        } catch (reloadError) {
          ztoolkit.log(
            "[importer] relation rollback reload failed",
            reloadError,
          );
        }
      }
      throw error;
    }
  });
}

/** import a batch of references sequentially with progress feedback */
export async function importAll(
  hostItem: Zotero.Item,
  refs: RefItem[],
  collections: number[] | undefined,
  onProgress: (done: number, total: number, msg: string) => void,
  shouldStop?: () => boolean,
): Promise<{ ok: number; fail: number; stopped: number }> {
  let ok = 0;
  let fail = 0;
  const identity = itemStateKey(hostItem);
  const stopped = () =>
    shouldStop?.() || hostItem.deleted || itemStateKey(hostItem) !== identity;
  for (let i = 0; i < refs.length; i++) {
    if (stopped()) {
      return { ok, fail, stopped: refs.length - i };
    }
    const ref = refs[i];
    const label = ref.title || ref.text || `#${i + 1}`;
    try {
      const refItem = await importReference(
        hostItem,
        ref,
        collections,
        undefined,
        () => !stopped(),
      );
      // A translator may finish after cancellation or after the host record
      // was edited into another paper. Keep its newly created library item,
      // but never attach the old bibliography to the changed host.
      if (stopped()) {
        return { ok, fail, stopped: refs.length - i };
      }
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
  return { ok, fail, stopped: 0 };
}
