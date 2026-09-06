import console from "node:console";
import process from "node:process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setImmediate } from "node:timers";
import { transformSync } from "esbuild";

// Synthetic metadata only. These tests do not access a real profile or network.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const makeRef = (source = "pdf", fields = {}) => ({
  title: "Synthetic methods for reproducible reference metadata",
  authors: ["A. Synthetic", "B. Fixture", "C. Example"],
  identifiers: { DOI: "10.5555/synthetic" },
  source,
  ...fields,
});
const remote = (info) => ({ info, kind: "remote" });
const library = (info) => ({ info, kind: "library" });

function environment() {
  const errors = [];
  const sources = { according: "DOI", thunks: [] };
  const items = new Map();
  const selected = [];
  const launched = [];
  const libraryIndex = { match: async () => undefined };
  const Zotero = {
    locale: "en-US",
    Items: { get: (id) => items.get(id) },
    CreatorTypes: { getID: () => 1 },
    DataDirectory: { dir: "/synthetic" },
    launchURL: (url) => launched.push(url),
  };
  const ztoolkit = { log: (...args) => errors.push(args) };
  class PopupCard {
    constructor() {
      this.updates = [];
    }
    onInit() {
      this.container = { isConnected: true };
    }
    clear() {
      this.container.isConnected = false;
    }
    update(title, tags, content, details) {
      this.updates.push({ title, tags, content, details });
    }
    get last() {
      return this.updates.at(-1);
    }
  }
  const getString = (key, options) =>
    options?.args?.count !== undefined
      ? `${key}: ${options.args.count}`
      : options?.args?.source
        ? `${key}: ${options.args.source}`
        : key;
  const globals = {
    Zotero,
    ztoolkit,
    URL,
    PathUtils: { join: path.join },
    IOUtils: { exists: async () => false },
  };
  const load = (file, imports = {}, extra = "") => {
    const code = transformSync(
      fs.readFileSync(path.join(root, file), "utf8") + extra,
      { loader: "ts", format: "cjs", target: "es2022" },
    ).code;
    const module = { exports: {} };
    new Function("module", "exports", "require", ...Object.keys(globals), code)(
      module,
      module.exports,
      (name) => {
        if (name === "../../package.json") return pkg;
        assert.ok(name in imports, `${file}: unmocked ${name}`);
        return imports[name];
      },
      ...Object.values(globals),
    );
    return module.exports;
  };
  const text = load("src/core/text.ts");
  const types = load("src/core/types.ts");
  const metadata = load("src/core/popupMetadata.ts", {
    "./text": text,
    "./types": types,
  });
  const windowTools = {
    setTimeout: () => 1,
    clearTimeout: () => {},
    getWin: () => ({
      Zotero_Tabs: { select: () => {} },
      ZoteroPane: { selectItem: (id) => selected.push(id) },
    }),
  };
  const rows = (extra = "") =>
    load(
      "src/ui/rows.ts",
      {
        "./controls": {},
        "../utils/prefs": {},
        "../utils/locale": { getString },
        "../utils/window": windowTools,
        "../core/text": text,
        "../core/libmatch": { libraryIndex },
        "../core/importer": {},
        "../core/types": types,
        "../core/popupMetadata": metadata,
        "../sources": { infoCandidates: () => sources },
        "../sources/cnki": {},
        "./popup": { PopupCard },
      },
      extra,
    );
  return {
    load,
    text,
    types,
    metadata,
    rows,
    sources,
    items,
    errors,
    windowTools,
    getString,
    selected,
    launched,
    libraryIndex,
  };
}

test("PubMed XML-decoded abstract remains plain text through the card", () => {
  const env = environment();
  const info = makeRef("pubmed", {
    abstract:
      "METHODS: Use <threshold> & preserve comparisons.\n\nRESULTS: Synthetic text.",
  });
  const result = env.metadata.mergePopupMetadata(makeRef(), [remote(info)]);
  assert.equal(result.content, info.abstract);
});

