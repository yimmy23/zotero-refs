import type {
  RegionDecodeResult,
  SequenceDecision,
  SequenceDiagnostic,
  SequenceEntry,
  SequenceLine,
  SequenceRegion,
} from "./sequenceTypes";

// These are bounded, hand-written path scores, not a trained model or probabilities.
const BEAM = 8;
const MAX_LINES = 20_000;
const MAX_ENTRY_LINES = 64;
const MAX_TEXT = 20_000;
const MAX_SPANS = 512;
const PERSON_NAME = String.raw`\p{Lu}[\p{L}'’‐-]*\.?(?:\s+(?:\p{Lu}[\p{L}'’‐-]*\.?|de|van|von|der|da|del)){1,5}`;
const FULL_NAME_AUTHOR = new RegExp(
  String.raw`^(?:${PERSON_NAME})(?:\s*,\s*(?:${PERSON_NAME}|and\b)|\s+and\s+(?:${PERSON_NAME})|\s+et\s+al\.|\.\s+\S)`,
  "u",
);

interface Marker {
  label: string;
  number: number;
  end: number;
  family: "bracket" | "parenthesis" | "dot" | "bare";
}

export interface SequenceLineFeatures {
  marker?: Marker;
  authorStart: boolean;
  /** Count of bibliographic forms, not a confidence estimate. */
  publication: number;
  complete: boolean;
}

