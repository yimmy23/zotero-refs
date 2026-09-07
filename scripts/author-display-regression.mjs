import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/core/popupMetadata.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { mergePopupMetadata: merge } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const ref = (source, authors, extra = {}) => ({
  source,
  authors,
  title: "Synthetic author enrichment study",
  identifiers: { DOI: "10.5555/author-fixture" },
  ...extra,
});
const remote = (info) => ({ info, kind: "remote" });
const firstLast = (result) => [result.firstAuthors, result.lastAuthors];

test("surname-only baseline gets full first and last names while keeping internal byline", () => {
  const base = ref("crossref", ["Carter", "Senter"]);
  const result = merge(base, [
    remote(ref("openalex", ["Paul Carter", "Peter Senter"])),
  ]);
  assert.deepEqual(firstLast(result), [["Paul Carter"], ["Peter Senter"]]);
  assert.deepEqual(result.info.authors, ["Carter", "Senter"]);
  assert.equal(result.firstAuthorsByOrder, true);
  assert.deepEqual(result.correspondingAuthors, []);
});

test("verified 2008 Carter and Senter names preserve the published middle initials", () => {
  // Author metadata verified at https://pubmed.ncbi.nlm.nih.gov/18536555/.
  const base = ref("crossref", ["Carter", "Senter"], {
    title: "Antibody-drug conjugates for cancer therapy",
    identifiers: { DOI: "10.1097/PPO.0b013e318172d704" },
  });
  const candidate = {
    ...base,
    source: "pubmed",
    authors: ["Paul J Carter", "Peter D Senter"],
    identifiers: { ...base.identifiers, PMID: "18536555" },
  };
  assert.deepEqual(firstLast(merge(base, [remote(candidate)])), [
    ["Paul J Carter"],
    ["Peter D Senter"],
  ]);
});

test("initials expand in common ordering formats, retaining diacritics and particles", () => {
  for (const base of [
    ["Carter PD", "Senter PW"],
    ["P. D. Carter", "P. W. Senter"],
    ["Carter, P. D.", "Senter, P. W."],
  ]) {
    const result = merge(ref("crossref", base), [
      remote(ref("openalex", ["Paul David Carter", "Peter Walter Senter"])),
    ]);
    assert.deepEqual(firstLast(result), [
      ["Paul David Carter"],
      ["Peter Walter Senter"],
    ]);
  }
  assert.deepEqual(
    firstLast(
      merge(ref("crossref", ["Casal-Mouriño", "van der Waals"]), [
        remote(
          ref("openalex", ["Ana Casal-Mouriño", "Johannes van der Waals"]),
        ),
      ]),
    ),
    [["Ana Casal-Mouriño"], ["Johannes van der Waals"]],
  );
});

test("conflicting initials and full given names are not overwritten", () => {
  for (const [base, candidate] of [
    [
      ["P. D. Carter", "Senter"],
      ["Paul Samuel Carter", "Peter Senter"],
    ],
    [
      ["Paul Carter", "Peter Senter"],
      ["Peter Carter", "Paul Senter"],
    ],
  ])
    assert.deepEqual(
      firstLast(
        merge(ref("crossref", base), [remote(ref("openalex", candidate))]),
      ),
      [[base[0]], [base.at(-1)]],
    );
});

test("uppercase JR and SR remain initials rather than generational suffixes", () => {
  const base = ref("crossref", ["Molina JR", "Taylor SR"]);
  const good = remote(ref("openalex", ["Julian R Molina", "Sarah R Taylor"]));
  assert.deepEqual(firstLast(merge(base, [good])), [
    ["Julian R Molina"],
    ["Sarah R Taylor"],
  ]);
  const conflict = remote(ref("openalex", ["John Q Molina", "Sarah Q Taylor"]));
  assert.deepEqual(firstLast(merge(base, [conflict])), [
    ["Molina JR"],
    ["Taylor SR"],
  ]);
});

test("duplicate surnames and indistinguishable initials are not guessed by position", () => {
  for (const base of [
    ["Wang", "Wang"],
    ["W. Wang", "W. Wang"],
  ]) {
    const result = merge(ref("crossref", base), [
      remote(ref("openalex", ["Wei Wang", "Wen Wang"])),
    ]);
    assert.deepEqual(firstLast(result), [[base[0]], [base[1]]]);
  }
  const result = merge(ref("crossref", ["W. Wang", "L. Wang"]), [
    remote(ref("openalex", ["Wei Wang", "Li Wang"])),
  ]);
  assert.deepEqual(firstLast(result), [["Wei Wang"], ["Li Wang"]]);
});

test("shorter source lists cannot rename their last known author as the paper's last", () => {
  const base = ref("crossref", ["A. Smith", "B. Jones", "C. Taylor"]);
  const result = merge(base, [
    remote(ref("openalex", ["Alice Smith", "Bob Jones"])),
  ]);
  assert.deepEqual(firstLast(result), [["Alice Smith"], ["C. Taylor"]]);
  assert.deepEqual(result.info.authors, base.authors);
});

test("a longer consistent complete byline supplies the actual last author", () => {
  const base = ref("crossref", ["Smith", "Jones"]);
  const result = merge(base, [
    remote(ref("openalex", ["Alice Smith", "Bob Jones", "Clara Taylor"])),
  ]);
  assert.deepEqual(firstLast(result), [["Alice Smith"], ["Clara Taylor"]]);
  assert.deepEqual(result.info.authors, base.authors);
});