test("fusion is deterministic under every source arrival permutation", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const candidates = [
    remote(
      makeRef("openalex", {
        abstract: "Synthetic complete OpenAlex abstract.",
        citationCount: 80,
      }),
    ),
    remote(
      makeRef("crossref", {
        title: "Synthetic publisher title",
        abstract: "Synthetic registered abstract.",
        year: "2021",
      }),
    ),
    remote(makeRef("semanticscholar", { citationCount: 100 })),
    library(
      makeRef("zotero", {
        title: "Curated synthetic title",
        authors: ["Curated First", "Curated Last"],
        libItemID: 7,
      }),
    ),
  ];
  const permutations = (values) =>
    values.length
      ? values.flatMap((value, index) =>
          permutations(values.filter((_, i) => i !== index)).map((rest) => [
            value,
            ...rest,
          ]),
        )
      : [[]];
  const expected = merge(makeRef(), candidates);
  for (const order of permutations(candidates))
    assert.deepEqual(merge(makeRef(), order), expected);
  assert.equal(expected.info.title, "Curated synthetic title");
  assert.equal(expected.info.citationCount, 100);
});

test("shared DOI, PMID and arXiv conflicts veto a matching title", () => {
  const { samePopupPaper } = environment().metadata;
  for (const key of ["DOI", "PMID", "arXiv"])
    assert.equal(
      samePopupPaper(
        makeRef("pdf", { identifiers: { [key]: "one" } }),
        makeRef("crossref", { identifiers: { [key]: "two" } }),
      ),
      false,
    );
  assert.equal(
    samePopupPaper(
      makeRef("pdf", { identifiers: { arXiv: "2401.12345v1" } }),
      makeRef("arxiv", { identifiers: { arXiv: "2401.12345v3" } }),
    ),
    true,
  );
});

test("title-search results require exact normalized titles even with a returned DOI", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const candidate = remote(
    makeRef("crossref", {
      title: "Review of synthetic methods for reproducible reference metadata",
    }),
  );
  const result = merge(makeRef(), [candidate], true);
  assert.deepEqual(
    result.sources.map((s) => s.source),
    ["pdf"],
  );
});

test("conflicting new identifiers cannot join through a title-only baseline", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const a = remote(
    makeRef("crossref", {
      identifiers: { DOI: "10.5555/a" },
      abstract: "Selected synthetic abstract.",
    }),
  );
  const b = remote(
    makeRef("openalex", {
      identifiers: { DOI: "10.5555/b" },
      abstract: "Wrong synthetic abstract.",
      retracted: true,
    }),
  );
  const base = makeRef("pdf", { identifiers: {} });
  const merged = merge(base, [b, a], true);
  assert.equal(merged.info.identifiers.DOI, "10.5555/a");
  assert.equal(merged.content, "Selected synthetic abstract.");
  assert.equal(merged.info.retracted, undefined);
});

test("curated fields win and missing fields are supplied by a consistent source", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const result = merge(makeRef(), [
    library(
      makeRef("zotero", {
        year: "2020",
        publishDate: "2020",
        abstract: "Curated complete synthetic abstract.",
        primaryVenue: "",
        libItemID: 3,
      }),
    ),
    remote(
      makeRef("crossref", {
        year: "2021",
        publishDate: "2021-02-13",
        primaryVenue: "Synthetic Journal",
        abstract: "Different synthetic abstract.",
      }),
    ),
  ]);
  assert.equal(result.info.year, "2020");
  assert.equal(result.info.publishDate, "2020");
  assert.equal(result.info.primaryVenue, "Synthetic Journal");
  assert.equal(result.content, "Curated complete synthetic abstract.");
  assert.equal(result.abstractSource, "zotero");
});

test("one complete abstract is selected without concatenation or rewriting", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const complete =
    "Synthetic background. Synthetic methods. Synthetic results. Synthetic conclusion.";
  const result = merge(makeRef(), [
    remote(makeRef("pubmed", { abstract: "Synthetic clipped text..." })),
    remote(makeRef("openalex", { abstract: complete })),
    remote(makeRef("semanticscholar", { abstract: "Another clipped text…" })),
  ]);
  assert.equal(result.content, complete);
  assert.equal(result.abstractSource, "openalex");
});

test("raw citation is never reported as an abstract", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const result = merge(
    makeRef("pdf", {
      text: "Synthetic A. Synthetic title. Example 1986;7:13-16.",
    }),
    [],
  );
  assert.equal(result.contentKind, "citation");
  assert.equal(result.info.abstract, undefined);
  assert.equal(result.abstractSource, undefined);
});

