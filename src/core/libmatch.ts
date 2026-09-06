import {
  hostIdentifiers,
  identifiersConflict,
  normalizeTitle,
  REGEX,
} from "./text";
import type { RefItem } from "./types";

/**
 * Fast in-library matching of references.
 *
 * One pass over the library builds DOI / arXiv / PMID / normalized-title
 * maps, then identifiers and exact-title candidate lookup take O(1).
 * Ambiguous titles are filtered by year and identifiers before selection.
 * Item notifier events update the
 * index incrementally (a full rebuild only happens on the initial build
 * or on library switch), so batch imports stay O(1) per item.
 */
class LibraryIndex {
  private byDOI = new Map<string, number>();
  private byArXiv = new Map<string, number>();
  private byPMID = new Map<string, number>();
  private byTitle = new Map<string, Map<number, number>>();
  /**
   * normalized title -> all itemID/year candidates (0 = unknown year).
   * Long-title buckets are shared with byTitle for the prefix fallback;
   * item IDs preserve duplicate titles without accumulating duplicate rows.
   */
  private titles = new Map<string, Map<number, number>>();
  /** normalized titles already known NOT to match (per build generation) */
  private noMatch = new Set<string>();
  private indexedFields = new Map<number, string>();
  private matching: Promise<unknown> = Promise.resolve();
  private dirty = true;
  private building: Promise<void> | null = null;
  private notifierID?: string;
  private libraryID = 1;

  /** longest containment-fallback scan we are willing to do per ref */
  private static MAX_SCAN = 5000;

