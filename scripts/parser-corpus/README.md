# PDF parser regression corpus

Closed-loop harness for `src/pdf/parser.ts`. It drives the **dev-build** eval
endpoint (`src/modules/devEval.ts`, which exposes `dev.parsePDFReferences`)
inside an isolated Zotero profile, imports each PDF as an attachment, opens it
in the reader, parses, and compares the count with Crossref's `reference-count`.

Setup (local, private — PDFs never enter the repo):

1. `CORPUS_DIR=.corpus` (git-ignored). Put a `pdf_sample.json` there:
   `[{"journal": "...", "doi": "10....", "title": "...", "scratch": "/abs/path.pdf", "crossref_refs": 31}, ...]`
   (`crossref_refs` = `message["reference-count"]` from `api.crossref.org/works/<doi>`).
2. Start the dev instance (`npm start`, port 23124) or a manually launched one
   (`ZPORT=<connector port>`).
3. `CORPUS_DIR=.corpus ZPORT=23124 python3 scripts/parser-corpus/batch_parse.py 0 32`
   → per-PDF `parsed` vs `truth`, `MISMATCH` flags, results in `$CORPUS_DIR/parse_results.json`.
   `one_parse.py <index> [sample-lines]` prints the parser's block log for one PDF.

Baseline (2026-08-18, 32 PDFs across NEJM/Lancet/JAMA/JCO/Nature/Cell/Science/
Elsevier/Springer/BMJ/MDPI/Frontiers/AACR/Chinese journals/accepted manuscripts):
24/27 exact against Crossref; the 3 others are Crossref counting supplementary
references (Science, Cancer Cell — parse matches the PDF) and a Nature News &
Views sidebar layout (0, unsupported).