test("internal author lists stay complete; unlabeled display uses byline ends", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const authors = Array.from(
    { length: 80 },
    (_, i) => `Synthetic Author ${i + 1}`,
  );
  const result = merge(makeRef("pdf", { authors }), []);
  assert.deepEqual(result.info.authors, authors);
  assert.deepEqual(result.firstAuthors, [authors[0]]);
  assert.deepEqual(result.lastAuthors, [authors.at(-1)]);
  assert.deepEqual(result.correspondingAuthors, []);
  assert.equal(result.firstAuthorsByOrder, true);
});

test("explicit co-first and co-corresponding groups survive without last-author inference", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const result = merge(makeRef(), [
    remote(
      makeRef("pubmed", {
        firstAuthors: ["A. Synthetic", "B. Fixture"],
        correspondingAuthors: ["A. Synthetic", "C. Example"],
      }),
    ),
  ]);
  assert.deepEqual(result.firstAuthors, ["A. Synthetic", "B. Fixture"]);
  assert.deepEqual(result.correspondingAuthors, ["A. Synthetic", "C. Example"]);
  assert.deepEqual(result.lastAuthors, []);
  assert.equal(result.firstAuthorsByOrder, false);
});

test("a sole author is not duplicated as an unlabeled last author", () => {
  const result = environment().metadata.mergePopupMetadata(
    makeRef("pdf", { authors: ["Single Synthetic"] }),
    [],
  );
  assert.deepEqual(result.firstAuthors, ["Single Synthetic"]);
  assert.deepEqual(result.lastAuthors, []);
});

test("an abbreviated citation byline never claims its last known author is last", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  for (const last of ["Baade PD et al.", "Baade PD 等", "等", "…"]) {
    const authors = ["Chen W", "Zheng R", last];
    const result = merge(makeRef("pdf", { authors }), []);
    assert.deepEqual(result.info.authors, authors);
    assert.deepEqual(result.firstAuthors, ["Chen W"]);
    assert.deepEqual(result.lastAuthors, []);
  }
  assert.deepEqual(
    merge(makeRef("pdf", { authors: ["Robins et al."] }), []).firstAuthors,
    ["Robins"],
  );
});

test("different byline entries with identical names are preserved", () => {
  const result = environment().metadata.mergePopupMetadata(
    makeRef("crossref", { authors: ["Wei Wang", "Wei Wang"] }),
    [],
  );
  assert.deepEqual(result.info.authors, ["Wei Wang", "Wei Wang"]);
  assert.deepEqual(result.lastAuthors, ["Wei Wang"]);
});

test("counts are never summed or selected by largest value", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const result = merge(makeRef(), [
    remote(makeRef("openalex", { citationCount: 1500 })),
    remote(
      makeRef("semanticscholar", { citationCount: 0, referenceCount: 20 }),
    ),
    remote(makeRef("crossref", { citationCount: 4 })),
  ]);
  assert.equal(result.info.citationCount, 0);
  assert.equal(result.info.referenceCount, 20);
  assert.equal(result.citationSource, "semanticscholar");
  assert.equal(result.referenceSource, "semanticscholar");
});

test("legacy metric chips are typed but a numeric library tag remains a tag", () => {
  const env = environment();
  const result = env.metadata.mergePopupMetadata(makeRef(), [
    remote(
      makeRef("readpaper", {
        tags: [{ text: 35, color: env.types.CITED_CHIP_COLOR }],
      }),
    ),
    library(makeRef("zotero", { tags: ["2024"] })),
  ]);
  assert.equal(result.info.citationCount, 35);
  assert.deepEqual(
    result.info.tags.map((tag) => tag.text),
    ["2024"],
  );
});

test("navigation order is full text, paper, PubMed, Scholar, Zotero", () => {
  const { popupLinks } = environment().metadata;
  const links = popupLinks(
    makeRef("crossref", {
      identifiers: {
        DOI: "https://doi.org/10.5555/synthetic",
        PMID: "12345678",
      },
      oaUrl: "https://example.test/synthetic.pdf",
      libItemID: 7,
    }),
  );
  assert.deepEqual(
    links.map((link) => link.kind),
    ["pdf", "doi", "pubmed", "scholar", "zotero"],
  );
  assert.equal(links[1].url, "https://doi.org/10.5555%2Fsynthetic");
});

