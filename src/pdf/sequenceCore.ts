import { buildSequenceLines } from "./sequenceLayout";
import { selectSequenceRegions } from "./sequenceRegions";
import { decodeRegion } from "./sequenceDecoder";
import type { SequenceExtraction, SequencePage } from "./sequenceTypes";

/** First local sequence engine. This API does not silently invoke the old parser. */
export function extractSequenceReferences(
  pages: readonly SequencePage[],
  options: { fromPage?: number; totalPages?: number } = {},
): SequenceExtraction {
  const result: SequenceExtraction = {
    version: "sequence-v1",
    status: "unsupported",
    lines: [],
    regions: [],
    selectedRegionIDs: [],
    entries: [],
    decisions: [],
    diagnostics: [],
    metrics: {
      pages: Array.isArray(pages) ? pages.length : 0,
      runs: 0,
      lines: 0,
      transitions: 0,
    },
    coverage: {
      providedPages: [],
      expectedPages: options.totalPages,
      complete: false,
    },
  };
  if (!Array.isArray(pages)) {
    result.diagnostics.push({
      code: "invalid-document-input",
      lineIDs: [],
      severity: "error",
    });
    return result;
  }
  const budgetExceeded = () => {
    result.status = "limited";
    result.diagnostics.push({
      code: "document-budget-exceeded",
      lineIDs: [],
      severity: "warning",
    });
    return result;
  };
  if (pages.length > 500) return budgetExceeded();
  const seen = new Set<number>();
  let characters = 0;
  for (const page of pages) {
    if (
      !page ||
      !Array.isArray(page.items) ||
      !Number.isInteger(page.page) ||
      page.page < 0 ||
      seen.has(page.page) ||
      !Number.isFinite(page.width) ||
      page.width <= 0 ||
      !Number.isFinite(page.height) ||
      page.height <= 0 ||
      (page.origin !== undefined &&
        (!Array.isArray(page.origin) ||
          page.origin.length !== 2 ||
          !page.origin.every(Number.isFinite)))
    ) {
      result.diagnostics.push({
        code: "invalid-page-input",
        lineIDs: [],
        severity: "error",
      });
      return result;
    }
    seen.add(page.page);
    result.metrics.runs += page.items.length;
    if (result.metrics.runs > 250000) return budgetExceeded();
    for (const item of page.items) {
      characters += typeof item?.str === "string" ? item.str.length : 0;
      if (characters > 8_000_000) return budgetExceeded();
    }
  }
  result.coverage.providedPages = [...seen].sort((a, b) => a - b);
  result.coverage.complete =
    Number.isInteger(options.totalPages) &&
    options.totalPages === pages.length &&
    result.coverage.providedPages.every((p, i) => p === i);
  if (options.fromPage !== undefined && !seen.has(options.fromPage)) {
    result.diagnostics.push({
      code: "invalid-current-page",
      lineIDs: [],
      severity: "error",
    });
    return result;
  }
  const layout = buildSequenceLines(
    pages.slice().sort((a, b) => a.page - b.page),
  );
  if (!result.coverage.complete)
    result.diagnostics.push({
      code:
        options.totalPages === undefined
          ? "input-coverage-unknown"
          : "incomplete-page-coverage",
      lineIDs: [],
      severity: options.totalPages === undefined ? "info" : "warning",
    });
  result.lines = layout.lines;
  result.diagnostics.push(...layout.diagnostics);
  result.metrics.lines = layout.lines.length;
  const ownership = selectSequenceRegions(
    layout.lines,
    pages,
    options.fromPage,
  );
  result.regions = ownership.regions;
  result.selectedRegionIDs = ownership.selected;
  result.diagnostics.push(...ownership.diagnostics);
  result.status = ownership.ambiguous
    ? "ambiguous"
    : ownership.selected.length
      ? "ok"
      : "unsupported";
  for (const region of ownership.regions) {
    if (!ownership.selected.includes(region.id)) continue;
    const decoded = decodeRegion(region);
    result.entries.push(...decoded.entries);
    result.decisions.push(...decoded.decisions);
    result.diagnostics.push(...decoded.diagnostics);
    result.metrics.transitions += decoded.transitions;
    if (decoded.limited) result.status = "limited";
  }
  if (
    ownership.limited ||
    layout.diagnostics.some((d) => d.code.endsWith("budget-exceeded"))
  )
    result.status = "limited";
  const decided = new Set(result.decisions.map((d) => d.lineID));
  for (const line of result.lines)
    if (!decided.has(line.id)) {
      result.decisions.push({
        lineID: line.id,
        label: "O",
        reasons: ["outside-selected-bibliography"],
      });
    }
  if (!result.entries.length && result.status === "ok")
    result.status = "unsupported";
  if (
    result.status === "ok" &&
    options.totalPages !== undefined &&
    !result.coverage.complete
  )
    result.status = "ambiguous";
  if (
    result.status === "ok" &&
    result.diagnostics.some(
      (d) =>
        d.severity === "error" ||
        d.code.startsWith("invalid-") ||
        [
          "printed-number-gap",
          "printed-number-reset",
          "unassigned-publication-line",
          "entry-without-publication-evidence",
          "layout-only-entry-start",
        ].includes(d.code),
    )
  )
    result.status = "ambiguous";
  return result;
}
