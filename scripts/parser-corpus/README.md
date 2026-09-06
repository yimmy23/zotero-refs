# PDF parser regression corpus

Closed-loop harness for `src/pdf/parser.ts`. It drives the **dev-build** eval
endpoint (`src/modules/devEval.ts`, which exposes `dev.parsePDFReferences`)
inside an isolated Zotero profile, imports each PDF as an attachment, opens it
in the reader, parses, and compares the count with Crossref's `reference-count`.

Setup (local, private — PDFs never enter the repo):

1. `CORPUS_DIR=.corpus` (git-ignored). Put a `pdf_sample.json` there:
   `[{"journal": "...", "doi": "10....", "title": "...", "scratch": "/abs/path.pdf", "crossref_refs": 31}, ...]`
   (`crossref_refs` = `message["reference-count"]` from `api.crossref.org/works/<doi>`).
2. Start the isolated dev instance with `npm start`. The client resolves its port
   in this order: an explicit `ZPORT`; the `extensions.zotero.httpServer.port`
   preference in the dev profile's `prefs.js`; finally **23126** if that preference
   or file does not exist. `ZOTERO_PLUGIN_PROFILE_PATH` comes from the environment
   or this checkout's `.env`, falling back to `.scaffold/dev-profile`.
3. `CORPUS_DIR=.corpus python3 scripts/parser-corpus/batch_parse.py 0 32`
   → per-PDF `parsed` vs `truth`, `MISMATCH` flags, results in `$CORPUS_DIR/parse_results.json`.
   `one_parse.py <index> [sample-lines]` prints the parser's block log for one PDF.

For a manually launched instance, set `ZPORT=<connector port>` explicitly. The
client reads the current random token from `dev-eval-token.txt` in
`REFS_DEV_DATA_DIR`, or `ZOTERO_PLUGIN_DATA_DIR` (environment / `.env`), or
`.scaffold/dev-data`. Profile and data paths must resolve inside this checkout's
`.scaffold`; symlinks outside it are rejected. Before any imports, the endpoint
also verifies development mode and the exact expected data directory. Tokens and
unrelated profile preferences are never printed.

Run the client-only checks without Zotero, network requests, or private PDFs:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/parser-corpus/dev_client_regression.py
```

Baseline (2026-08-18, 32 PDFs across NEJM/Lancet/JAMA/JCO/Nature/Cell/Science/
Elsevier/Springer/BMJ/MDPI/Frontiers/AACR/Chinese journals/accepted manuscripts):
24/27 exact against Crossref; the 3 others are Crossref counting supplementary
references (Science, Cancer Cell — parse matches the PDF) and a Nature News &
Views sidebar layout (0, unsupported).
