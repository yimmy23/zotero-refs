import assert from "node:assert/strict";
import console from "node:console";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath, URL } from "node:url";
import { setTimeout, clearTimeout, setImmediate } from "node:timers";
import { build } from "esbuild";
import { DOMParser } from "@xmldom/xmldom";

// Exercise the actual identity -> library/provider -> importer modules. Only
// host persistence/translation and transport are synthetic; no real profile.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const compiled = await build({
  stdin: {
    contents: [
      'export * from "./src/core/importer";',
      'export * from "./src/core/text";',
      'export * from "./src/core/libmatch";',
      'export * from "./src/core/fuse";',
      'export { resolveDOIByTitle } from "./src/sources";',
      'export { crossref } from "./src/sources/crossref";',
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
});
const tests = [];
const test = (name, run) => tests.push([name, run]);
const ref = (overrides = {}) => ({
  identifiers: {},
  title: "Synthetic clinical trial treatment outcomes",
  authors: ["Smith J"],
  year: "2020",
  ...overrides,
});
const work = (overrides = {}) => ({
  DOI: "10.5555/correct",
  type: "journal-article",
  title: [ref().title],
  author: [{ given: "John", family: "Smith" }],
  published: { "date-parts": [[2020]] },
  ...overrides,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { resolve, promise };
};

function fixture(options = {}) {
  const items = new Map();
  const persisted = new Map();
  const inverseRelations = new Set();
  const relationKey = (id, predicate, value) =>
    JSON.stringify([id, predicate, value]);
  const Relations = {
    register: (_type, id, predicate, value) =>
      inverseRelations.add(relationKey(id, predicate, value)),
    unregister: (_type, id, predicate, value) =>
      inverseRelations.delete(relationKey(id, predicate, value)),
  };
  const calls = { translate: [], requests: [], saves: 0, transactions: 0 };
  let transaction = false;
  let nextID = 10;
  let failSave = options.failSave;
  class Item {
    constructor() {
      this.id = nextID++;
      this.key = `KEY${this.id}`;
      this.libraryID = 1;
      this.itemTypeID = 1;
      this.fields = {};
      this.creators = [];
      this.collections = [];
      this.relatedItems = [];
      items.set(this.id, this);
    }
    isRegularItem() {
      return true;
    }
    getField(field) {
      return this.fields[field] || "";
    }
    setField(field, value) {
      this.fields[field] = value;
    }
    getCreatorsJSON() {
      return this.creators;
    }
    setCreators(creators) {
      this.creators = creators;
    }
    getCollections() {
      return [...this.collections];
    }
    addToCollection(id) {
      if (!this.collections.includes(id)) this.collections.push(id);
    }
    addRelatedItem(other) {
      if (!this.relatedItems.includes(other.key))
        this.relatedItems.push(other.key);
    }
    async removeRelatedItem(other) {
      this.relatedItems = this.relatedItems.filter((key) => key !== other.key);
    }
    getRelations() {
      return { "dc:relation": [...this.relatedItems] };
    }
    setRelations(value) {
      this.relatedItems = [...(value["dc:relation"] || [])];
    }
    async reload() {
      this.relatedItems = [...(persisted.get(this.id)?.relations || [])];
    }
    async save() {
      assert.equal(transaction, true, "save() must use one outer transaction");
      if (++calls.saves === failSave) throw new Error("injected save failure");
      const before = persisted.get(this.id)?.relations || [];
      persisted.set(this.id, {
        relations: [...this.relatedItems],
        collections: [...this.collections],
      });
      // Native DataObject._postSave updates this nontransactional index even
      // when save() participates in an outer SQL transaction.
      for (const key of this.relatedItems)
        if (!before.includes(key))
          Relations.register("item", this.id, "dc:relation", key);
      for (const key of before)
        if (!this.relatedItems.includes(key))
          Relations.unregister("item", this.id, "dc:relation", key);
      return this.id;
    }
    async saveTx() {
      return DB.executeTransaction(() => this.save());
    }
  }
  const DB = {
    async executeTransaction(fn) {
      assert.equal(transaction, false, "no nested saveTx transaction");
      calls.transactions++;
      const before = globalThis.structuredClone(persisted);
      transaction = true;
      try {
        return await fn();
      } catch (error) {
        persisted.clear();
        for (const [id, state] of before) persisted.set(id, state);
        throw error;
      } finally {
        transaction = false;
      }
    },
  };
  const create = (fields = {}, libraryID = 1) => {
    const item = new Item();
    item.fields = { ...fields };
    item.libraryID = libraryID;
    item.creators = [
      { creatorType: "author", firstName: "John", lastName: "Smith" },
    ];
    persisted.set(item.id, { relations: [], collections: [] });
    return item;
  };
  const context = vm.createContext({
    module: { exports: {} },
    URL,
    console,
    setTimeout,
    clearTimeout,
    Zotero: {
      getMainWindow: () => ({ closed: false, setTimeout, clearTimeout }),
      Item,
      DB,
      Relations,
      DataDirectory: { dir: "/synthetic" },
      Prefs: { get: () => undefined },
      Libraries: { userLibraryID: 1 },
      Items: {
        getAll: async (libraryID) =>
          [...items.values()].filter((item) => item.libraryID === libraryID),
        get: (id) => items.get(id),
      },
      ItemFields: { getID: (value) => value, isValidForType: () => true },
      Promise: { delay: async () => {} },
      HTTP: {
        request: async (_method, url) => {
          calls.requests.push(url);
          assert.match(
            url,
            /^https:\/\/api.crossref.org\/works\?/,
            "no unverified single-result fallback",
          );
          const candidates = options.works || [];
          return {
            status: 200,
            response: {
              message: {
                items: candidates,
                "total-results": options.total ?? candidates.length,
              },
            },
          };
        },
      },
      Translate: {
        Search: class {
          setIdentifier(ids) {
            this.ids = { ...ids };
          }
          async getTranslators() {
            return [{}];
          }
          setTranslator() {}
          async translate(args) {
            calls.translate.push({ ids: this.ids, args });
            await options.translateWait?.promise;
            if (options.translateFailure) throw new Error("translator failed");
            const item = create(
              { title: ref().title, ...this.ids },
              args.libraryID,
            );
            item.collections = [...args.collections];
            return [item];
          }
        },
      },
    },
    addon: { data: {} },
    ztoolkit: { log: () => {}, getDOMParser: () => new DOMParser() },
    PathUtils: { join: path.join },
    IOUtils: { exists: async () => false },
    Components: { utils: { isDeadWrapper: () => false } },
  });
  vm.runInContext(compiled.outputFiles[0].text, context);
  return {
    ...context.module.exports,
    create,
    items,
    persisted,
    inverseRelations,
    relationKey,
    Relations,
    calls,
    clearFailure: () => {
      failSave = undefined;
    },
  };
}

for (const [positive, negative] of [
  [
    "HER2+ breast cancer treatment outcomes",
    "HER2− breast cancer treatment outcomes",
  ],
  [
    "α-catenin regulates clinical treatment outcomes",
    "β-catenin regulates clinical treatment outcomes",
  ],
  [
    "CD4⁺ cells and clinical treatment outcomes",
    "CD4⁻ cells and clinical treatment outcomes",
  ],
]) {
  test(`identity collision rejected across library, fusion and importer: ${positive}`, async () => {
    const f = fixture({ works: [work({ title: [positive] })] });
    f.create({ title: positive, DOI: "10.5555/wrong", date: "2020" });
    const target = ref({ title: negative });
    assert.notEqual(f.normalizeTitle(positive), f.normalizeTitle(negative));
    assert.equal(await f.libraryIndex.match(target), undefined);
    const fused = await f.fuseReferences(
      [target],
      [ref({ title: positive, identifiers: { DOI: "10.5555/wrong" } })],
      "semanticscholar",
    );
    assert.equal(fused.refs[0].identifiers.DOI, undefined);
    const host = f.create({ title: "Host", DOI: "10.5555/host" });
    const imported = await f.importReference(host, target);
    assert.equal(imported.getField("title"), negative);
    assert.equal(target.identifiers.DOI, undefined);
    assert.equal(f.calls.translate.length, 0);
  });
}

test("identity preserves case, whitespace, canonical accents and typographic dash equivalence", async () => {
  const f = fixture();
  assert.equal(
    f.titlesMatch("  HER2− Breast cancer ", "her2−breast CANCER"),
    true,
  );
  assert.equal(f.titlesMatch("α‐catenin café", "α-catenin cafe\u0301"), true);
});

test("local same-title author/year contradictions veto DOI backfill", async () => {
  for (const target of [ref({ authors: ["Jones A"] }), ref({ year: "2021" })]) {
    const f = fixture();
    f.create({ title: target.title, DOI: "10.5555/wrong", date: "2020" });
    assert.equal(await f.libraryIndex.match(target), undefined);
    assert.equal(target.identifiers.DOI, undefined);
  }
});

test("author-specific prefix negatives cannot poison a later correct match", async () => {
  const f = fixture();
  f.create({
    title: `${ref().title}: follow-up`,
    DOI: "10.5555/correct",
    date: "2020",
  });
  assert.equal(
    await f.libraryIndex.match(ref({ authors: ["Jones A"] })),
    undefined,
  );
  assert.ok(await f.libraryIndex.match(ref()));
});

test("same-title resolver passes reference context through the real importer", async () => {
  const f = fixture({
    works: [
      work({
        DOI: "10.5555/wrong",
        author: [{ family: "Jones" }],
        published: { "date-parts": [[2024]] },
      }),
      work(),
    ],
  });
  const target = ref();
  await f.importReference(f.create({ title: "Host" }), target);
  assert.equal(target.identifiers.DOI, "10.5555/correct");
  assert.equal(f.calls.translate[0].ids.DOI, "10.5555/correct");
});

for (const [label, target, works, total] of [
  ["title only", ref({ authors: [], year: undefined }), [work()]],
  ["conflicting author", ref({ authors: ["Jones A"] }), [work()]],
  ["conflicting year", ref({ year: "2021" }), [work()]],
  ["two plausible DOIs", ref(), [work(), work({ DOI: "10.5555/another" })]],
])
  test(`resolver does not promote ${label}`, async () => {
    const f = fixture({ works, total });
    assert.equal(await f.resolveDOIByTitle(target), null);
    assert.equal(await f.resolveDOIByTitle(target.title), null);
  });

test("duplicate candidate rows for one DOI remain one identity", async () => {
  const f = fixture({ works: [work(), work({ DOI: "10.5555/CORRECT" })] });
  assert.equal(
    (await f.resolveDOIByTitle(ref()))?.toLowerCase(),
    "10.5555/correct",
  );
});

test("large general-query totals do not discard a uniquely corroborated returned candidate", async () => {
  const f = fixture({ works: [work()], total: 1000000 });
  assert.equal(await f.resolveDOIByTitle(ref()), "10.5555/correct");
});

test("same-title incomplete author/year metadata cannot disambiguate a rival", async () => {
  for (const missing of [
    { author: [] },
    { published: undefined },
    { DOI: undefined },
  ]) {
    const f = fixture({
      works: [work(), work({ DOI: "10.5555/rival", ...missing })],
    });
    assert.equal(await f.resolveDOIByTitle(ref()), null);
  }
});

test("registration date is not publication-year corroboration", async () => {
  const f = fixture({
    works: [
      work({ published: undefined, created: { "date-parts": [[2020]] } }),
    ],
  });
  assert.equal(await f.resolveDOIByTitle(ref()), null);
});

test("resolver and printed-DOI imports share the same pending creation", async () => {
  const wait = deferred();
  const f = fixture({ works: [work()], translateWait: wait });
  const host = f.create({ title: "Host" });
  const a = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/correct" } }),
  );
  const b = f.importReference(host, ref());
  await new Promise(setImmediate);
  assert.equal(f.calls.translate.length, 1);
  wait.resolve();
  assert.equal((await a).id, (await b).id);
});

