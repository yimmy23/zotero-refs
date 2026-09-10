# Incremental bibliography parsing

The production route remains `parsePDFReferences` in `src/pdf/parser.ts`. It uses the existing C3 page/region selection, numbered merging and indentation fallback. The experimental sequence engine is not used as a fallback or default.

## Local improvements

- A narrowly gated branch merges flush-left author–parenthesized-year bibliographies. It combines author, year and publication-ending evidence, rather than treating every capitalized line as a new citation. Unsupported or ambiguous structures return to the existing merger.
- After the existing selector has finished, a separate finite-state branch handles strongly identified study-group bibliographies. It separates category and study labels from publications, supports multiple publications per study, preserves source characters, and returns to the established merger if any part is unsupported or ambiguous. It does not change selection probes or run the experimental whole-document decoder.
- Indentation companion lookup indexes the same source x coordinates once. For normal finite coordinates, each existence query uses binary search instead of scanning all lines. Unusual numeric inputs retain the original predicate.
- A diagnostic API distinguishes recognized leading labels from the UI's existing ordinal fallback. No storage migration, UI numbering change or additional network request is required.

## Diagnostic API

```ts
const { refs, diagnostics } = await parsePDFReferencesDetailed(reader, {
  fromCurrentPage: false,
});
```

This uses the same parser as `parsePDFReferences`. The normal production route omits the optional diagnostic report and source-position map. The grouped branch maintains its own bounded source-line partition internally. The detailed route is also available as `dev.parsePDFReferencesDetailed` in development builds; production does not register the development endpoint.

`diagnostics.status` is one of:

| Status        | Meaning                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `extracted`   | The parser returned references; accuracy and completeness remain unverified.        |
| `not-found`   | No bibliography was selected or no entries were produced.                           |
| `unavailable` | The reader's PDF application was unavailable.                                       |
| `partial`     | An explicit continuation source was recovered but its target could not be verified. |
| `ambiguous`   | Explicit continuation markers did not identify a unique source.                     |
| `error`       | Extraction failed; the existing public route still returns an empty list.           |

Each diagnostic entry carries `ordinal`, `displayNumber`, `printedNumber` and `sourceStart`. `printedNumber` is a recognized leading-number candidate, not independently validated ground truth; absent labels remain `null`. `sourceStart` contains only the existing first-line page/x/y anchor, not all source spans. Display ordinals must not be used to prove printed-number continuity.

`numbering` reports observed gaps, duplicate labels, ordering and whether labels are absent or mixed. A gap can reflect a parsing defect or the source itself. `completeness` remains `not-assessed`: the old parser does not account for every original source line, and a continuous sequence is not proof of complete extraction. Known partial continuation is recorded separately through the status.

## Selected-line attribution

`diagnostics.segmentation` records `grouped-study` or `legacy-merge`, plus the number of selected lines. Successful grouped segmentation also includes:

- `entries`: the preprocessed input line indices for each publication and its separate study/resource label.
- `decisions`: exactly one `B` (start), `I` (continuation), `G` (study/resource label), or `O` (recognized category/legend/empty line) decision per selected line.
- `sourceLines`: physical page, source column and PDF coordinates corresponding to those indices. These are line anchors, not original PDF glyph offsets or complete bounding boxes.

This attribution is local to the already selected bibliography. It does not certify that every bibliography in the document was found. A `legacy-merge` choice can mean the style gate did not apply or a safety condition rejected the specialized branch; detailed rejection reasons are not currently returned. No source trace is added to persistent library items or displayed as a correctness score.

The grouping decoder uses bounded passes and a single chunk join per accepted entry. Ordinary reference lists exit the style gate from their first line. It makes no extra PDF reads or network requests. This is a structural complexity improvement; measured end-to-end timing must be reported separately. See [research and selection rationale](hybrid-parser-research.md).

## Validation boundaries

Run `npm run check` and `npm run lint:check`. The offline suite includes neutral numbered, unnumbered, mixed-format and continuation fixtures, diagnostic contract tests, and floating-point equivalence checks for the indentation predicate.

Real-PDF comparison must retain the exact source bytes, compiled-source fingerprints and independent source gold. Compare entry starts, complete text, endings and anchors, not only counts. The 51-PDF gold set and 711-file corpus already used during development are regression material, not a blind evaluation set. The local evidence for this iteration lives under `.scaffold/review/legacy-core-20260910/`.