function markerAtStart(text: string): Marker | undefined {
  const patterns: [RegExp, Marker["family"]][] = [
    [/^\s*(?:\[|［)\s*([0-9０-９]{1,5})\s*[\]］]\s*/u, "bracket"],
    [/^\s*[（(]\s*([0-9０-９]{1,5})\s*[）)]\s*/u, "parenthesis"],
    [/^\s*([0-9０-９]{1,5})\s*[.．)、]\s*/u, "dot"],
    [/^\s*([0-9０-９]{1,5})\s+(?=[\p{L}“"‘'])/u, "bare"],
  ];
  for (const [pattern, family] of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const number = Number(match[1].normalize("NFKC"));
    if (number < 1 || number > 99_999) return;
    // A bare publication year is not a reference number. Volume/page fragments
    // fail the letter gate below, even when punctuation resembles a label.
    if (
      (family === "bare" || family === "dot") &&
      number >= 1500 &&
      number <= 2199
    )
      return;
    const body = text.slice(match[0].length).trimStart();
    if (body && !/^[\p{L}“"‘']/u.test(body)) return;
    return {
      label: match[0].trim(),
      number,
      end: match[0].length,
      family,
    };
  }
}

/** Pure, bounded line features. They never modify or replace source text. */
export function sequenceLineFeatures(text: string): SequenceLineFeatures {
  if (typeof text !== "string" || text.length > MAX_TEXT)
    return { authorStart: false, publication: 0, complete: false };
  const marker = markerAtStart(text);
  const body = text
    .slice(marker?.end ?? 0)
    .normalize("NFKC")
    .trim()
    .replace(/^[*∗]\s*/u, ""); // Grouped review primary-publication mark; source stays intact.
  // Require an author-like construction, never just an initial capital letter.
  const authorBody = body.replace(
    /^(?:(?:van|von|de|del|der|da|di|den|la|le)\s+){1,3}(?=\p{Lu})/u,
    "",
  );
  const authorStart =
    FULL_NAME_AUTHOR.test(authorBody) ||
    /^[\p{Script=Han}]{2,6}\s*[,，、]/u.test(authorBody) ||
    /^(?:[\p{Lu}][\p{L}'’‐-]+\s+){1,3}(?:[\p{Lu}]\.?){1,4}(?=[,;:.\s]|$)/u.test(
      authorBody,
    ) ||
    /^[\p{Lu}][\p{L}'’‐-]+,\s*(?:[\p{Lu}]\.(?=[\s,;]|$)|[\p{Lu}][\p{Ll}]+|0\.\s*\p{Lu}\.\s*\(\d{4}\))/u.test(
      authorBody,
    ) ||
    /^[\p{Lu}][\p{L}'’‐-]+\s+et\s+al\./u.test(authorBody);
  const year = /\b(?:1[5-9]\d{2}|20\d{2}|21\d{2})[a-z]?\b/iu.test(body);
  const identifier = /\b10\.\d{4,9}\/\S+|\bPMID\s*:?\s*\d{5,9}\b/iu.test(body);
  const type = /\[\s*(?:[JMCNDRSP]|EB|DB)(?:\s*\/\s*OL)?\s*\]/iu.test(body);
  const volumePages =
    /\b\d{1,4}\s*(?:\([^)]{1,12}\))?\s*:\s*[a-z]?\d+(?:\s*[-–—]\s*[a-z]?\d+)?/iu.test(
      body,
    );
  const complete =
    /(?:\b\d+\s*[-–—]\s*\d+|\b\d+\s*(?:\([^)]{1,12}\))?\s*:\s*[a-z]?\d+(?:\s*[-–—]\s*[a-z]?\d+)?|\b10\.\d{4,9}\/\S+|https?:\/\/\S+|\bPMID\s*:?\s*\d{5,9})[.。;\s]*$/iu.test(
      body,
    ) || /(?:,\s*|^)(?:1[5-9]\d{2}|20\d{2}|21\d{2})[a-z]?\.\s*$/iu.test(body);
  return {
    marker,
    authorStart,
    publication:
      Number(year) + Number(identifier) + Number(type) + Number(volumePages),
    complete,
  };
}

interface Feature extends SequenceLineFeatures {
  valid: boolean;
  prospect: number;
  hangingStart?: boolean;
  startMargin?: boolean;
}

interface Trace {
  previous?: Trace;
  index: number;
  label: SequenceDecision["label"];
  reason: string;
}

interface State {
  score: number;
  trace?: Trace;
  start: number;
  last: number;
  count: number;
  lastNumber?: number;
  family?: Marker["family"];
  group?: string;
  stopped: boolean;
  serial: number;
}

function validLine(line: SequenceLine | undefined): line is SequenceLine {
  return !!(
    line &&
    typeof line.id === "string" &&
    line.id.length > 0 &&
    line.id.length <= 512 &&
    typeof line.text === "string" &&
    line.text.length <= MAX_TEXT &&
    Number.isSafeInteger(line.page) &&
    line.page >= 0 &&
    [line.x, line.y, line.width, line.height, line.column, line.order].every(
      (value) => Number.isFinite(value) && Math.abs(value) < 1e8,
    ) &&
    line.width >= 0 &&
    line.height > 0 &&
    (line.role === undefined ||
      ["soft-noise", "hard-boundary", "group"].includes(line.role)) &&
    (line.group === undefined ||
      (typeof line.group === "string" && line.group.length <= 512)) &&
    Array.isArray(line.spans) &&
    line.spans.length <= MAX_SPANS &&
    line.spans.every(
      (span) =>
        span &&
        [span.page, span.item, span.start, span.end].every(
          Number.isSafeInteger,
        ) &&
        span.page === line.page &&
        span.item >= 0 &&
        span.start >= 0 &&
        span.end >= span.start,
    )
  );
}

function geometry(previous: SequenceLine, next: SequenceLine): boolean {
  if (next.page > previous.page) return true; // Ownership was decided upstream.
  if (next.page < previous.page) return false;
  if (next.column !== previous.column) return true;
  const height = Math.max(previous.height, next.height);
  const distance = previous.y - next.y;
  return (
    distance >= -height * 0.3 &&
    distance <= height * 4.5 &&
    Math.abs(next.x - previous.x) <= height * 10
  );
}

function continuesAuthorList(
  previous: SequenceLine,
  next: SequenceLine,
  before: Feature,
  after: Feature,
): boolean {
  if (
    !before.authorStart ||
    before.publication > 0 ||
    !after.authorStart ||
    after.marker ||
    !geometry(previous, next)
  )
    return false;
  if (previous.page === next.page && previous.column === next.column) {
    const height = Math.max(previous.height, next.height);
    if (next.x < previous.x - height * 0.2 || previous.y - next.y > height * 2)
      return false;
  }
  return (
    /(?:[,，;；]|\band)\s*$/u.test(previous.text) ||
    /(?:^|[,\s])\p{Lu}[\p{L}'’]+[-‐]\s*$/u.test(previous.text)
  );
}

/**
 * Bounded beam decoding over B/I/G/O and the last printed number/group.
 * Beam pruning means this is not guaranteed to find the global best path.
 * Input order is the upstream region's reading order; no other region is read.
 */
export function decodeRegion(region: SequenceRegion): RegionDecodeResult {
  const result: RegionDecodeResult = {
    entries: [],
    decisions: [],
    diagnostics: [],
    score: 0,
    transitions: 0,
    limited: false,
  };
  const diagnostic = (
    code: string,
    lineIDs: string[],
    severity: SequenceDiagnostic["severity"] = "warning",
  ) => result.diagnostics.push({ code, lineIDs, severity });
  if (
    !region ||
    typeof region.id !== "string" ||
    !region.id.length ||
    region.id.length > 512 ||
    !Array.isArray(region.lines)
  ) {
    diagnostic("invalid-region", [], "error");
    return result;
  }
  const lines = region.lines.slice(0, MAX_LINES);
  if (lines.length < region.lines.length) {
    result.limited = true;
    diagnostic("region-line-limit", [], "error");
  }
  const seen = new Set<string>();
  const features: Feature[] = Array.from(lines, (line) => {
    const valid = validLine(line) && !seen.has(line.id);
    if (!valid) {
      diagnostic("invalid-source-line", [String(line?.id ?? "")], "error");
      return {
        valid: false,
        authorStart: false,
        publication: 0,
        complete: false,
        prospect: 0,
      };
    }
    seen.add(line.id);
    return { ...sequenceLineFeatures(line.text), valid, prospect: 0 };
  });
  // Repeated outdented author starts establish a bibliography's hanging-indent
  // margin. This supports long author lists whose publication year is far away,
  // and isolated corporate authors, without treating every capital as a start.
  const margins = new Map<number, number>();
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i],
      b = lines[i + 1];
    if (
      !features[i].valid ||
      !features[i + 1].valid ||
      a.role ||
      b.role ||
      !features[i].authorStart ||
      a.page !== b.page
    )
      continue;
    const height = Math.max(a.height, b.height);
    if (
      b.x - a.x >= height * 0.5 &&
      b.x - a.x <= height * 3 &&
      a.y - b.y >= height * 0.5 &&
      a.y - b.y <= height * 2
    ) {
      features[i].hangingStart = true;
      const bucket = Math.round(a.x / 4) * 4;
      margins.set(bucket, (margins.get(bucket) ?? 0) + 1);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (features[i].valid) {
      const bucket = Math.round(lines[i].x / 4) * 4;
      features[i].startMargin = [-4, 0, 4].some(
        (offset) =>
          (margins.get(bucket + offset) ?? 0) >= 2 &&
          Math.abs(bucket + offset - lines[i].x) <= lines[i].height * 0.4,
      );
    }
  }
  // A short look-ahead can support an author-only first line; it cannot borrow
  // a year from the next entry, group, or confirmed outside boundary.
  for (let i = 0; i < lines.length; i++) {
    if (!features[i].valid || lines[i].role) continue;
    let last = i;
    for (let j = i; j < Math.min(lines.length, i + 8); j++) {
      const candidate = features[j];
      if (
        !candidate.valid ||
        lines[j].role === "hard-boundary" ||
        lines[j].role === "group"
      )
        break;
      if (lines[j].role === "soft-noise") continue;
      const markerOnly =
        !!features[i].marker &&
        !lines[i].text.slice(features[i].marker!.end).trim();
      const continuesAuthors = continuesAuthorList(
        lines[last],
        lines[j],
        features[last],
        candidate,
      );
      if (
        j > i &&
        (candidate.marker ||
          (candidate.authorStart && !markerOnly && !continuesAuthors) ||
          !geometry(lines[last], lines[j]))
      )
        break;
      features[i].prospect = Math.max(
        features[i].prospect,
        candidate.publication,
      );
      last = j;
    }
  }
  let serial = 0;
  let beam: State[] = [
    {
      score: 0,
      start: -1,
      last: -1,
      count: 0,
      stopped: false,
      serial: serial++,
    },
  ];
  let pruned = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const feature = features[index];
    const candidates: State[] = [];
    for (const state of beam) {
      const add = (
        label: SequenceDecision["label"],
        delta: number,
        reason: string,
        changes: Partial<State> = {},
      ) => {
        result.transitions++;
        candidates.push({
          ...state,
          ...changes,
          score: state.score + delta,
          trace: { previous: state.trace, index, label, reason },
          serial: serial++,
        });
      };
      if (state.stopped || !feature.valid || line.role === "hard-boundary") {
        add(
          "O",
          0,
          state.stopped
            ? "after-hard-boundary"
            : feature.valid
              ? "hard-boundary"
              : "invalid-source",
          { stopped: true, start: -1, last: -1, count: 0 },
        );
        continue;
      }
      if (line.role === "soft-noise") {
        add("O", 0, "soft-noise"); // Preserve active entry, solid geometry and number.
        continue;
      }
      if (line.role === "group") {
        add("G", 2, "group-heading", {
          start: -1,
          last: -1,
          count: 0,
          lastNumber: undefined,
          family: undefined,
          group: line.group || line.id,
        });
        continue;
      }
      const active = state.start >= 0;
      const previous = active ? lines[state.last] : undefined;
      const connected = !!previous && geometry(previous, line);
      const previousComplete = active && features[state.last].complete;
      const continuesAuthors =
        !!previous &&
        continuesAuthorList(previous, line, features[state.last], feature);
      const aligned =
        active &&
        Math.abs(lines[state.start].x - line.x) <=
          Math.max(lines[state.start].height, line.height) * 0.8;
      const gap =
        !!previous &&
        previous.page === line.page &&
        previous.column === line.column &&
        previous.y - line.y > Math.max(previous.height, line.height) * 1.6;
      const publicationStart =
        (feature.prospect > 0 && (feature.authorStart || !!feature.marker)) ||
        (!!feature.startMargin &&
          ((!!feature.hangingStart && feature.authorStart) ||
            (feature.prospect > 0 && (!active || gap))));
      const followsBareLabel =
        active &&
        state.count === 1 &&
        !!features[state.start].marker &&
        !lines[state.start].text
          .slice(features[state.start].marker!.end)
          .trim();
      if (publicationStart && !(followsBareLabel && !feature.marker)) {
        const marker = feature.marker;
        let score = marker ? 10 : 4;
        score += Math.min(feature.prospect, 2);
        if (feature.authorStart) score += 2;
        if (feature.startMargin) score += 2;
        if (active && !marker) score += previousComplete ? 2 : -4;
        if (active && !marker && !aligned) score -= 3;
        if (!marker && continuesAuthors) score -= 5;
        if (gap) score++;
        let reason = marker
          ? "printed-label"
          : feature.authorStart
            ? "author-publication-start"
            : "layout-publication-start";
        if (marker && state.lastNumber !== undefined) {
          if (marker.number === state.lastNumber + 1) {
            score += 4;
            reason = "printed-sequence";
          } else if (marker.number <= state.lastNumber) score -= 5;
          if (marker.family !== state.family) score--;
        }
        add("B", score, reason, {
          start: index,
          last: index,
          count: 1,
          lastNumber: marker?.number,
          family: marker?.family,
        });
      }
      if (active && connected && state.count < MAX_ENTRY_LINES) {
        let score = 5;
        if (publicationStart && feature.marker) score -= 18;
        else if (publicationStart && previousComplete) score -= 9;
        else if (publicationStart && aligned) score -= 2;
        add(
          "I",
          score,
          continuesAuthors
            ? "author-list-continuation"
            : "continuation-geometry",
          {
            last: index,
            count: state.count + 1,
          },
        );
      }
      add("O", active && connected ? -4 : 0, "outside-entry", {
        start: -1,
        last: -1,
        count: 0,
      });
    }
    // Merge only states with the same future-relevant history. Stable serial
    // order breaks score ties deterministically without inspecting raw strings.
    candidates.sort((a, b) => b.score - a.score || a.serial - b.serial);
    const unique = new Map<string, State>();
    for (const candidate of candidates) {
      const key = JSON.stringify([
        candidate.start,
        candidate.last,
        candidate.count,
        candidate.lastNumber,
        candidate.family,
        candidate.group,
        candidate.stopped,
      ]);
      if (!unique.has(key)) unique.set(key, candidate);
    }
    if (unique.size > BEAM) pruned = true;
    beam = [...unique.values()].slice(0, BEAM);
  }
  const best = beam[0];
  result.score = best.score;
  if (pruned) diagnostic("beam-pruned", [], "info");
  const path: Trace[] = [];
  for (let trace = best.trace; trace; trace = trace.previous) path.push(trace);
  path.reverse();
  let entry: SequenceEntry | undefined;
  const publicationEntries = new Set<SequenceEntry>();
  let group: string | undefined;
  let lastPrinted: number | undefined;
  for (const step of path) {
    const line = lines[step.index];
    const feature = features[step.index];
    result.decisions.push({
      lineID: String(line?.id ?? ""),
      label: step.label,
      reasons: [step.reason],
    });
    if (step.label === "G") {
      entry = undefined;
      lastPrinted = undefined;
      group = line.group || line.id;
    } else if (step.label === "B") {
      const marker = feature.marker;
      if (
        marker &&
        lastPrinted !== undefined &&
        marker.number !== lastPrinted + 1
      )
        diagnostic(
          marker.number <= lastPrinted
            ? "printed-number-reset"
            : "printed-number-gap",
          [line.id],
        );
      lastPrinted = marker?.number;
      entry = {
        id: `${region.id}:entry:${line.id}`,
        regionID: region.id,
        ...(group ? { group } : {}),
        ...(marker
          ? { printedLabel: marker.label, printedNumber: marker.number }
          : {}),
        rawText: line.text,
        text: line.text.slice(marker?.end ?? 0).trim(),
        lineIDs: [line.id],
        spans: line.spans.map((span) => ({ ...span })),
        anchor: { page: line.page, x: line.x, y: line.y + line.height },
      };
      result.entries.push(entry);
      if (feature.publication > 0) publicationEntries.add(entry);
      if (!marker && !feature.authorStart)
        diagnostic("layout-only-entry-start", [line.id]);
    } else if (step.label === "I" && entry) {
      entry.rawText += `\n${line.text}`;
      entry.text += ` ${line.text.trim()}`;
      entry.lineIDs.push(line.id);
      entry.spans.push(...line.spans.map((span) => ({ ...span })));
      if (feature.publication > 0) publicationEntries.add(entry);
    } else if (step.label === "O" && step.reason !== "soft-noise") {
      if (
        feature.valid &&
        feature.publication > 0 &&
        step.reason !== "after-hard-boundary"
      )
        diagnostic("unassigned-publication-line", [line.id]);
      entry = undefined;
    }
  }
  for (const parsed of result.entries) {
    if (!publicationEntries.has(parsed))
      diagnostic(
        "entry-without-publication-evidence",
        parsed.lineIDs.slice(0, 1),
      );
    if (parsed.lineIDs.length >= MAX_ENTRY_LINES) {
      result.limited = true;
      diagnostic("entry-line-limit", parsed.lineIDs.slice(-1));
    }
  }
  return result;
}