test("newly corroborated aliases join a pending import without starting another translator", async () => {
  const wait = deferred();
  const f = fixture({ translateWait: wait });
  const host = f.create({ title: "Host" });
  const a = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/shared" } }),
  );
  const b = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/shared", PMID: "12345678" } }),
  );
  const c = f.importReference(host, ref({ identifiers: { PMID: "12345678" } }));
  await new Promise(setImmediate);
  assert.equal(f.calls.translate.length, 1);
  wait.resolve();
  const results = await Promise.all([a, b, c]);
  assert.equal(new Set(results.map((item) => item.id)).size, 1);
});

test("completed import is immediately reusable without a notifier and adds a later collection", async () => {
  const f = fixture();
  const host = f.create({ title: "Host" });
  const a = await f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/shared" } }),
    [1],
  );
  const b = await f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/shared" } }),
    [2],
  );
  assert.equal(a.id, b.id);
  assert.equal(f.calls.translate.length, 1);
  assert.deepEqual([...b.collections].sort(), [1, 2]);
});

test("failed creation releases its pending key so a subsequent retry can run", async () => {
  const options = { translateFailure: true };
  const f = fixture(options);
  const host = f.create({ title: "Host" });
  const target = () =>
    ref({
      title: undefined,
      authors: [],
      year: undefined,
      identifiers: { DOI: "10.5555/shared" },
    });
  assert.equal(await f.importReference(host, target()), null);
  options.translateFailure = false;
  assert.ok(await f.importReference(host, target()));
  assert.equal(f.calls.translate.length, 2);
});

