/** Original PDF runs and source offsets stay separate from all derived text. */
export interface SequenceRun {
  str: string;
  transform: readonly number[];
  width: number;
  height: number;
  fontName?: string;
  dir?: string;
}

export interface SequencePage {
  page: number;
  width: number;
  height: number;
  items: readonly SequenceRun[];
  origin?: readonly [number, number];
}

export interface SourceSpan {
  page: number;
  item: number;
  start: number;
  end: number;
}

export interface SequenceLine {
  id: string;
  page: number;
  order: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  spans: SourceSpan[];
  role?: "soft-noise" | "hard-boundary" | "group";
  group?: string;
}

export interface SequenceDiagnostic {
  code: string;
  lineIDs: string[];
  severity: "info" | "warning" | "error";
}

export interface SequenceRegion {
  id: string;
  kind: "main" | "supplement" | "grouped" | "unheaded";
  lines: SequenceLine[];
  evidence: string[];
}

export interface SequenceEntry {
  id: string;
  regionID: string;
  group?: string;
  printedLabel?: string;
  printedNumber?: number;
  /** Includes the source label and preserved line boundaries. */
  rawText: string;
  /** Label-free text used by the existing field parser; rawText stays intact. */
  text: string;
  lineIDs: string[];
  spans: SourceSpan[];
  anchor: { page: number; x: number; y: number };
}

export interface SequenceDecision {
  lineID: string;
  label: "B" | "I" | "G" | "O";
  reasons: string[];
}

export interface RegionDecodeResult {
  entries: SequenceEntry[];
  decisions: SequenceDecision[];
  diagnostics: SequenceDiagnostic[];
  /** A relative path score, never a probability or an accuracy estimate. */
  score: number;
  transitions: number;
  limited: boolean;
}

export interface SequenceExtraction {
  version: "sequence-v1";
  status:
    "ok" | "ambiguous" | "unsupported" | "limited" | "cancelled" | "error";
  lines: SequenceLine[];
  regions: SequenceRegion[];
  selectedRegionIDs: string[];
  entries: SequenceEntry[];
  decisions: SequenceDecision[];
  diagnostics: SequenceDiagnostic[];
  metrics: { pages: number; runs: number; lines: number; transitions: number };
  coverage: {
    providedPages: number[];
    expectedPages?: number;
    complete: boolean;
  };
}
