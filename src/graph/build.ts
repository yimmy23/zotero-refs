import { libraryIndex } from "../core/libmatch";
import type { GraphData, GraphEdge, GraphNode } from "../core/types";
import { getWorkFull, getWorksBatch, openalex } from "../sources/openalex";

/**
 * Citation-graph builder. Assembles a GraphData around one library item
 * from OpenAlex: the item's references (hydrated with their own reference
 * lists so we can compute co-citation links), a page of citing works, and
 * a few related works. Pure data — rendering lives in ./view.
 */

/** Citations page pulled for the graph (one page is plenty visually). */
const CITATION_LIMIT = 15;
/** Related works considered for the graph. */
const RELATED_LIMIT = 10;
/** Minimum shared references for a co-citation edge. */
const COCITE_MIN_SHARED = 3;
/** Hard cap on co-citation edges (kept by weight desc). */
const COCITE_MAX_EDGES = 200;

export async function buildGraph(
  item: Zotero.Item,
  opts: { maxNodes: number; onStatus?: (msg: string) => void },
): Promise<GraphData | null> {
  const onStatus = opts.onStatus;
  try {
    const DOI = ((item.getField("DOI") as string) || "").trim();
    if (!DOI) {
      ztoolkit.log("[graph] item has no DOI, cannot build graph");
      return null;
    }

    onStatus?.("Looking up work on OpenAlex…");
    const origin = await getWorkFull({ DOI });
    if (!origin) {
      ztoolkit.log(`[graph] OpenAlex work not found for DOI ${DOI}`);
      return null;
    }
    const originId = origin.ref.identifiers.openAlex;
    if (!originId) {
      ztoolkit.log("[graph] origin work has no OpenAlex id");
      return null;
    }

    // Nodes keyed by W-id. Insertion order encodes kind priority:
    // origin, then references, citations, related — later duplicates are
    // skipped, so a work seen as both reference and citation stays a
    // reference.
    const nodes = new Map<string, GraphNode>();
    nodes.set(originId, {
      id: originId,
      ref: origin.ref,
      kind: "origin",
      inLibrary: false,
    });

    // Reference lists of reference-kind nodes, for co-citation edges.
    const refWorksOf = new Map<string, Set<string>>();

    onStatus?.(`Loading ${origin.referencedWorks.length} references…`);
    const refMap = await getWorksBatch(origin.referencedWorks, true);
    for (const [wid, work] of refMap) {
      if (wid === originId || nodes.has(wid)) continue;
      nodes.set(wid, {
        id: wid,
        ref: work.ref,
        kind: "reference",
        inLibrary: false,
      });
      refWorksOf.set(wid, new Set(work.referencedWorks));
    }

    onStatus?.("Loading citing works…");
    const cites = await openalex.getCitations(
      { openAlex: originId },
      0,
      CITATION_LIMIT,
    );
    for (const ref of cites?.items || []) {
      const wid = ref.identifiers.openAlex;
      if (!wid || wid === originId || nodes.has(wid)) continue;
      nodes.set(wid, { id: wid, ref, kind: "citation", inLibrary: false });
    }

    onStatus?.("Loading related works…");
    const relMap = await getWorksBatch(
      origin.relatedWorks.slice(0, RELATED_LIMIT),
    );
    for (const [wid, work] of relMap) {
      if (wid === originId || nodes.has(wid)) continue;
      nodes.set(wid, {
        id: wid,
        ref: work.ref,
        kind: "related",
        inLibrary: false,
      });
    }

    // Cap node count: origin always kept, then highest-cited first.
    const originNode = nodes.get(originId)!;
    const others = [...nodes.values()].filter((n) => n.kind !== "origin");
    others.sort(
      (a, b) => (b.ref.citationCount || 0) - (a.ref.citationCount || 0),
    );
    const kept = [
      originNode,
      ...others.slice(0, Math.max(0, opts.maxNodes - 1)),
    ];

    onStatus?.("Matching against your library…");
    for (const node of kept) {
      try {
        node.inLibrary = !!(await libraryIndex.match(node.ref));
      } catch (e) {
        ztoolkit.log("[graph] library match failed", e);
      }
    }

    onStatus?.("Building edges…");
    const edges: GraphEdge[] = [];
    for (const node of kept) {
      if (node.id === originId) continue;
      edges.push({
        source: originId,
        target: node.id,
        weight: 1,
        kind: "direct",
      });
    }

    // Co-citation among kept reference nodes: two references sharing
    // enough entries of their own reference lists get linked.
    const refNodes = kept.filter(
      (n) => n.kind === "reference" && refWorksOf.has(n.id),
    );
    const cocite: GraphEdge[] = [];
    for (let i = 0; i < refNodes.length; i++) {
      const a = refWorksOf.get(refNodes[i].id)!;
      for (let j = i + 1; j < refNodes.length; j++) {
        const b = refWorksOf.get(refNodes[j].id)!;
        const [small, large] = a.size <= b.size ? [a, b] : [b, a];
        let shared = 0;
        for (const w of small) if (large.has(w)) shared++;
        if (shared >= COCITE_MIN_SHARED) {
          cocite.push({
            source: refNodes[i].id,
            target: refNodes[j].id,
            weight: shared,
            kind: "cocite",
          });
        }
      }
    }
    cocite.sort((x, y) => y.weight - x.weight);
    edges.push(...cocite.slice(0, COCITE_MAX_EDGES));

    onStatus?.(`Graph ready: ${kept.length} nodes, ${edges.length} edges`);
    return { nodes: kept, edges, originId };
  } catch (e) {
    ztoolkit.log("[graph] buildGraph failed", e);
    return null;
  }
}
