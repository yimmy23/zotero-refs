import { normalizeTitle, REGEX } from "./text";
import type { RefItem } from "./types";

/**
 * Fast in-library matching of references.
 *
 * Builds one index per library (DOI / arXiv / PMID / normalized title ->
 * itemID) in a single pass, then answers match() in O(1). The index is
 * invalidated by item notifier events and rebuilt lazily.
 */
class LibraryIndex {
  private byDOI = new Map<string, number>();
  private byArXiv = new Map<string, number>();
  private byPMID = new Map<string, number>();
  private byTitle = new Map<string, number>();
  private titles: Array<[string, number]> = [];
  private dirty = true;
  private building: Promise<void> | null = null;
  private notifierID?: string;
  private libraryID = 1;

  register() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (_event: string, type: string) => {
          if (type === "item") this.dirty = true;
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
    if (!this.dirty && this.libraryID === libraryID) return;
    if (this.building) return this.building;
    this.building = this.build(libraryID).finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async build(libraryID: number) {
    const t0 = Date.now();
    this.libraryID = libraryID;
    this.byDOI.clear();
    this.byArXiv.clear();
    this.byPMID.clear();
    this.byTitle.clear();
    this.titles = [];
    const items = await Zotero.Items.getAll(libraryID, false, false);
    for (const item of items) {
      if (!item.isRegularItem()) continue;
      const id = item.id;
      const doi = (item.getField("DOI") as string)?.trim();
      if (doi) this.byDOI.set(doi.toLowerCase(), id);
      const url = (item.getField("url") as string) || "";
      const extra = (item.getField("extra") as string) || "";
      const arxiv =
        url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i)?.[1] ||
        extra.match(REGEX.arXiv)?.[1];
      if (arxiv) this.byArXiv.set(arxiv.toLowerCase(), id);
      const pmid =
        extra.match(/PMID:\s*(\d+)/i)?.[1] ||
        url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/)?.[1];
      if (pmid) this.byPMID.set(pmid, id);
      if (!doi && !extra.match(/DOI:\s*(10\.\S+)/i)) {
        const extraDOI = extra.match(/DOI:\s*(10\.\S+)/i)?.[1];
        if (extraDOI) this.byDOI.set(extraDOI.toLowerCase(), id);
      }
      const title = normalizeTitle(item.getField("title") as string);
      if (title.length >= 6) {
        this.byTitle.set(title, id);
        if (title.length >= 15) this.titles.push([title, id]);
      }
    }
    this.dirty = false;
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
        if (!id && title.length >= 20) {
          const hit = this.titles.find(
            ([t]) => t.includes(title) || title.includes(t),
          );
          if (hit) id = hit[1];
        }
      }
    }
    if (!id) return undefined;
    const item = Zotero.Items.get(id);
    if (item) {
      ref.libItemID = id;
      // backfill identifiers from the local item
      const doi = item.getField("DOI") as string;
      if (doi && !ref.identifiers.DOI) ref.identifiers.DOI = doi;
    }
    return item || undefined;
  }
}

export const libraryIndex = new LibraryIndex();

/** Is refItem already a "related item" of item? */
export function isRelated(item: Zotero.Item, refItem?: Zotero.Item): boolean {
  if (!item || !refItem) return false;
  return item.relatedItems.includes(refItem.key);
}
