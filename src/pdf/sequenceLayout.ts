import type {
  SequenceDiagnostic,
  SequenceLine,
  SequencePage,
  SourceSpan,
} from "./sequenceTypes";

type Part = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  span: SourceSpan;
  tilted: boolean;
};
type Band = { parts: Part[]; cuts: number[] };

const median = (values: number[], fallback = 1) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? fallback;
};
const topDown = (a: Part, b: Part) =>
  b.y - a.y || a.x - b.x || a.span.item - b.span.item;
const leftToRight = (a: Part, b: Part) =>
  a.x - b.x || a.span.item - b.span.item;

function baselineGroups(input: readonly Part[], height: number): Part[][] {
  const groups: Part[][] = [];
  for (const part of input) {
    const last = groups[groups.length - 1];
    if (
      last &&
      Math.abs(last[0].y - part.y) <=
        Math.min(height, Math.max(last[0].height, part.height)) * 0.4
    )
      last.push(part);
    else groups.push([part]);
  }
  return groups;
}

function horizontalGroups(
  input: readonly Part[],
  height: number,
  width: number,
): Part[][] {
  const groups: Part[][] = [];
  let right = -Infinity;
  for (const part of [...input].sort(leftToRight)) {
    if (
      groups.length &&
      part.x - right <= Math.max(height * 2.5, width * 0.035)
    ) {
      groups[groups.length - 1].push(part);
      right = Math.max(right, part.x + part.width);
    } else {
      groups.push([part]);
      right = part.x + part.width;
    }
  }
  return groups;
}