test("malformed and OS-handler links are discarded, not launched", () => {
  const { popupLinks, popupURL } = environment().metadata;
  for (const value of [
    "javascript:alert(1)",
    "file:///tmp/paper.pdf",
    "smb://share/paper",
    "https://",
    "http://[",
    "https://good.test/ bad",
    "data:text/plain,x",
  ])
    assert.equal(popupURL(value), undefined);
  assert.deepEqual(
    popupLinks(
      makeRef("pdf", {
        identifiers: { CNKI: "file:///tmp/x", PMID: "../../unsafe" },
        title: "",
        url: "smb://share",
        oaUrl: "javascript:alert(1)",
        libItemID: -1,
      }),
    ),
    [],
  );
});

test("a cached library ID is not exposed without a validated library candidate", () => {
  const { mergePopupMetadata: merge } = environment().metadata;
  const result = merge(makeRef("pdf", { libItemID: 12 }), [
    library(
      makeRef("zotero", {
        identifiers: { DOI: "10.5555/different" },
        libItemID: 12,
      }),
    ),
  ]);
  assert.equal(result.info.libItemID, undefined);
});

test("rows render one progressively enriched card with labelled links and roles", async () => {
  const env = environment();
  env.sources.thunks = [
    async () =>
      makeRef("openalex", {
        abstract: "Synthetic remote abstract.",
        citationCount: 42,
        correspondingAuthors: ["B. Fixture"],
        oaUrl: "https://example.test/fulltext",
      }),
  ];
  const popup = env
    .rows()
    .showRefPopup(
      makeRef("pdf", { text: "Synthetic raw citation." }),
      {},
      "left",
    );
  assert.equal(popup.last.details.contentLabel, "popup-citation-label");
  await tick();
  assert.equal(popup.updates.length, 2);
  assert.equal(popup.last.details.contentLabel, "popup-abstract-label");
  assert.deepEqual(popup.last.details.correspondingAuthors, ["B. Fixture"]);
  assert.equal(popup.last.details.abstractSource, "OpenAlex");
  assert.deepEqual(
    popup.last.tags.filter((tag) => tag.url).map((tag) => tag.text),
    ["popup-link-pdf", "popup-link-doi", "popup-link-scholar"],
  );
  const count = popup.last.tags.find((tag) =>
    String(tag.text).includes("popup-cited-count"),
  );
  assert.equal(count.text, "popup-cited-count: 42");
  assert.equal(count.tip, "tag-cited-tip: OpenAlex");
  assert.equal(count.url, undefined);
  assert.equal(env.errors.length, 0);
});

test("late results from an old hover cannot update a replacement card", async () => {
  const env = environment();
  let resolve;
  env.sources.thunks = [
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  ];
  const rows = env.rows();
  const old = rows.showRefPopup(makeRef(), {}, "left");
  await tick();
  env.sources.thunks = [];
  const newer = rows.showRefPopup(
    makeRef("pdf", { title: "Another synthetic reference" }),
    {},
    "left",
  );
  resolve(makeRef("crossref", { abstract: "Late synthetic abstract." }));
  await tick();
  assert.equal(old.updates.length, 1);
  assert.equal(old.container.isConnected, false);
  assert.equal(newer.updates.length, 1);
  assert.equal(newer.last.title, "Another synthetic reference");
});

test("stale local bindings do not show unrelated metadata or a Zotero button", () => {
  const env = environment();
  env.items.set(12, {
    id: 12,
    deleted: false,
    isRegularItem: () => true,
    getField: (key) =>
      ({ title: "Unrelated local record", DOI: "10.5555/other" })[key] || "",
  });
  const popup = env
    .rows()
    .showRefPopup(makeRef("pdf", { libItemID: 12 }), {}, "left");
  assert.equal(popup.last.title, makeRef().title);
  assert.equal(
    popup.last.tags.some((tag) => tag.itemID),
    false,
  );
});