test("an API-capped author list never presents its final returned entry as last author", () => {
  const authors = Array.from({ length: 100 }, (_, i) => "Author " + i);
  const base = ref("openalex", authors, { authorsTruncated: true });
  const result = merge(base, []);
  assert.deepEqual(result.firstAuthors, [authors[0]]);
  assert.deepEqual(result.lastAuthors, []);
  assert.equal(result.info.authorsTruncated, true);
  const explicit = merge(
    { ...base, correspondingAuthors: ["Explicit Author"] },
    [],
  );
  assert.deepEqual(explicit.correspondingAuthors, ["Explicit Author"]);
  assert.deepEqual(explicit.firstAuthors, [authors[0]]);
});

test("a compatible complete byline can supply the last author missing from a capped source", () => {
  const base = ref("crossref", ["Smith", "Jones"], { authorsTruncated: true });
  const result = merge(base, [
    remote(ref("openalex", ["Alice Smith", "Bob Jones", "Clara Taylor"])),
  ]);
  assert.deepEqual(firstLast(result), [["Alice Smith"], ["Clara Taylor"]]);
  assert.equal(
    result.info.authorsTruncated,
    true,
    "internal original byline retains its own completeness marker",
  );
});

test("et-al truncation never supplies a last author or falsely expands a partial tail", () => {
  const base = ref("crossref", ["Smith", "Jones et al."]);
  const result = merge(base, [
    remote(ref("openalex", ["Alice Smith", "Bob Jones", "Clara Taylor"])),
  ]);
  assert.deepEqual(firstLast(result), [["Smith"], []]);
  const complete = ref("crossref", ["A. Smith", "B. Jones", "C. Taylor"]);
  const partial = merge(complete, [
    remote(ref("openalex", ["Alice Smith", "Bob Jones et al."])),
  ]);
  assert.deepEqual(partial.lastAuthors, ["C. Taylor"]);
});

test("explicit co-first and corresponding roles keep membership and enrich uniquely mapped names", () => {
  const base = ref("pubmed", ["A. Smith", "B. Jones", "C. Taylor"], {
    firstAuthors: ["A. Smith", "B. Jones"],
    correspondingAuthors: ["A. Smith", "C. Taylor"],
  });
  const result = merge(base, [
    remote(ref("openalex", ["Alice Smith", "Bob Jones", "Clara Taylor"])),
  ]);
  assert.deepEqual(result.firstAuthors, ["Alice Smith", "Bob Jones"]);
  assert.deepEqual(result.correspondingAuthors, [
    "Alice Smith",
    "Clara Taylor",
  ]);
  assert.deepEqual(result.lastAuthors, []);
  assert.equal(result.firstAuthorsByOrder, false);
  assert.deepEqual(result.info.firstAuthors, base.firstAuthors);
  assert.deepEqual(result.info.correspondingAuthors, base.correspondingAuthors);
});

test("ambiguous or unmapped explicit roles stay as supplied", () => {
  const base = ref("pubmed", ["A. Smith", "B. Smith", "C. Taylor"], {
    firstAuthors: ["Smith"],
    correspondingAuthors: ["External Author"],
  });
  const result = merge(base, [
    remote(ref("openalex", ["Alice Smith", "Bob Smith", "Clara Taylor"])),
  ]);
  assert.deepEqual(result.firstAuthors, ["Smith"]);
  assert.deepEqual(result.correspondingAuthors, ["External Author"]);
});

test("same-paper identifier conflicts and inconsistent byline order veto enrichment", () => {
  const base = ref("crossref", ["Smith", "Jones"]);
  const conflict = ref("openalex", ["Alice Smith", "Bob Jones"], {
    identifiers: { DOI: "10.5555/other-paper" },
  });
  assert.deepEqual(firstLast(merge(base, [remote(conflict)])), [
    ["Smith"],
    ["Jones"],
  ]);
  assert.deepEqual(
    firstLast(
      merge(base, [remote(ref("openalex", ["Bob Jones", "Alice Smith"]))]),
    ),
    [["Smith"], ["Jones"]],
  );
});

test("source completion order never determines displayed names", () => {
  const base = ref("crossref", ["Smith", "Jones"]);
  const candidates = [
    remote(ref("openalex", ["Alice Smith", "Bob Jones"])),
    remote(ref("semanticscholar", ["A. Smith", "B. Jones"])),
    remote(ref("readpaper", ["Alice Mary Smith", "Bob Edward Jones"])),
  ];
  const permutations = (values) =>
    values.length
      ? values.flatMap((v, i) =>
          permutations(values.filter((_, j) => i !== j)).map((rest) => [
            v,
            ...rest,
          ]),
        )
      : [[]];
  const expected = merge(base, candidates);
  for (const order of permutations(candidates))
    assert.deepEqual(merge(base, order), expected);
  assert.deepEqual(firstLast(expected), [
    ["Alice Mary Smith"],
    ["Bob Edward Jones"],
  ]);
});

test("Europe PMC source link preserves only valid HTTP(S) addresses", () => {
  for (const url of [
    "https://europepmc.org/article/MED/123456",
    "javascript:alert(1)",
    "file:///private/data",
    "https://",
  ]) {
    const result = merge(ref("crossref", ["Smith"]), [
      remote(ref("europepmc", [], { url })),
    ]);
    assert.equal(
      result.sources.find((source) => source.source === "europepmc").url,
      url.startsWith("https://europepmc.org/") ? url : undefined,
    );
  }
});