test("a changed host receives no delayed classification", async () => {
  const wait = deferred();
  const f = fixture({ translateWait: wait });
  const host = f.create({ title: "Host" });
  const pending = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/shared" } }),
    [1],
  );
  await new Promise(setImmediate);
  host.fields.title = "Another host paper";
  wait.resolve();
  assert.equal(await pending, null);
  assert.equal(
    [...f.items.values()].some((item) => item.collections.includes(1)),
    false,
  );
});

test("same identity across entry points shares creation and applies both collection intents", async () => {
  const wait = deferred();
  const f = fixture({ translateWait: wait });
  const host = f.create({ title: "Host" });
  const first = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/shared" } }),
    [1],
  );
  const second = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/SHARED" } }),
    [2],
  );
  await new Promise(setImmediate);
  assert.equal(f.calls.translate.length, 1);
  wait.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  assert.deepEqual([...a.collections].sort(), [1, 2]);
});

test("same identifier in different libraries is isolated", async () => {
  const f = fixture();
  const a = await f.importReference(
    f.create({ title: "Host A" }, 1),
    ref({ identifiers: { DOI: "10.5555/shared" } }),
  );
  const b = await f.importReference(
    f.create({ title: "Host B" }, 2),
    ref({ identifiers: { DOI: "10.5555/shared" } }),
  );
  assert.notEqual(a.id, b.id);
  assert.equal(a.libraryID, 1);
  assert.equal(b.libraryID, 2);
});