test("locating a row revalidates a stale binding before selecting an item", async () => {
  const env = environment();
  const { locateReference } = env.rows("\nexport { locateReference };\n");
  await locateReference(makeRef("pdf", { libItemID: 88 }), 1);
  assert.deepEqual(env.selected, []);
  assert.deepEqual(env.launched, ["https://doi.org/10.5555%2Fsynthetic"]);
  env.libraryIndex.match = async () => ({ id: 99 });
  await locateReference(makeRef("pdf", { libItemID: 88 }), 1);
  assert.deepEqual(env.selected, [99]);
});

test("validated library metadata retains full authors and does not fabricate January", () => {
  const env = environment();
  env.items.set(9, {
    id: 9,
    deleted: false,
    isRegularItem: () => true,
    getField: (key) =>
      ({
        title: "Curated synthetic title",
        DOI: "10.5555/synthetic",
        date: "1986",
        year: "1986",
        abstractNote: "Curated synthetic abstract.",
        publicationTitle: "Synthetic Methods",
      })[key] || "",
    getCreators: () => [
      { firstName: "First", lastName: "Synthetic", creatorTypeID: 1 },
      { firstName: "Last", lastName: "Synthetic", creatorTypeID: 1 },
    ],
    getTags: () => [],
  });
  const popup = env
    .rows()
    .showRefPopup(makeRef("pdf", { libItemID: 9 }), {}, "left");
  assert.equal(popup.last.title, "Curated synthetic title");
  assert.equal(popup.last.details.venue, "Synthetic Methods · 1986");
  assert.deepEqual(popup.last.details.firstAuthors, ["First Synthetic"]);
  assert.deepEqual(popup.last.details.lastAuthors, ["Last Synthetic"]);
  assert.equal(popup.last.tags.find((tag) => tag.itemID)?.itemID, 9);
});

test("accepted retraction metadata reaches the shared import action", async () => {
  const env = environment();
  env.sources.thunks = [async () => makeRef("openalex", { retracted: true })];
  const ref = makeRef();
  let sawRetraction = false;
  const popup = env.rows().showRefPopup(ref, {}, "left", undefined, {
    onImport: () => {
      sawRetraction = ref.retracted;
    },
  });
  await tick();
  popup.last.tags.find((tag) => tag.onClick).onClick();
  assert.equal(sawRetraction, true);
  assert.equal(popup.container.isConnected, false);
});

test("storage preserves all names and explicit roles while sanitizing their types", () => {
  const env = environment();
  const { sanitizeRef } = env.load(
    "src/core/storage.ts",
    { "../utils/window": env.windowTools, "./text": env.text },
    "\nexport { sanitizeRef };\n",
  );
  const authors = Array.from({ length: 80 }, (_, i) => `Synthetic ${i}`);
  const result = sanitizeRef(
    makeRef("pubmed", {
      authors,
      firstAuthors: ["A", 7, null, "<i>B</i>"],
      correspondingAuthors: [false, "C"],
      libItemID: 42,
    }),
  );
  assert.equal(result.authors.length, 80);
  assert.deepEqual(result.firstAuthors, ["A", "B"]);
  assert.deepEqual(result.correspondingAuthors, ["C"]);
  assert.equal(result.libItemID, undefined);
});

test("OpenAlex keeps explicit co-corresponding flags and never guesses from last position", () => {
  const env = environment();
  const { mapWork } = env.load(
    "src/sources/openalex.ts",
    {
      "../utils/prefs": {},
      "../core/text": env.text,
      "../core/http": {},
      "../core/types": env.types,
      "../utils/locale": { getString: env.getString },
    },
    "\nexport { mapWork };\n",
  );
  const result = mapWork({
    id: "https://openalex.org/W123",
    title: "Synthetic work",
    authorships: [
      {
        author: { display_name: "First" },
        author_position: "first",
        is_corresponding: true,
      },
      { author: { display_name: "Middle" }, is_corresponding: true },
      {
        author: { display_name: "Last" },
        author_position: "last",
        is_corresponding: false,
      },
    ],
  });
  assert.deepEqual(result.correspondingAuthors, ["First", "Middle"]);
  assert.equal(result.firstAuthors, undefined);
  assert.deepEqual(result.authors, ["First", "Middle", "Last"]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n`, error);
  }
}
console.log(
  `${tests.length - failed}/${tests.length} popup regressions passed`,
);
if (failed) process.exitCode = 1;
