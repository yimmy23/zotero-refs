import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/ui/citationText.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { formatCitationText, isEnglishGBCitation } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

const cases = [
  [
    "reported English citation uses readable GB-style display tokens",
    "LI F, YE Q, ZHANG Y, et al． Simulation research on jamming effect of helicopter airborne infrared decoy ［ C ］ / / The Eighth Symposium on Novel Photoelectronic Detection Technology and Applications． ［ S． l． ］ : SPIE, 2022 : 1284-1293．",
    "LI F, YE Q, ZHANG Y, et al. Simulation research on jamming effect of helicopter airborne infrared decoy [C]// The Eighth Symposium on Novel Photoelectronic Detection Technology and Applications. [S.l.]: SPIE, 2022: 1284-1293.",
  ],
  [
    "recognized online type mark gets the same separator",
    "Smith A. A useful dataset ［ C / OL ］ / / Data Archive． ［ s. n. ］ : 2024 : 12- 18．",
    "Smith A. A useful dataset [C/OL]// Data Archive. [s.n.]: 2024: 12- 18.",
  ],
  [
    "English fullwidth separators retain Latin word boundaries",
    "Smith A， Brown B； Example paper ［ J ］． Journal， 2024： 12-18．",
    "Smith A, Brown B; Example paper [J]. Journal, 2024: 12-18.",
  ],
  [
    "protected bracket content does not reset established citation context",
    "Alpha A． Study ［ J ］． [cohort A] Journal． 2024 : 1-2．",
    "Alpha A. Study [J]. [cohort A] Journal. 2024: 1-2.",
  ],
  [
    "Chinese citation display remains compatible",
    "李 四．中 文 使用方 法［ J ］．示 例 期 刊，2015，44 ( 2 ) : 419- 427．",
    "李四．中文使用方法[J]．示例期刊，2015，44(2):419-427．",
  ],
];

for (const [name, raw, expected] of cases) {
  test(name, () => {
    const sourceSnapshot = raw;
    assert.equal(formatCitationText(raw), expected);
    assert.equal(formatCitationText(expected), expected, "idempotent output");
    assert.equal(raw, sourceSnapshot, "source fixture remains unchanged");
  });
}

test("recognized placeholders are compacted while wrong placeholders remain literal", () => {
  assert.equal(
    formatCitationText("A title ［ J ］． ［ S． l． ］ : SPIE, 2022 : 1-2．"),
    "A title [J]. [S.l.]: SPIE, 2022: 1-2.",
  );
  assert.equal(
    formatCitationText(
      "A title ［ J ］． ［ s. n. ］ : Publisher, 2022 : 1-2．",
    ),
    "A title [J]. [s.n.]: Publisher, 2022: 1-2.",
  );
  const wrong = "A title ［ S． L． ］ : Publisher";
  assert.equal(formatCitationText(wrong), wrong);
});

test("equation-like type mark separator stays unchanged", () => {
  const equation = "Let [C] / / x = y;";
  assert.equal(formatCitationText(equation), equation);
});

test("literal C labels in title-like prose stay unchanged", () => {
  const prose = "Effect of vitamin [C] / / placebo response in 2024．";
  assert.equal(isEnglishGBCitation(prose), false);
  assert.equal(formatCitationText(prose), prose);
});

test("English GB formatting preserves decimal full stops", () => {
  const raw =
    "Smith A． Trial result ［ J ］． P = 0．05； Journal， 2024： 12-18．";
  const expected =
    "Smith A. Trial result [J]. P = 0．05; Journal, 2024: 12-18.";
  assert.equal(isEnglishGBCitation(raw), true);
  assert.equal(formatCitationText(raw), expected);
  assert.equal(formatCitationText(expected), expected);
});

test("protected URLs and unknown brackets retain surrounding spaces", () => {
  const raw =
    "Smith A． Study ［ J ］． Available https://example.test/a．b [cohort A]． Journal， 2024： 1-2．";
  const expected =
    "Smith A. Study [J]. Available https://example.test/a．b [cohort A]. Journal, 2024: 1-2.";
  assert.equal(formatCitationText(raw), expected);
  assert.equal(formatCitationText(expected), expected);
  assert.ok(expected.includes("Available https://"));
  assert.ok(expected.includes("a．b [cohort A]. Journal"));
});

test("concise author-title citations establish English GB context", () => {
  const raw = "MANNA A． Compact jammers [C] / / IEEE Conference．";
  const expected = "MANNA A. Compact jammers [C]// IEEE Conference.";
  assert.equal(isEnglishGBCitation(raw), true);
  assert.equal(formatCitationText(raw), expected);
  assert.equal(formatCitationText(expected), expected);
});

test("arbitrary spaced placeholder stays unchanged", () => {
  const prose = "See [ S． l． ] in prose.";
  assert.equal(formatCitationText(prose), prose);
});

test("unknown brackets and protected URL/DOI payloads are byte-preserved", () => {
  const raw =
    "Lead ［ 中 文 ABC ］ [ XYZ ] https://example.test/Ａ（中）?x=1，2 DOI 10.5555/Ａ（中）．x Tail";
  const formatted = formatCitationText(raw);
  assert.equal(formatted, raw);
  assert.equal(
    formatted.match(/［ 中 文 ABC ］|\[ XYZ \]/g)?.join("|"),
    "［ 中 文 ABC ］|[ XYZ ]",
  );
  assert.match(formatted, /https:\/\/example\.test\/Ａ（中）\?x=1，2/);
  assert.match(formatted, /10\.5555\/Ａ（中）．x/);
});

test("statistical notation is unchanged and no digits or hyphens are invented", () => {
  const statistics = "P = 0.05; HR 0.5 (95% CI 0.3–0.8); n = 2024, 12: 20";
  assert.equal(formatCitationText(statistics), statistics);

  const raw = "Study 2022 : 1284-1293．";
  const displayed = formatCitationText(raw);
  assert.equal(displayed.replace(/\D/g, ""), raw.replace(/\D/g, ""));
  assert.equal(displayed.match(/[0-9-]+/g)?.join("|"), "2022|1284-1293");

  const missingRange = "Study 2022 : 1284．";
  const shownMissingRange = formatCitationText(missingRange);
  assert.equal(shownMissingRange.includes("-"), false);
  assert.equal(
    shownMissingRange.replace(/\D/g, ""),
    missingRange.replace(/\D/g, ""),
  );
});

test("formatting is idempotent across the complete fixture set", () => {
  for (const [, raw, expected] of cases) {
    assert.equal(formatCitationText(formatCitationText(raw)), expected);
  }
});