test("cancelled subscriber does not cancel another caller or apply its collections", async () => {
  const wait = deferred();
  const f = fixture({ translateWait: wait });
  const host = f.create({ title: "Host" });
  let active = true;
  const a = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/shared" } }),
    [1],
    undefined,
    () => active,
  );
  const b = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/shared" } }),
    [2],
  );
  await new Promise(setImmediate);
  active = false;
  wait.resolve();
  const [cancelled, imported] = await Promise.all([a, b]);
  assert.equal(cancelled, null);
  assert.deepEqual([...imported.collections], [2]);
  assert.equal(f.calls.translate.length, 1);
});

for (const operation of ["add", "remove"]) {
  for (const failedSave of [1, 2]) {
    test(`${operation} relation rolls both sides back when save ${failedSave} fails and retry succeeds`, async () => {
      const f = fixture({ failSave: failedSave });
      const a = f.create({ title: "A" });
      const b = f.create({ title: "B" });
      a.relatedItems = [
        "UNRELATED",
        ...(operation === "remove" ? [b.key] : []),
      ];
      b.relatedItems = operation === "remove" ? [a.key] : [];
      for (const item of [a, b]) {
        f.persisted.get(item.id).relations = [...item.relatedItems];
        for (const key of item.relatedItems)
          f.Relations.register("item", item.id, "dc:relation", key);
      }
      const before = globalThis.structuredClone(f.persisted);
      const indexBefore = new Set(f.inverseRelations);
      await assert.rejects(
        f[`${operation}Relation`](a, b),
        /injected save failure/,
      );
      assert.deepEqual(f.persisted, before);
      assert.deepEqual(f.inverseRelations, indexBefore);
      assert.deepEqual(a.relatedItems, before.get(a.id).relations);
      assert.deepEqual(b.relatedItems, before.get(b.id).relations);
      f.clearFailure();
      await f[`${operation}Relation`](a, b);
      assert.equal(f.isRelated(a, b), operation === "add");
      assert.equal(a.relatedItems.includes("UNRELATED"), true);
      assert.equal(
        f.persisted.get(a.id).relations.includes(b.key),
        operation === "add",
      );
      assert.equal(
        f.persisted.get(b.id).relations.includes(a.key),
        operation === "add",
      );
      assert.equal(
        f.inverseRelations.has(f.relationKey(a.id, "dc:relation", b.key)),
        operation === "add",
      );
      assert.equal(
        f.inverseRelations.has(f.relationKey(b.id, "dc:relation", a.key)),
        operation === "add",
      );
    });
  }
}