  register() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: Array<string | number>) => {
          if (type !== "item") return;
          if (this.dirty || this.building) {
            // index not built yet — nothing to patch
            this.dirty = true;
            return;
          }
          if (event === "add" || event === "modify") {
            for (const id of ids) {
              try {
                const item = Zotero.Items.get(Number(id));
                if (item && item.libraryID === this.libraryID) {
                  if (this.indexedFields.has(item.id)) {
                    // Relations/tags also emit modify. Rebuild only when
                    // indexed fields changed; inserting new keys alone
                    // would leave the old DOI/title bound to this item.
                    if (
                      this.indexedFields.get(item.id) !== this.fingerprint(item)
                    ) {
                      this.dirty = true;
                      break;
                    }
                    continue;
                  }
                  this.indexItem(item as Zotero.Item);
                }
              } catch {
                // Changed fields may be temporarily unloaded. Do not keep
                // answering from old keys until a subsequent rebuild.
                this.dirty = true;
              }
            }
            this.noMatch.clear();
          } else if (event === "delete" || event === "trash") {
            // removals are rare interactively; a lazy rebuild is fine and
            // avoids reverse-map bookkeeping
            this.dirty = true;
          }
        },
      },
      ["item"],
      "refs-libindex",
    );
  }

  unregister() {
    if (this.notifierID) Zotero.Notifier.unregisterObserver(this.notifierID);
  }

  invalidate() {
    this.dirty = true;
  }

  private async ensure(libraryID: number) {
    // loop: an in-flight build may be for another library, or a notifier
    // may re-dirty the index while a build is running
    for (;;) {
      if (this.building) {
        await this.building;
        continue;
      }
      if (!this.dirty && this.libraryID === libraryID) return;
      this.building = this.build(libraryID)
        .catch((error) => {
          this.dirty = true;
          throw error;
        })
        .finally(() => {
          this.building = null;
        });
      await this.building;
    }
  }

  /** add one item's identifiers/title to the maps */
  private indexItem(item: Zotero.Item) {
    if (!item.isRegularItem() || item.deleted) return;
    const fingerprint = this.fingerprint(item);
    const id = item.id;
    const extra = (item.getField("extra") as string) || "";
    let doi = (item.getField("DOI") as string)?.trim();
    if (!doi) {
      // item types without a DOI field keep it in Extra ("DOI: 10.x/y")
      doi = extra.match(/DOI:\s*(10\.\S+)/i)?.[1] || "";
    }
    if (doi) this.byDOI.set(doi.toLowerCase(), id);
    const url = (item.getField("url") as string) || "";
    const arxiv =
      url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i)?.[1] ||
      extra.match(REGEX.arXiv)?.[1];
    if (arxiv) this.byArXiv.set(arxiv.toLowerCase(), id);
    const pmid =
      extra.match(/PMID:\s*(\d+)/i)?.[1] ||
      url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/)?.[1];
    if (pmid) this.byPMID.set(pmid, id);
    const title = normalizeTitle(item.getField("title") as string);
    if (title.length >= 6) {
      const year =
        Number(String(item.getField("date") || "").match(/\d{4}/)?.[0]) || 0;
      const candidates = this.byTitle.get(title) || new Map<number, number>();
      candidates.set(id, year);
      this.byTitle.set(title, candidates);
      // only titles long enough to ever satisfy the prefix fallback's
      // minimum-overlap requirement are worth scanning
      if (title.length >= 25) {
        this.titles.set(title, candidates);
      }
    }
    this.indexedFields.set(id, fingerprint);
  }

  private fingerprint(item: Zotero.Item): string {
    return JSON.stringify([
      item.isRegularItem(),
      item.deleted,
      ...["DOI", "extra", "url", "title", "date"].map((field) =>
        item.getField(field as any),
      ),
    ]);
  }

  private async build(libraryID: number) {
    const t0 = Date.now();
    this.libraryID = libraryID;
    this.byDOI.clear();
    this.byArXiv.clear();
    this.byPMID.clear();
    this.byTitle.clear();
    this.titles.clear();
    this.noMatch.clear();
    this.indexedFields.clear();
    // clear dirty BEFORE the pass so a notifier arriving mid-build
    // re-dirties and triggers another pass in ensure()
    this.dirty = false;
    const items = await Zotero.Items.getAll(libraryID, false, false);
    // chunked: a big library is indexed in slices with the event loop
    // released in between, so the first match() after startup does not
    // freeze the UI (and stutter whatever is animating) for hundreds of ms
    const CHUNK = 400;
    for (let i = 0; i < items.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, items.length);
      for (let j = i; j < end; j++) {
        try {
          this.indexItem(items[j] as Zotero.Item);
        } catch {
          // getField throws UnloadedDataException on items whose data is
          // not loaded yet — skip those, the notifier patches them later
        }
      }
      if (end < items.length) await Zotero.Promise.delay(0);
    }
    ztoolkit.log(
      `[libmatch] indexed ${items.length} items in ${Date.now() - t0}ms`,
    );
  }

  /**
   * Find the local item for a reference. Returns undefined when not found.
   */
  async match(
    ref: RefItem,
    libraryID?: number,
  ): Promise<Zotero.Item | undefined> {
    // The maps hold one library at a time. Serialize lookup+build so two
    // windows using different libraries cannot read each other's maps.
    const result = this.matching.then(() => this.matchIndexed(ref, libraryID));
    this.matching = result.catch(() => {});
    return result;
  }

  private async matchIndexed(
    ref: RefItem,
    libraryID?: number,
  ): Promise<Zotero.Item | undefined> {
    const lib = libraryID ?? Zotero.Libraries.userLibraryID;
    await this.ensure(lib);
    let id: number | undefined;
    if (ref.identifiers.DOI) {
      id = this.byDOI.get(ref.identifiers.DOI.toLowerCase());
    }
    if (!id && ref.identifiers.arXiv) {
      id = this.byArXiv.get(ref.identifiers.arXiv.toLowerCase());
    }
    if (!id && ref.identifiers.PMID) {
      id = this.byPMID.get(ref.identifiers.PMID);
    }
    if (!id) {
      const title = normalizeTitle(ref.title || ref.text);
      const refYear = Number(ref.year) || 0;
      const negativeKey = `${title}/${refYear}`;
      const hasIdentifiers = Object.values(ref.identifiers).some(Boolean);
      const accepts = (
        candidateID: number,
        itemYear: number,
        prefix = false,
      ) => {
        if (prefix && (!refYear || !itemYear)) return false;
        if (refYear && itemYear && Math.abs(refYear - itemYear) > 1)
          return false;
        try {
          const candidate = Zotero.Items.get(candidateID) as
            Zotero.Item | undefined;
          return (
            !!candidate &&
            candidate.libraryID === lib &&
            !candidate.deleted &&
            !identifiersConflict(ref.identifiers, hostIdentifiers(candidate))
          );
        } catch {
          this.dirty = true;
          return false;
        }
      };
      if (title.length >= 6) {
        for (const [candidateID, year] of this.byTitle.get(title) || []) {
          if (!accepts(candidateID, year)) continue;
          if (id !== undefined) return undefined; // More than one exact candidate.
          id = candidateID;
        }
        // Prefix-only fallback for subtitle truncation ("Title" vs
        // "Title: subtitle"). Mid-string containment is forbidden: a
        // library item "Small-cell lung cancer" must never match a ref
        // titled "… in patients with non-small-cell lung cancer".
        // Memoized negatives and capped, so a long bibliography on a huge
        // library cannot melt the main thread.
        if (
          !id &&
          title.length >= 25 &&
          (hasIdentifiers || !this.noMatch.has(negativeKey)) &&
          this.titles.size <= LibraryIndex.MAX_SCAN
        ) {
          let ambiguous = false;
          let scanned = 0;
          for (const [t, candidates] of this.titles) {
            if (t.length === title.length) continue; // = handled by map
            const [short, long] =
              t.length < title.length ? [t, title] : [title, t];
            if (short.length < 25 || !long.startsWith(short)) continue;
            for (const [tid, itemYear] of candidates) {
              // A single shared-title bucket may contain many items too.
              // Never accept a candidate from an incompletely scanned set.
              if (++scanned > LibraryIndex.MAX_SCAN) return undefined;
              if (!accepts(tid, itemYear, true)) continue;
              if (id !== undefined && id !== tid) {
                ambiguous = true;
                break;
              }
              id = tid;
            }
            if (ambiguous) break;
          }
          if (ambiguous) id = undefined;
          // Identifier-bearing lookups can disambiguate a previous miss.
          // Do not share their negatives with different identifier contexts.
          if (!id && !hasIdentifiers) this.noMatch.add(negativeKey);
        }
      }
    }
    if (!id) return undefined;
    let item: Zotero.Item | undefined;
    let itemIds;
    try {
      item = (Zotero.Items.get(id) || undefined) as Zotero.Item | undefined;
      itemIds = item ? hostIdentifiers(item) : undefined;
    } catch {
      this.dirty = true;
      return undefined;
    }
    if (item) {
      if (item.libraryID !== lib || item.deleted) return undefined;
      if (identifiersConflict(ref.identifiers, itemIds!)) return undefined;
      ref.libItemID = id;
      // backfill identifiers from the local item
      const doi = itemIds?.DOI;
      if (doi && !ref.identifiers.DOI) ref.identifiers.DOI = doi;
    }
    return item;
  }
}

export const libraryIndex = new LibraryIndex();

/** Is refItem already a "related item" of item? */
export function isRelated(item: Zotero.Item, refItem?: Zotero.Item): boolean {
  if (!item || !refItem) return false;
  return item.relatedItems.includes(refItem.key);
}