/** At most 256 horizontal bins: work is bounded by runs and occupied rows. */
function findCuts(
  parts: readonly Part[],
  page: SequencePage,
  height: number,
): number[] {
  const rows = baselineGroups(parts, height);
  const origin = page.origin?.[0] || 0;
  const step = Math.max(2, height * 0.3, page.width / 256);
  const count = Math.ceil(page.width / step) + 1;
  const support = new Uint32Array(count),
    crossing = new Uint32Array(count);
  const bin = (x: number) =>
    Math.max(0, Math.min(count - 1, Math.round((x - origin) / step)));
  for (const row of rows) {
    const ordered = [...row].sort(leftToRight);
    const holes = new Set<number>(),
      ink = new Set<number>();
    let right = -Infinity;
    for (const part of ordered) {
      if (
        Number.isFinite(right) &&
        part.x - right >= Math.max(4, height * 0.6)
      ) {
        for (let i = bin(right + 1); i <= bin(part.x - 1); i++) holes.add(i);
      }
      for (let i = bin(part.x + 1); i <= bin(part.x + part.width - 1); i++)
        ink.add(i);
      right = Math.max(right, part.x + part.width);
    }
    for (const i of holes) if (!ink.has(i)) support[i]++;
    for (const i of ink) crossing[i]++;
  }
  type Valley = { x: number; score: number; support: number };
  const valleys: Valley[] = [];
  let active: number[] = [];
  const finish = () => {
    if (!active.length) return;
    const score = (i: number) => support[i] / (1 + crossing[i]);
    let peak = 0;
    for (const i of active) peak = Math.max(peak, score(i));
    // Two peaks separated by printed glyphs are different corridors. Their
    // midpoint can lie inside a reference label, even in the same broad valley.
    const plateaus: number[][] = [];
    for (const i of active) {
      if (score(i) < peak * 0.85) continue;
      const last = plateaus[plateaus.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i);
      else plateaus.push([i]);
    }
    plateaus.sort(
      (a, b) => b.length - a.length || score(b[0]) - score(a[0]) || a[0] - b[0],
    );
    const plateau = plateaus[0];
    const x = origin + ((plateau[0] + plateau[plateau.length - 1]) * step) / 2;
    const width = (plateau[plateau.length - 1] - plateau[0] + 1) * step;
    valleys.push({
      x,
      score: peak * Math.sqrt(Math.min(3, width / height)),
      support: support[plateau[0]],
    });
    active = [];
  };
  for (let i = 0; i < count; i++) {
    const x = i * step;
    if (
      x > page.width * 0.15 &&
      x < page.width * 0.85 &&
      support[i] >= Math.max(3, rows.length * 0.05) &&
      support[i] >= crossing[i]
    )
      active.push(i);
    else finish();
  }
  finish();
  valleys.sort(
    (a, b) => b.score - a.score || b.support - a.support || a.x - b.x,
  );
  const cuts: number[] = [];
  for (const valley of valleys) {
    if (valley.score < (valleys[0]?.score || 0) * 0.35) break;
    if (cuts.some((cut) => Math.abs(cut - valley.x) < page.width * 0.18))
      continue;
    cuts.push(valley.x);
    if (cuts.length === 2) break;
  }
  if (cuts.length) return cuts.sort((a, b) => a - b);

  // Offset columns can share no baselines at all. Require wide local lines
  // on both sides, an actual gap, and overlapping vertical coverage.
  const pieces = rows.flatMap((row) =>
    horizontalGroups(row, height, page.width),
  );
  const boxes = pieces.map((group) => {
    let x = Infinity,
      right = -Infinity;
    for (const part of group) {
      x = Math.min(x, part.x);
      right = Math.max(right, part.x + part.width);
    }
    return { x, right, y: median(group.map((p) => p.y)) };
  });
  const starts = [
    ...new Set(boxes.map((box) => Math.round(box.x / height) * height)),
  ]
    // Bound the number of large candidate gaps by the physical page width.
    // Off-page runs remain in the output and keep their original spans.
    .filter((x) => x >= origin && x <= origin + page.width)
    .sort((a, b) => a - b);
  let best = 0,
    found: number | undefined;
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] - starts[i - 1] < page.width * 0.18) continue;
    const split = (starts[i] + starts[i - 1]) / 2;
    const left = boxes.filter(
      (b) =>
        b.x < split && b.right < starts[i] && b.right - b.x > page.width * 0.12,
    );
    const right = boxes.filter(
      (b) => b.x >= split && b.right - b.x > page.width * 0.12,
    );
    if (left.length < 3 || right.length < 3) continue;
    const edgeL = median(left.map((b) => b.right)),
      edgeR = median(right.map((b) => b.x));
    const extent = (values: typeof boxes) =>
      values.reduce(
        (a, b) => ({ lo: Math.min(a.lo, b.y), hi: Math.max(a.hi, b.y) }),
        { lo: Infinity, hi: -Infinity },
      );
    const a = extent(left),
      b = extent(right);
    const score = Math.min(left.length, right.length);
    if (
      edgeR - edgeL > height &&
      Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > height * 2 &&
      score > best
    ) {
      found = (edgeL + edgeR) / 2;
      best = score;
    }
  }
  return found === undefined ? [] : [found];
}

function pageBands(parts: Part[], page: SequencePage, height: number): Band[] {
  const rows = baselineGroups(parts, height);
  const ys = rows.map((r) => median(r.map((p) => p.y)));
  const pitches = ys
    .slice(1)
    .map((y, i) => ys[i] - y)
    .filter((gap) => gap > height * 0.6);
  const gapLimit = Math.max(height * 2, median(pitches, height) * 1.7);
  const chunks: Part[][] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === 0 || ys[i - 1] - ys[i] > gapLimit) chunks.push([]);
    for (const part of rows[i]) chunks[chunks.length - 1].push(part);
  }
  const bands: Band[] = [];
  for (const chunk of chunks) {
    chunk.sort(topDown);
    const cuts = findCuts(chunk, page, height);
    const previous = bands[bands.length - 1];
    if (
      previous &&
      previous.cuts.length === cuts.length &&
      cuts.every(
        (cut, i) =>
          Math.abs(cut - previous.cuts[i]) < height * 0.4 ||
          [...previous.parts, ...chunk].every(
            (part) =>
              ![cut, previous.cuts[i]].some(
                (x) => part.x < x && part.x + part.width > x,
              ),
          ),
      )
    ) {
      // Blank paragraph rows must not restart otherwise identical columns.
      for (const part of chunk) previous.parts.push(part);
    } else bands.push({ parts: chunk, cuts });
  }
  return bands;
}