test("half relation is repaired instead of being mistaken for success", async () => {
  const f = fixture();
  const a = f.create({ title: "A" });
  const b = f.create({ title: "B" });
  a.relatedItems.push(b.key);
  assert.equal(f.isRelated(a, b), false);
  await f.addRelation(a, b);
  assert.equal(f.isRelated(a, b), true);
  assert.deepEqual(f.persisted.get(b.id).relations, [a.key]);
});

test("queued relation rejects an endpoint edited before its write starts", async () => {
  const f = fixture();
  const a = f.create({ title: "A" });
  const b = f.create({ title: "B" });
  const pending = f.addRelation(a, b);
  a.fields.title = "A different paper";
  await assert.rejects(pending, /retain their identities/);
  assert.deepEqual(a.relatedItems, []);
  assert.deepEqual(b.relatedItems, []);
  assert.equal(f.calls.saves, 0);
});

test("all pending aliases are checked before a conflicting DOI/PMID bridge can join", async () => {
  const wait = deferred();
  const f = fixture({ translateWait: wait });
  const host = f.create({ title: "Host" });
  const a = f.importReference(host, ref({ identifiers: { DOI: "10.5555/a" } }));
  const b = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/b", PMID: "12345678" } }),
  );
  const bridge = f.importReference(
    host,
    ref({ identifiers: { DOI: "10.5555/a", PMID: "12345678" } }),
  );
  await assert.rejects(bridge, /Conflicting identifiers/);
  const bAgain = f.importReference(
    host,
    ref({ identifiers: { PMID: "12345678" } }),
  );
  wait.resolve();
  const results = await Promise.all([a, b, bAgain]);
  assert.equal(results[1].id, results[2].id);
  assert.notEqual(results[0].id, results[1].id);
  assert.equal(f.calls.translate.length, 2);
});

test("rollback preserves unsaved relation intent without registering it as persisted", async () => {
  const f = fixture({ failSave: 2 });
  const a = f.create({ title: "A" });
  const b = f.create({ title: "B" });
  a.relatedItems.push("UNSAVED");
  await assert.rejects(f.addRelation(a, b), /injected save failure/);
  assert.deepEqual(a.relatedItems, ["UNSAVED"]);
  assert.deepEqual(f.persisted.get(a.id).relations, []);
  assert.equal(f.inverseRelations.size, 0);
  f.clearFailure();
  await f.addRelation(a, b);
  assert.equal(
    f.inverseRelations.has(f.relationKey(a.id, "dc:relation", "UNSAVED")),
    true,
  );
  assert.equal(
    f.inverseRelations.has(f.relationKey(a.id, "dc:relation", b.key)),
    true,
  );
});

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`, error);
  }
}
console.log(
  `${tests.length - failed}/${tests.length} identity/import regressions passed`,
);
if (failed) process.exitCode = 1;
