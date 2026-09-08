import { libraryIndex } from "../core/libmatch";
import { getString } from "../utils/locale";
import type {
  GraphData,
  GraphEdge,
  GraphNode,
  GraphNodeRole,
  Identifiers,
  RefItem,
} from "../core/types";
import { getWorkFull, getWorksBatch, openalex } from "../sources/openalex";

/**
 * Citation-graph builder. Assembles a GraphData around one library item
 * from OpenAlex: the item's references (hydrated with their own reference
 * lists so we can compute bibliographic-coupling links), a page of citing works, and
 * a few related works. Pure data — rendering lives in ./view.
 */

/** Citations page pulled for the graph (one page is plenty visually). */
const CITATION_LIMIT = 15;
/** Related works considered for the graph. */
const RELATED_LIMIT = 10;
/** Minimum shared references for a bibliographic-coupling edge. */
const COUPLING_MIN_SHARED = 3;
/** Hard cap on bibliographic-coupling edges (kept by weight desc). */
const COUPLING_MAX_EDGES = 200;

export async function buildGraph(
  center: { ids: Identifiers; libraryID: number },
  opts: { maxNodes: number; onStatus?: (msg: string) => void },
): Promise<GraphData | null> {
  const onStatus = opts.onStatus;
  try {
    const hostIds = center.ids;
    if (!hostIds.DOI && !hostIds.PMID && !hostIds.openAlex) {
      ztoolkit.log("[graph] no DOI/PMID/OpenAlex id, cannot build graph");
      return null;
    }

    onStatus?.(getString("graph-status-lookup"));
    const origin = await getWorkFull(hostIds);
    if (!origin) {
      ztoolkit.log(`[graph] OpenAlex work not found for`, hostIds);
      return null;
    }
    const originId = origin.ref.identifiers.openAlex;
    if (!originId) {
      ztoolkit.log("[graph] origin work has no OpenAlex id");
      return null;
    }

    // First metadata/display kind still wins, preserving selection and sorting.
    // Overlap adds roles rather than erasing another observed relationship.
    const nodes = new Map<string, GraphNode>();
    nodes.set(originId, {
      id: originId,
      ref: origin.ref,
      kind: "origin",
      roles: ["origin"],
      inLibrary: false,
    });
    const addNode = (wid: string, ref: RefItem, role: GraphNodeRole) => {
      if (wid === originId) return;
      const existing = nodes.get(wid);
      if (existing) {
        if (!existing.roles.includes(role)) existing.roles.push(role);
      } else {
        nodes.set(wid, {
          id: wid,
          ref,
          kind: role,
          roles: [role],
          inLibrary: false,
        });
      }
    };

    // Reference lists of reference-kind nodes, for bibliographic-coupling edges.
    const refWorksOf = new Map<string, Set<string>>();

    onStatus?.(
      getString("graph-status-refs", {
        args: { count: origin.referencedWorks.length },
      }),
    );
    const refMap = await getWorksBatch(origin.referencedWorks, true, {
      lean: true,
    });
    for (const [wid, work] of refMap) {
      if (wid === originId) continue;
      addNode(wid, work.ref, "reference");
      refWorksOf.set(wid, new Set(work.referencedWorks));
    }

    onStatus?.(getString("graph-status-citing"));
    const cites = await openalex.getCitations(
      { openAlex: originId },
      0,
      CITATION_LIMIT,
    );
    for (const ref of cites?.items || []) {
      const wid = ref.identifiers.openAlex;
      if (wid) addNode(wid, ref, "citation");
    }

    onStatus?.(getString("graph-status-related"));
    const relMap = await getWorksBatch(
      origin.relatedWorks.slice(0, RELATED_LIMIT),
      false,
      { lean: true },
    );
    for (const [wid, work] of relMap) {
      addNode(wid, work.ref, "related");
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

    onStatus?.(getString("graph-status-match"));
    for (const node of kept) {
      try {
        node.inLibrary = !!(await libraryIndex.match(
          node.ref,
          center.libraryID,
        ));
      } catch (e) {
        ztoolkit.log("[graph] library match failed", e);
      }
    }

    onStatus?.(getString("graph-status-edges"));
    const edges: GraphEdge[] = [];
    for (const node of kept) {
      if (node.id === originId) continue;
      if (node.roles.includes("reference"))
        edges.push({
          source: originId,
          target: node.id,
          weight: 1,
          type: "citation",
          provenance: "openalex:referenced-works",
        });
      if (node.roles.includes("citation"))
        edges.push({
          source: node.id,
          target: originId,
          weight: 1,
          type: "citation",
          provenance: "openalex:citing-works",
        });
      if (node.roles.includes("related"))
        edges.push({
          source: originId,
          target: node.id,
          weight: 1,
          type: "provider-related",
          provenance: "openalex:related-works",
        });
    }

    // Bibliographic coupling among kept reference nodes: two references sharing
    // enough entries of their own reference lists get linked.
    const refNodes = kept.filter(
      (n) => n.roles.includes("reference") && refWorksOf.has(n.id),
    );
    const coupling: GraphEdge[] = [];
    for (let i = 0; i < refNodes.length; i++) {
      const a = refWorksOf.get(refNodes[i].id)!;
      for (let j = i + 1; j < refNodes.length; j++) {
        const b = refWorksOf.get(refNodes[j].id)!;
        const [small, large] = a.size <= b.size ? [a, b] : [b, a];
        let shared = 0;
        for (const w of small) if (large.has(w)) shared++;
        if (shared >= COUPLING_MIN_SHARED) {
          coupling.push({
            source: refNodes[i].id,
            target: refNodes[j].id,
            weight: shared,
            type: "bibliographic-coupling",
            provenance: "openalex:referenced-works",
            sharedCount: shared,
          });
        }
      }
    }
    coupling.sort((x, y) => y.weight - x.weight);
    edges.push(...coupling.slice(0, COUPLING_MAX_EDGES));

    onStatus?.(
      getString("graph-status-ready", {
        args: { nodes: kept.length, edges: edges.length },
      }),
    );
    return { nodes: kept, edges, originId };
  } catch (e) {
    ztoolkit.log("[graph] buildGraph failed", e);
    return null;
  }
}