function makeLine(
  group: Part[],
  column: number,
  height: number,
  mostlyHorizontal: boolean,
): SequenceLine {
  group.sort(leftToRight);
  let text = "",
    x = Infinity,
    right = -Infinity,
    first = Infinity;
  for (let i = 0; i < group.length; i++) {
    const part = group[i],
      previous = group[i - 1];
    if (
      previous &&
      part.x - previous.x - previous.width > height * 0.12 &&
      !/\s$/.test(text) &&
      !/^\s/.test(part.text)
    )
      text += " ";
    text += part.text;
    x = Math.min(x, part.x);
    right = Math.max(right, part.x + part.width);
    first = Math.min(first, part.span.item);
  }
  return {
    id: `p${group[0].span.page}:r${first}`,
    page: group[0].span.page,
    order: 0,
    column,
    x,
    y: median(group.map((p) => p.y)),
    width: right - x,
    height: median(group.map((p) => p.height)),
    text,
    spans: group.map((p) => ({ ...p.span })),
    ...(mostlyHorizontal && group.every((p) => p.tilted)
      ? { role: "soft-noise" as const }
      : {}),
  };
}

function bandLines(
  band: Band,
  page: SequencePage,
  height: number,
  mostlyHorizontal: boolean,
): SequenceLine[] {
  const output: SequenceLine[] = [],
    consumed = new Set<Part>();
  // A crossing run belongs to an entire connected horizontal line. Keep its
  // left/right neighbours with it rather than emitting three paragraph pieces.
  if (band.cuts.length) {
    for (const row of baselineGroups(band.parts, height)) {
      for (const group of horizontalGroups(row, height, page.width)) {
        if (
          !group.some((p) =>
            band.cuts.some((cut) => p.x < cut && p.x + p.width > cut),
          )
        )
          continue;
        group.forEach((p) => consumed.add(p));
        output.push(makeLine(group, -1, height, mostlyHorizontal));
      }
    }
  }
  const columns: Part[][] = Array.from(
    { length: band.cuts.length + 1 },
    () => [],
  );
  for (const part of band.parts) {
    if (!consumed.has(part))
      columns[band.cuts.filter((cut) => part.x >= cut).length].push(part);
  }
  for (let column = 0; column < columns.length; column++) {
    for (const row of baselineGroups(columns[column], height)) {
      for (const group of horizontalGroups(row, height, page.width))
        output.push(makeLine(group, column, height, mostlyHorizontal));
    }
  }
  // Binary-search full-width separators once per line, not once per sort
  // comparison. Adjacent full-width paragraph lines retain top-down order.
  const separators = output
    .filter((l) => l.column === -1)
    .map((l) => l.y)
    .sort((a, b) => b - a);
  const rank = new Map<SequenceLine, number>();
  for (const line of output) {
    let low = 0,
      high = separators.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (separators[mid] > line.y + line.height * 0.4) low = mid + 1;
      else high = mid;
    }
    rank.set(line, low);
  }
  return output.sort(
    (a, b) =>
      rank.get(a)! - rank.get(b)! ||
      (a.column === -1 ? 99 : a.column) - (b.column === -1 ? 99 : b.column) ||
      b.y - a.y ||
      a.x - b.x ||
      a.id.localeCompare(b.id),
  );
}

