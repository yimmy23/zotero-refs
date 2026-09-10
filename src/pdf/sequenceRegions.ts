import type {
  SequenceDiagnostic,
  SequenceLine,
  SequencePage,
  SequenceRegion,
} from "./sequenceTypes";
import { sequenceLineFeatures } from "./sequenceDecoder";

const folded = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
const printedNumber = (line: SequenceLine) => {
  const t = line.text.normalize("NFKC").trim();
  const match = t.match(
    /^(?:\[\s*(\d{1,3})\s*\]|\(\s*(\d{1,3})\s*\)|(\d{1,3})\s*[.)．]|(\d{1,3})\s+(?=\p{L}))/u,
  );
  return match ? Number(match.slice(1).find(Boolean)) : undefined;
};

export function bibliographyHeading(
  text: string,
): SequenceRegion["kind"] | null {
  const t = folded(text).replace(/^\d+[.)．]?/, "");
  if (
    /^(references|referencesandnotes|bibliography|literaturecited|参考文献|引用文献)[:：]?$/i.test(
      t,
    )
  )
    return "main";
  if (
    /^(methodsreferences|supplement(?:ary|al)?references|ereferences|参考文献[（(]续[）)])[:：]?$/i.test(
      t,
    )
  )
    return "supplement";
  if (
    /^(referencesto(?:studies(?:included|excluded|awaiting(?:classification|assessment)|ongoing).*|ongoingstudies|otherpublishedversionsofthisreview)|additionalreferences|otherpublishedversionsofthisreview)$/i.test(
      t,
    )
  )
    return "grouped";
  return null;
}

type Marker = { direction: "from" | "to"; folio: number };
function continuation(text: string): Marker | null {
  const m = folded(text).match(
    /^[（(]?([上下])(?:接|转|續|续)(?:第)?(\d{1,4})[页頁][）)]?[。.]?$/,
  );
  return m
    ? { direction: m[1] === "上" ? "from" : "to", folio: Number(m[2]) }
    : null;
}

