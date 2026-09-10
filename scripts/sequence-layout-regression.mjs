/** Deterministic geometry checks; no PDF, network, profile, or decoder dependency. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { buildSync } from "esbuild";

const bundle = buildSync({
  entryPoints: ["src/pdf/sequenceLayout.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
}).outputFiles[0].text;
const { buildSequenceLines, sourceFragments } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle).toString("base64")
);
const item = (str, x, y, width = 200, height = 10) => ({
  str,
  width,
  height,
  transform: [height, 0, 0, height, x, y],
});
const page = (items, extra = {}) => ({
  page: 0,
  width: 600,
  height: 800,
  items,
  ...extra,
});
const rows = (prefix, x, ys, width) =>
  ys.map((y, i) => item(`${prefix}${i + 1}`, x, y, width));
const parse = (p) => buildSequenceLines([p]);
const texts = (p) => parse(p).lines.map((l) => l.text);
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

test("offset baselines retain local column reading order", () => {
  const p = page([
    ...rows("L", 40, [700, 680, 660], 230),
    ...rows("R", 320, [690, 670, 650], 230),
  ]);
  assert.deepEqual(texts(p), ["L1", "L2", "L3", "R1", "R2", "R3"]);
});

test("narrow gutter beats the smaller label-to-author indent", () => {
  const runs = [];
  for (let i = 0; i < 8; i++) {
    const y = 700 - i * 14;
    runs.push(
      item(`Left${i}`, 60, y, 228, 8.8),
      item(`[${i + 1}]`, 306, y + 0.4, 18, 8.8),
      item(`Author${i}`, 331, y, 225, 8.8),
    );
  }
  const result = parse(page(runs));
  assert.equal(result.lines.length, 16);
  assert(
    result.lines
      .slice(0, 8)
      .every((line) => line.column === 0 && line.text.startsWith("Left")),
  );
  assert(
    result.lines
      .slice(8)
      .every((line) => line.column === 1 && /^\[\d\] Author/.test(line.text)),
  );
});

test("ordinary word gaps opposed by body ink do not form an extra column", () => {
  const runs = [];
  for (let i = 0; i < 20; i++) {
    const y = 700 - i * 12;
    if (i % 4 === 0)
      runs.push(
        item("First words", 50, y, 100),
        item("rest of the same line", 158, y, 390),
      );
    else runs.push(item(`Complete line ${i}`, 50, y, 498));
  }
  const result = parse(page(runs));
  assert.equal(result.lines.length, 20);
  assert(result.lines.every((line) => line.column === 0));
});

test("detached digits join brackets despite an opposite-column baseline shift", () => {
  const runs = [];
  for (let i = 0; i < 7; i++) {
    const y = 700 - i * 14,
      h = 7.278;
    runs.push(
      item("[", 14.4, y + 1.164, 7.278, h),
      item(String(i + 1), 16.6, y, 7.278, h),
      item("]", 22.36, y + 1.164, 7.278, h),
      item(`Left author ${i}`, 34.5, y + 0.97, 210, h),
    );
    runs.push(
      item(`[${i + 8}]`, 261.46, y + 3.396, 18, h),
      item(`Right author ${i}`, 283.5, y + 2.232, 210, h),
    );
  }
  const result = parse(page(runs, { width: 502 }));
  assert.equal(result.lines.length, 14);
  assert(
    result.lines
      .slice(0, 7)
      .every((line, i) => line.text.startsWith(`[${i + 1}]`)),
  );
  assert(
    result.lines
      .slice(7)
      .every((line, i) => line.text.startsWith(`[${i + 8}]`)),
  );
});

test("full-width sections separate local two-column and three-column layouts", () => {
  const p = page([
    ...rows("A", 40, [740, 726, 712], 240),
    ...rows("B", 320, [740, 726, 712], 240),
    item("Whole-width introduction", 40, 670, 520),
    ...rows("C", 40, [620, 606, 592], 155),
    ...rows("D", 222, [620, 606, 592], 155),
    ...rows("E", 405, [620, 606, 592], 155),
    item("Before", 40, 550, 100),
    item("Across the middle", 155, 550, 250),
    item("After", 410, 550, 150),
  ]);
  assert.deepEqual(texts(p), [
    "A1",
    "A2",
    "A3",
    "B1",
    "B2",
    "B3",
    "Whole-width introduction",
    "C1",
    "C2",
    "C3",
    "D1",
    "D2",
    "D3",
    "E1",
    "E2",
    "E3",
    "Before Across the middle After",
  ]);
});

test("a complete crossing paragraph line keeps both side fragments", () => {
  const p = page([
    ...rows("L", 40, [740, 726, 712], 230),
    ...rows("R", 330, [740, 726, 712], 230),
    item("Prefix", 40, 698, 160),
    item("crossing", 205, 698, 190),
    item("suffix", 400, 698, 160),
    ...rows("X", 40, [684, 670, 656], 230),
    ...rows("Y", 330, [684, 670, 656], 230),
  ]);
  assert.deepEqual(texts(p), [
    "L1",
    "L2",
    "L3",
    "R1",
    "R2",
    "R3",
    "Prefix crossing suffix",
    "X1",
    "X2",
    "X3",
    "Y1",
    "Y2",
    "Y3",
  ]);
});

test("blank paragraph bands do not restart unchanged columns", () => {
  const p = page([
    ...rows("L", 40, [740, 726, 712, 650, 636, 622], 230),
    ...rows("R", 330, [740, 726, 712, 650, 636, 622], 230),
  ]);
  assert.deepEqual(texts(p), [
    ...Array.from({ length: 6 }, (_, i) => `L${i + 1}`),
    ...Array.from({ length: 6 }, (_, i) => `R${i + 1}`),
  ]);
});

test("changed column width cannot inherit a cut through the next section's text", () => {
  const p = page([
    ...rows("A", 50, [740, 726, 712], 235),
    ...rows("B", 315, [740, 726, 712], 235),
    ...rows("C", 50, [640, 626, 612], 254),
    ...rows("D", 334, [640, 626, 612], 220),
  ]);
  assert.deepEqual(texts(p), [
    "A1",
    "A2",
    "A3",
    "B1",
    "B2",
    "B3",
    "C1",
    "C2",
    "C3",
    "D1",
    "D2",
    "D3",
  ]);
});

test("double-spaced columns remain column-major", () => {
  const p = page([
    ...rows("L", 40, [740, 712, 684, 656], 230),
    ...rows("R", 330, [740, 712, 684, 656], 230),
  ]);
  assert.deepEqual(texts(p), ["L1", "L2", "L3", "L4", "R1", "R2", "R3", "R4"]);
});

test("source runs stay immutable and every retained run belongs to one line", () => {
  const p = page([
    item("", 0, 0, 0),
    item("吉", 90, 600, 10),
    item("王  ", 50, 600, 30),
    item("Tail", 50, 580, 200),
  ]);
  const before = JSON.stringify(p);
  p.items.forEach((run) => {
    Object.freeze(run.transform);
    Object.freeze(run);
  });
  Object.freeze(p.items);
  Object.freeze(p);
  const result = parse(p);
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(
    result.lines[0].spans.map((s) => s.item),
    [2, 1],
  );
  assert.deepEqual(sourceFragments([p], result.lines[0].spans), ["王  ", "吉"]);
  assert.deepEqual(
    result.lines.flatMap((line) => line.spans.map((s) => s.item)).sort(),
    [1, 2, 3],
  );
});

test("long glyph-level lines have short unique identifiers and complete spans", () => {
  const p = page(
    Array.from({ length: 3000 }, (_, i) => item("字", 10 + i, 600, 1)),
    { width: 3020 },
  );
  const result = parse(p);
  assert.equal(result.lines.length, 1);
  assert(result.lines[0].id.length < 32);
  assert.equal(result.lines[0].spans.length, 3000);
  assert.equal(
    sourceFragments([p], result.lines[0].spans).join(""),
    "字".repeat(3000),
  );
});

test("zero and nonzero PDF origins retain original anchor coordinates", () => {
  const p = page([item("At zero", 10, 0, 100)]);
  assert.equal(parse(p).lines[0].y, 0);
  const q = page([item("Offset", 140, 600, 200)], { origin: [100, -50] });
  assert.equal(parse(q).lines[0].x, 140);
  assert.equal(parse(q).lines[0].y, 600);
});

test("confirmed repeated copyright and adjacent review footer extend beyond nine percent", () => {
  const pages = [0, 1].map((n) =>
    page(
      [
        item("A named review (Review)", 70, 88, 240, 7),
        item("Copyright © 2010 A Publisher", 70, 79, 300, 7),
        item("Journal 2010;1:20-30.", 70, 105, 150, 7),
        item("Different body publication", 70, 140, 230, 10),
      ],
      { page: n },
    ),
  );
  const result = buildSequenceLines(pages);
  assert(
    result.lines
      .filter((l) => /Copyright|\(Review\)/.test(l.text))
      .every((l) => l.role === "soft-noise"),
  );
  assert(
    result.lines
      .filter((l) => l.text.startsWith("Journal"))
      .every((l) => l.role !== "soft-noise"),
  );
});

test("nonrepeated final copyright is not promoted to a running footer", () => {
  const result = parse(
    page([item("Copyright © 2024 Publisher", 50, 95, 300, 8)]),
  );
  assert.notEqual(result.lines[0].role, "soft-noise");
});

test("many off-page coordinates cannot invent columns or discard original runs", () => {
  const p = page(
    Array.from({ length: 1000 }, (_, i) =>
      item(`Off-page ${i}`, 10000 + i * 160, 600 - (i % 3) * 20, 80),
    ),
    { origin: [100, 0] },
  );
  const result = parse(p);
  assert.equal(result.lines.length, 1000);
  assert(result.lines.every((line) => line.column === 0));
  assert.deepEqual(
    result.lines
      .flatMap((line) => line.spans.map((span) => span.item))
      .sort((a, b) => a - b),
    Array.from({ length: 1000 }, (_, i) => i),
  );
});

test("oversized pages fail with an explicit layout budget diagnostic", () => {
  const p = page(Array.from({ length: 40001 }, () => item("x", 50, 600, 10)));
  const result = parse(p);
  assert.deepEqual(result.lines, []);
  assert(
    result.diagnostics.some((d) => d.code === "layout-page-budget-exceeded"),
  );
});

test("invalid geometry and fractional source spans are explicit failures", () => {
  const p = page([item("Bad", 10, Number.NaN), item("Good", 20, 600)]);
  assert(parse(p).diagnostics.some((d) => d.code === "invalid-run-geometry"));
  assert.throws(() =>
    sourceFragments([p], [{ page: 0, item: 1, start: 0.5, end: 1 }]),
  );
});

console.log(`${passed}/${passed} sequence layout regressions passed`);