/** Geometry-only reconstruction; original page arrays and offsets never change. */
export function buildSequenceLines(pages: readonly SequencePage[]): {
  lines: SequenceLine[];
  diagnostics: SequenceDiagnostic[];
} {
  const lines: SequenceLine[] = [],
    diagnostics: SequenceDiagnostic[] = [];
  for (const page of pages) {
    if (page.items.length > 40000) {
      diagnostics.push({
        code: "layout-page-budget-exceeded",
        lineIDs: [`p${page.page}`],
        severity: "warning",
      });
      continue;
    }
    const parts: Part[] = [];
    for (let i = 0; i < page.items.length; i++) {
      const item = page.items[i];
      if (!item || typeof item.str !== "string") {
        diagnostics.push({
          code: "invalid-text-run",
          lineIDs: [`p${page.page}:r${i}`],
          severity: "warning",
        });
        continue;
      }
      if (!item.str.trim()) continue;
      const t = item.transform;
      if (
        !Array.isArray(t) ||
        t.length < 6 ||
        ![...t.slice(0, 6), item.width, item.height].every(Number.isFinite) ||
        item.height <= 0
      ) {
        diagnostics.push({
          code: "invalid-run-geometry",
          lineIDs: [`p${page.page}:r${i}`],
          severity: "warning",
        });
        continue;
      }
      parts.push({
        text: item.str,
        x: t[4] + Math.min(0, item.width),
        y: t[5],
        width: Math.abs(item.width),
        height: item.height,
        span: { page: page.page, item: i, start: 0, end: item.str.length },
        tilted: Math.abs(t[1]) > Math.max(0.01, Math.abs(t[0])) * 0.3,
      });
    }
    parts.sort(topDown);
    const height = median(parts.map((p) => p.height));
    const mostlyHorizontal =
      parts.filter((p) => !p.tilted).length >= parts.length * 0.8;
    for (const band of pageBands(parts, page, height)) {
      for (const line of bandLines(band, page, height, mostlyHorizontal))
        lines.push(line);
    }
  }
  const byMarginText = new Map<string, SequenceLine[]>();
  const strictMargin = new Set<SequenceLine>();
  const pageMap = new Map(pages.map((p) => [p.page, p]));
  for (const line of lines) {
    const page = pageMap.get(line.page)!;
    const relativeY = line.y - (page.origin?.[1] || 0);
    if (relativeY > page.height * 0.9 || relativeY < page.height * 0.14) {
      if (relativeY > page.height * 0.9 || relativeY < page.height * 0.09)
        strictMargin.add(line);
      const text = line.text.replace(/\s+/g, "");
      if (
        /^[·•—–-]*\d{1,4}[·•—–-]*$/.test(text) &&
        (relativeY > page.height * 0.96 || relativeY < page.height * 0.055)
      )
        line.role = "soft-noise";
      const key = [
        text,
        Math.round((relativeY / page.height) * 40),
        Math.round(((line.x - (page.origin?.[0] || 0)) / page.width) * 40),
        Math.round((line.width / page.width) * 40),
      ].join(":");
      const matching = byMarginText.get(key) || [];
      matching.push(line);
      byMarginText.set(key, matching);
    }
  }
  const repeated = [...byMarginText.values()].filter(
    (group) => new Set(group.map((l) => l.page)).size >= 2,
  );
  const boiler =
    /copyright|©|downloaded\s+from|all\s+rights\s+reserved|jstor|creative\s+commons/i;
  const confirmed = new Map<number, SequenceLine[]>();
  for (const group of repeated) {
    for (const line of group) {
      if (strictMargin.has(line) || boiler.test(line.text)) {
        line.role = "soft-noise";
        if (boiler.test(line.text)) {
          const footer = confirmed.get(line.page) || [];
          footer.push(line);
          confirmed.set(line.page, footer);
        }
      }
    }
  }
  // A Cochrane running review title belongs to the repeated copyright row
  // just below it. Do not extend generic duplicate-tail removal into the body.
  for (const group of repeated)
    for (const line of group) {
      if (
        /\(\s*Review\s*\)\s*$/i.test(line.text) &&
        confirmed
          .get(line.page)
          ?.some(
            (footer) =>
              line.y > footer.y &&
              line.y - footer.y < 3 * Math.max(line.height, footer.height) &&
              Math.abs(line.x - footer.x) < line.height,
          )
      ) {
        line.role = "soft-noise";
      }
    }
  lines.forEach((line, i) => {
    line.order = i;
  });
  return { lines, diagnostics };
}

/** Recover exact original run fragments; layout-inserted spaces are separate. */
export function sourceFragments(
  pages: readonly SequencePage[],
  spans: readonly SourceSpan[],
): string[] {
  const byPage = new Map(pages.map((p) => [p.page, p]));
  return spans.map((span) => {
    const text = byPage.get(span.page)?.items[span.item]?.str;
    if (
      text === undefined ||
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end < span.start ||
      span.end > text.length
    )
      throw new Error("Invalid source span");
    return text.slice(span.start, span.end);
  });
}