const hardBoundary = (text: string) => {
  const t = folded(text);
  return (
    /^(acknowledg(?:e)?ments?|authorcontributions?|conflictsofinterest|competinginterests|funding|dataavailability|supplementarymaterials?|supportinginformation|characteristicsofstudies|dataandanalyses|additionalinformation|contributionsofauthors|declarationsofinterest|致谢|基金项目|作者简介|利益冲突)[:：]?$/i.test(
      t,
    ) ||
    /^(?:appendix|appendices|附录)$/i.test(t) ||
    /^(?:\d+[.)]\s*)?(?:appendix|appendices|附录)(?:\s+|[:：\d]|$)/i.test(
      text.trim(),
    ) ||
    // Lettered appendix headings have a structural prefix; ordinary capitalized
    // citation titles are not a document boundary.
    /^[A-Z]\s+(?:EXPERIMENTS|IMPLEMENTATION DETAILS|ADDITIONAL RESULTS|PROOFS)\s*$/.test(
      text.trim(),
    ) ||
    /^(?:Publisher[’']?s\s+note|Acknowledg(?:e)?ments)\s*[:：]?\s+\p{Lu}/u.test(
      text.trim(),
    ) ||
    /^(?:received|accepted|revised)(?:[a-z]+)?(?:\d{1,2})?(?:19|20)\d{2}/i.test(
      t,
    ) ||
    /^(?:[（(])?(?:收稿日期|修回日期)[:：]/.test(t) ||
    /^Copyright\s*[©(]/i.test(text.trim()) ||
    /^characteristicsof(?:(?:included|excluded|ongoing)studies|studiesawaiting(?:assessment|classification))(?:\[orderedbystudyid\])?$/i.test(
      t,
    )
  );
};

type Candidate = {
  region: SequenceRegion;
  heading?: SequenceLine;
  from?: Marker & { line: SequenceLine };
  to?: Marker & { line: SequenceLine };
};
const MAX_REGION_CANDIDATES = 1024;

/** Heading-free lists require repeated author/number/publication evidence.
 * Number continuity only establishes a candidate sequence, never article identity.
 */
function unheadedCandidates(lines: readonly SequenceLine[]): Candidate[] {
  const features = lines.map((l) => sequenceLineFeatures(l.text));
  const entries: { start: number; end: number; number: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const feature = features[i];
    if (
      lines[i].role === "soft-noise" ||
      !feature.marker ||
      !feature.authorStart
    )
      continue;
    let end = i;
    let publication = feature.publication;
    for (
      let j = i + 1;
      !feature.complete && j < Math.min(lines.length, i + 24);
      j++
    ) {
      if (
        hardBoundary(lines[j].text) ||
        bibliographyHeading(lines[j].text) ||
        (features[j].marker && features[j].authorStart)
      )
        break;
      if (lines[j].role === "soft-noise") continue;
      const previous = lines[end];
      if (
        lines[j].page === previous.page &&
        lines[j].column === previous.column &&
        previous.y - lines[j].y > Math.max(previous.height, lines[j].height) * 4
      )
        break;
      end = j;
      publication += features[j].publication;
      // A source-printed year/page/identifier terminator bounds the final entry,
      // rather than swallowing all later text in a heading-free document.
      if (
        features[j].complete ||
        /\((?:19|20)\d{2}[a-z]?\)[.。]?\s*$/.test(lines[j].text)
      )
        break;
    }
    if (
      publication &&
      /\b(?:1[5-9]\d{2}|20\d{2}|21\d{2})\b/.test(
        lines
          .slice(i, end + 1)
          .map((l) => l.text)
          .join(" "),
      )
    )
      entries.push({ start: i, end, number: feature.marker.number });
  }
  const clusters: (typeof entries)[] = [];
  for (const entry of entries) {
    const cluster = clusters[clusters.length - 1];
    const previous = cluster?.[cluster.length - 1];
    const gap = previous ? lines.slice(previous.end + 1, entry.start) : [];
    if (
      previous &&
      entry.number === previous.number + 1 &&
      gap.filter((l) => l.role !== "soft-noise").length < 4 &&
      !gap.some((l) => hardBoundary(l.text))
    )
      cluster.push(entry);
    else clusters.push([entry]);
  }
  return clusters
    .filter((c) => c.length >= 3)
    .map((cluster) => {
      const first = lines[cluster[0].start];
      return {
        heading: first,
        region: {
          id: `region:${first.id}:unheaded`,
          kind: "unheaded",
          lines: lines
            .slice(cluster[0].start, cluster[cluster.length - 1].end + 1)
            .map((l) => ({ ...l, spans: l.spans.map((s) => ({ ...s })) })),
          evidence: [
            "repeated-number-author-publication-evidence",
            "article-ownership-unconfirmed",
          ],
        },
      };
    });
}

/** Ownership precedes decoding: neighbouring lists never share decoder state. */
export function selectSequenceRegions(
  lines: readonly SequenceLine[],
  pages: readonly SequencePage[],
  fromPage?: number,
): {
  regions: SequenceRegion[];
  selected: string[];
  diagnostics: SequenceDiagnostic[];
  ambiguous: boolean;
  limited: boolean;
} {
  const candidates: Candidate[] = [];
  const diagnostics: SequenceDiagnostic[] = [];
  const pageMap = new Map(pages.map((p) => [p.page, p]));
  let limited = false;
  let current: Candidate | undefined;
  const start = (
    line: SequenceLine,
    kind: SequenceRegion["kind"],
    evidence: string[],
  ) => {
    current = {
      region: { id: `region:${line.id}`, kind, lines: [], evidence },
      heading: line,
    };
    candidates.push(current);
    return current;
  };
  for (let sourceIndex = 0; sourceIndex < lines.length; sourceIndex++) {
    const sourceLine = lines[sourceIndex];
    const line = {
      ...sourceLine,
      spans: sourceLine.spans.map((s) => ({ ...s })),
    };
    const page = pageMap.get(line.page)!;
    const relativeY = line.y - (page.origin?.[1] || 0);
    if (
      /^page\d+of\d+$/i.test(folded(line.text)) &&
      (relativeY > page.height * 0.9 || relativeY < page.height * 0.1)
    )
      line.role = "soft-noise";
    if (line.role === "soft-noise") {
      current?.region.lines.push(line);
      continue;
    }
    const heading = bibliographyHeading(line.text);
    const marker = continuation(line.text);
    if (
      (heading || marker?.direction === "from") &&
      candidates.length >= MAX_REGION_CANDIDATES
    ) {
      limited = true;
      diagnostics.push({
        code: "region-candidate-limit",
        lineIDs: [line.id],
        severity: "error",
      });
      break;
    }
    if (marker?.direction === "from") {
      start(line, "main", ["back-continuation-marker"]).from = {
        ...marker,
        line,
      };
      continue;
    }
    if (marker?.direction === "to") {
      if (current) current.to = { ...marker, line };
      current = undefined;
      continue;
    }
    if (heading) {
      start(line, heading, ["bibliography-heading"]);
      continue;
    }
    if (!current) continue;
    if (
      current.region.kind === "grouped" &&
      /^[\p{L}\p{M}'’ .-]{2,80}\s+(?:19|20)\d{2}[a-z]?\s*(?:\{[^}]{0,100}\})?\s*$/u.test(
        line.text.trim(),
      )
    ) {
      current.region.lines.push({ ...line, role: "group", group: line.id });
      continue;
    }
    const splitStudyHeading =
      folded(line.text).toLowerCase() === "characteristics" &&
      /^(?:[A-Z]\s+){8,}[A-Z]$/.test(line.text.trim()) &&
      lines
        .slice(sourceIndex + 1, sourceIndex + 9)
        .some(
          (other) =>
            other.page === line.page &&
            other.x > line.x &&
            Math.abs(other.y - line.y) <= line.height * 0.4 &&
            folded(other.text).toLowerCase() === "ofstudies",
        );
    if (hardBoundary(line.text) || splitStudyHeading) {
      current.region.lines.push({ ...line, role: "hard-boundary" });
      current = undefined;
    } else current.region.lines.push(line);
  }
  for (const candidate of candidates) {
    if (!candidate.from) continue;
    const marker = candidate.from.line;
    // A back-continuation notice establishes the top of the continued page
    // region. Column-major order otherwise visits the neighbouring article's
    // upper right column after the target's lower left column.
    candidate.region.lines = candidate.region.lines.filter(
      (l) => l.page !== marker.page || l.y <= marker.y + marker.height * 0.4,
    );
    candidate.region.evidence.push("below-back-continuation-band");
  }
  if (!candidates.length) {
    const inferred = unheadedCandidates(lines);
    if (inferred.length > MAX_REGION_CANDIDATES) {
      limited = true;
      diagnostics.push({
        code: "region-candidate-limit",
        lineIDs: [],
        severity: "error",
      });
    }
    candidates.push(...inferred.slice(0, MAX_REGION_CANDIDATES));
  }
  const folios = new Map<number, Set<number>>();
  for (const line of lines) {
    const p = pageMap.get(line.page)!;
    const relativeY = line.y - (p.origin?.[1] || 0);
    if (!(relativeY > p.height * 0.88 || relativeY < p.height * 0.1)) continue;
    const m = folded(line.text).match(/^[·•—–-]*(\d{1,4})[·•—–-]*$/);
    if (m) {
      const set = folios.get(line.page) || new Set<number>();
      set.add(Number(m[1]));
      folios.set(line.page, set);
    }
  }
  // A reciprocal marker plus unique physical folios establishes a continuation.
  const edges = new Map<Candidate, Candidate>();
  let ambiguous = false;
  for (const source of candidates.filter((c) => c.to)) {
    const sourcePage = source.to!.line.page;
    const sourceFolios = folios.get(sourcePage);
    const possible = candidates.filter(
      (c) =>
        c.from &&
        c.from.line.page > sourcePage &&
        sourceFolios?.size === 1 &&
        sourceFolios.has(c.from.folio) &&
        folios.get(c.from.line.page)?.size === 1 &&
        folios.get(c.from.line.page)?.has(source.to!.folio),
    );
    const targetFolioPages = [...folios].filter(([, values]) =>
      values.has(source.to!.folio),
    );
    const sourceFolioPages = [...folios].filter(([, values]) =>
      [...(sourceFolios || [])].some((v) => values.has(v)),
    );
    const lastSource = [...source.region.lines]
      .reverse()
      .map(printedNumber)
      .find((n) => n !== undefined);
    const firstTarget = possible[0]?.region.lines
      .map(printedNumber)
      .find((n) => n !== undefined);
    const reset =
      lastSource !== undefined &&
      firstTarget !== undefined &&
      firstTarget <= lastSource;
    if (
      possible.length === 1 &&
      targetFolioPages.length === 1 &&
      sourceFolioPages.length === 1 &&
      !reset
    ) {
      edges.set(source, possible[0]);
    } else {
      diagnostics.push({
        code: "unresolved-continuation-ownership",
        lineIDs: [source.to!.line.id],
        severity: "warning",
      });
      ambiguous = true;
    }
  }
  for (const target of candidates.filter((c) => c.from)) {
    if ([...edges.values()].includes(target)) continue;
    ambiguous = true;
    diagnostics.push({
      code: "orphan-back-continuation",
      lineIDs: [target.from!.line.id],
      severity: "warning",
    });
  }
  const roots = candidates.filter(
    (c) => !c.from && c.region.lines.some((l) => l.role !== "soft-noise"),
  );
  let chosen: Candidate[] = [];
  const coversPage = (root: Candidate, page: number) => {
    const seen = new Set<Candidate>();
    let c: Candidate | undefined = root;
    while (c && !seen.has(c)) {
      seen.add(c);
      if (c.region.lines.some((l) => l.page === page)) return true;
      c = edges.get(c);
    }
    return false;
  };
  const markedRoots = roots.filter(
    (c) =>
      c.to &&
      edges.has(c) &&
      (fromPage === undefined || coversPage(c, fromPage)),
  );
  if (markedRoots.length === 1) {
    const seen = new Set<Candidate>();
    let c: Candidate | undefined = markedRoots[0];
    const joined: SequenceLine[] = [];
    while (c && !seen.has(c)) {
      seen.add(c);
      chosen.push(c);
      joined.push(...c.region.lines);
      c = edges.get(c);
    }
    if (c) {
      ambiguous = true;
      diagnostics.push({
        code: "continuation-cycle",
        lineIDs: [],
        severity: "warning",
      });
    } else {
      const parent = markedRoots[0];
      // Keep disconnected source geometry and original IDs, just one owned sequence.
      const joinedRegion: SequenceRegion = {
        ...parent.region,
        id: `${parent.region.id}:continued`,
        lines: joined,
        evidence: [...parent.region.evidence, "reciprocal-unique-folios"],
      };
      const first = candidates.indexOf(parent);
      candidates.splice(first, 0, {
        region: joinedRegion,
        heading: parent.heading,
      });
      chosen = [candidates[first]];
    }
  } else if (markedRoots.length > 1) {
    ambiguous = true;
    diagnostics.push({
      code: "multiple-continuation-roots",
      lineIDs: markedRoots.map((c) => c.heading!.id),
      severity: "warning",
    });
  } else {
    const eligible = roots.filter(
      (c) => fromPage === undefined || (c.heading?.page ?? 0) <= fromPage,
    );
    // Reading later pages for marker discovery does not include them in a
    // manual prefix parse. Only the proven continuation branch above can do so.
    if (fromPage !== undefined)
      for (const c of eligible) {
        c.region.lines = c.region.lines.filter((l) => l.page <= fromPage);
      }
    const mains = eligible.filter((c) => c.region.kind === "main");
    const groups = eligible.filter((c) => c.region.kind === "grouped");
    const unheaded = eligible.filter((c) => c.region.kind === "unheaded");
    if (mains.length === 1) {
      chosen = mains;
      // Qualified later sections have their own ownership and decoder context.
      let lastNumber = [...mains[0].region.lines]
        .reverse()
        .map(printedNumber)
        .find((n) => n !== undefined);
      const supplemental = eligible.filter(
        (c) =>
          c.region.kind === "supplement" &&
          c.heading!.order > mains[0].heading!.order,
      );
      for (const extra of supplemental) {
        const firstNumber = extra.region.lines
          .map(printedNumber)
          .find((n) => n !== undefined);
        if (lastNumber !== undefined && firstNumber === lastNumber + 1) {
          chosen.push(extra);
          ambiguous = true;
          diagnostics.push({
            code: "supplement-ownership-unconfirmed",
            lineIDs: [extra.heading!.id],
            severity: "warning",
          });
          lastNumber = [...extra.region.lines]
            .reverse()
            .map(printedNumber)
            .find((n) => n !== undefined);
        }
      }
    } else if (mains.length === 0 && groups.length) {
      const headings = groups.map((c) => folded(c.heading!.text).toLowerCase());
      if (new Set(headings).size !== headings.length) {
        ambiguous = true;
        diagnostics.push({
          code: "repeated-grouped-bibliography-owner",
          lineIDs: groups.map((c) => c.heading!.id),
          severity: "warning",
        });
      } else chosen = groups;
    } else if (mains.length === 0 && unheaded.length) {
      // Report heading-free candidates for review. Neither sequential numbers
      // nor topic similarity prove that separated lists belong to one paper.
      chosen = unheaded;
      ambiguous = true;
      diagnostics.push({
        code: "unheaded-ownership-unconfirmed",
        lineIDs: unheaded.map((c) => c.heading!.id),
        severity: "warning",
      });
    } else if (mains.length > 1 && fromPage !== undefined) {
      const near = mains.filter((c) =>
        c.region.lines.some((l) => l.page === fromPage),
      );
      if (near.length === 1) chosen = near;
      else ambiguous = true;
    } else if (mains.length > 1) ambiguous = true;
    if (ambiguous && !diagnostics.length)
      diagnostics.push({
        code: "multiple-bibliography-owners",
        lineIDs: mains.map((c) => c.heading!.id),
        severity: "warning",
      });
  }
  if (
    fromPage !== undefined &&
    !chosen.some((c) => c.region.lines.some((l) => l.page <= fromPage))
  )
    chosen = [];
  return {
    regions: candidates.map((c) => c.region),
    selected: chosen.map((c) => c.region.id),
    diagnostics,
    ambiguous,
    limited,
  };
}
