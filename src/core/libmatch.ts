import { normalizeTitle, REGEX } from "./text";
import type { RefItem } from "./types";

/**
 * Fast in-library matching of references.
 *
 * One pass over the library builds DOI / arXiv / PMID / normalized-title
 * maps, then match() answers in O(1). Item notifier events update the
 * index incrementally (a full rebuild only happens on the initial build
 * or on library switch), so batch imports stay O(1) per item.
 */
class LibraryIndex {
  private byDOI = new Map<string, number>();
  private byArXiv = new Map<string, number>();
  private byPMID = new Map<string, number>();
  private byTitle = new Map<string, number>();
  private titles: Array<[string, number]> = [];
  /** normalized titles already known NOT to match (per build generation) */
  private noMatch = new Set<string>();
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
                  this.indexItem(item as Zotero.Item);
                }
              } catch {
                // unloaded item data — skip
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
      "references-libindex",
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
      this.building = this.build(libraryID).finally(() => {
        this.building = null;
      });
      await this.building;
    }
  }

  /** add one item's identifiers/title to the maps */
  private indexItem(item: Zotero.Item) {
    if (!item.isRegularItem()) return;
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
      this.byTitle.set(title, id);
      if (title.length >= 15) this.titles.push([title, id]);
    }
  }

  private async build(libraryID: number) {
    const t0 = Date.now();
    this.libraryID = libraryID;
    this.byDOI.clear();
    this.byArXiv.clear();
    this.byPMID.clear();
    this.byTitle.clear();
    this.titles = [];
    this.noMatch.clear();
    // clear dirty BEFORE the pass so a notifier arriving mid-build
    // re-dirties and triggers another pass in ensure()
    this.dirty = false;
    const items = await Zotero.Items.getAll(libraryID, false, false);
    for (const item of items) {
      try {
        this.indexItem(item as Zotero.Item);
      } catch {
        // getField throws UnloadedDataException on items whose data is
        // not loaded yet — skip those, the notifier patches them later
      }
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
      if (title.length >= 6) {
        id = this.byTitle.get(title);
        // containment fallback for long titles (subtitle differences etc.)
        // — memoized negatives and capped, so a long bibliography on a huge
        // library cannot melt the main thread
        if (
          !id &&
          title.length >= 20 &&
          !this.noMatch.has(title) &&
          this.titles.length <= LibraryIndex.MAX_SCAN
        ) {
          const hit = this.titles.find(
            ([t]) => t.includes(title) || title.includes(t),
          );
          if (hit) id = hit[1];
          else this.noMatch.add(title);
        }
      }
    }
    if (!id) return undefined;
    const item = (Zotero.Items.get(id) || undefined) as Zotero.Item | undefined;
    if (item) {
      ref.libItemID = id;
      // backfill identifiers from the local item
      const doi = item.getField("DOI") as string;
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
