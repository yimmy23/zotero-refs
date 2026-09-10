# Sequence bibliography core

`sequence-v1` is a callable, experimental extraction engine. The production References panel still uses `src/pdf/parser.ts`. New-core output is not written into the panel cache, merged into library items, or used for import automatically. Promotion requires source-grounded regression evidence; matching the total number of references is insufficient.

## Pipeline

1. `sequenceReader.ts` snapshots original pdf.js runs, transforms, page dimensions and crop origins. Reader/document identity is locked across every asynchronous wait; each page is read once. The requested starting page is captured before waiting.
2. `sequenceLayout.ts` reconstructs reading order and columns from source geometry. Every line points back to its original run offsets. Input arrays and source strings remain unchanged.
3. `sequenceRegions.ts` assigns bibliography candidates before decoding. Plain, supplemental, grouped and heading-free lists are separate regions. Chinese forward/back continuation notices require reciprocal, unique printed folios. The continued page is bounded below its back notice so an upper neighbouring article is excluded. Conflicting owners are reported.
4. `sequenceDecoder.ts` uses a bounded beam over B (entry start), I (entry continuation), G (study group) and O (outside/noise). Soft noise preserves an unfinished entry; hard boundaries end its region. Publication occurrences remain distinct from study-group labels.
5. The existing metadata parser processes each resulting citation. It does not decide the new engine's line boundaries. The legacy parser is never silently invoked as a fallback.

The design takes architectural inspiration from [GROBID's separation of document segmentation, reference segmentation and citation parsing](https://grobid.readthedocs.io/en/latest/Principles/). This engine uses hand-written features and path scores. It is not a trained CRF, and scores are not probabilities or calibrated confidence values.

## API

```ts
import { parseSequencePDFReferences } from "../pdf/sequenceReader";

const result = await parseSequencePDFReferences(reader, {
  fromCurrentPage: false,
  shouldCancel: () => taskCancelled,
  onProgress: (read, total) => updateProgress(read, total),
});
```

The result contains `refs`, `extraction`, and the original `pages` snapshot. The existing development-only evaluation route exposes `dev.parseSequencePDFReferences`; production builds do not register that endpoint. For pure offline use, call `extractSequenceReferences(pages, { totalPages, fromPage })` with zero-based physical pages. `totalPages` establishes input coverage; omitting it does not assert that the whole PDF was supplied.

An extraction includes selected region IDs, entries, B/I/G/O decisions, diagnostics, work metrics and coverage. Each entry retains source line IDs, source spans, original line text (`rawText`), joined citation text (`text`), an original printed label/number when present, and a source anchor. `rawText` is reconstructed from source lines, not a byte-for-byte PDF stream; exact fragments are recoverable through spans and the original runs. Unnumbered entries never acquire invented printed numbers.

## Status and ownership

- `ok`: decoding completed without the currently detected ambiguity flags. It does **not** establish that every citation is correct or externally findable.
- `ambiguous`: partial input, uncertain ownership, numbering conflicts, unexplained publication lines or weak starts require review. Candidate entries may still be present; consumers must inspect status and diagnostics before acting on them.
- `unsupported`: no supported bibliography or usable reader was found. This is not evidence that the paper has no references.
- `limited`: a document/layout/region/decoder work budget was reached. A partial candidate is not a complete extraction.
- `cancelled` / `error`: reader execution stopped or failed; the reader adapter returns no actionable references.

Number continuity and topical similarity cannot establish shared article identity. Heading-free candidates are explicitly unconfirmed. Sequential supplemental lists are also unconfirmed, and an earlier supplement cannot attach backwards to a later main list. Repeated top-level grouped headings are treated as an ownership conflict. Reciprocal continuation handling currently requires forward physical PDF order and unique printed folios; reordered or contradictory sources remain unresolved.

## Local comparison

```sh
npm run test:sequence
npm run check
npm run lint:check
npm run benchmark:sequence -- --manifest /absolute/manifest.json --out-dir /absolute/new-result-directory
```

A manifest is an explicit list of local PDF paths:

```json
[
  {
    "key": "example",
    "path": "/absolute/paper.pdf",
    "sha256": "optional verified hash"
  }
]
```

The runner refuses an existing output directory. Each PDF runs in a fresh process with a total deadline. The engines independently open the same verified bytes. Reports preserve source and bundle hashes, original pages, returned references, diagnostics, page-read counts and elapsed time. CMaps/fonts are local; network interfaces are blocked. `pdfjs-benchmark` is a development-only alias so it does not replace Zotero's pdf.js type package. Native Zotero uses its own pdf.js version and needs separate testing.

Gold evaluation must distinguish printed numbering, publication occurrences, study groups and synthetic display ordinals. Compare source-confirmed starts, tails, ownership and anchors as well as counts. Already inspected library PDFs are development data, not an unseen validation set. A benchmark status or a provider search hit is not an accuracy estimate.

## Operational limits

The reader caps input at 500 pages, 250,000 runs and 8 million source characters, with a 30-second bound on each asynchronous wait. Region ownership caps candidates at 1,024; the decoder caps a region at 20,000 lines and an entry at 64 lines, with a beam width of eight. Layout has its own explicit page/work guards. Limits yield diagnostics and a `limited` status instead of silently claiming completeness.

All extraction and comparison work is local. The core does not upload PDFs, call metadata services, change source text, renumber gaps, or write Zotero library data. OCR repair, page-image recognition, rotated text, manuscript line numbers and arbitrary multi-article ownership are not general solutions in this first engine. Difficult cases remain visible in regression reports before any default-route change.
