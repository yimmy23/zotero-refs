import assert from "node:assert/strict";
import console from "node:console";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const compiled = await build({
  entryPoints: [path.join(root, "src/core/text.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { parseRefText } = await import(
  `data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`
);
let passed = 0;
function test(name, input, expected) {
  const result = parseRefText(input);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(
      result[key],
      value,
      `${name}: ${key}\n${JSON.stringify(result)}`,
    );
  }
  passed++;
  console.log(`✓ ${name}`);
}

test(
  "A prose ending without a publication venue is not a journal",
  "Smith AB. Treatment effects. Implications for cancer. 2024.",
  { title: "Smith AB. Treatment effects. Implications for cancer. 2024." },
);
test(
  "A four-digit issue number does not replace the publication year",
  "Smith AB. Treatment effects. Journal of Medicine. 2024;20(2020):100.",
  { title: "Treatment effects", year: "2024" },
);

// The first two citations reproduce reported real-world field-boundary bugs.
// All other names/publications below are deterministic synthetic examples.
test(
  "Vancouver title precedes abbreviated venue; DOI year does not win",
  "Casal-Mouriño A, Ruano-Ravina A, Lorenzo-González M, et al. Epidemiology of stage III lung cancer: frequency, diagnostic characteristics, and survival. Transl Lung Cancer Res. 2021 Jan;10(1):506-518. doi:10.21037/tlcr.2020.03.40.",
  {
    title:
      "Epidemiology of stage III lung cancer: frequency, diagnostic characteristics, and survival",
    authors: ["Casal-Mouriño A", "Ruano-Ravina A", "Lorenzo-González M et al."],
    year: "2021",
    publicationVenue: "Transl Lung Cancer Res",
  },
);
test(
  "Comma-separated Robins citation",
  "Robins et al., 1986, A new approach to causal inference in mortality studies with a sustained exposure period—application to control of the healthy worker survivor effect., Math Model, 7, 1393",
  {
    title:
      "A new approach to causal inference in mortality studies with a sustained exposure period—application to control of the healthy worker survivor effect",
    authors: ["Robins et al."],
    year: "1986",
    publicationVenue: "Math Model",
  },
);
test(
  "A long journal cannot outrank a short title",
  "Smith AB, Jones CD. A short title. Journal of Important Medical Research. 2024;12:20–30.",
  {
    title: "A short title",
    authors: ["Smith AB", "Jones CD"],
    year: "2024",
    publicationVenue: "Journal of Important Medical Research",
  },
);
test(
  "APA initials retain author boundaries without date punctuation",
  "Brown, A. B., & Jones, C. D. (2023). Treatment effects: a randomized study. Journal of Clinical Research, 12(3), 20–30.",
  {
    title: "Treatment effects: a randomized study",
    authors: ["Brown A. B", "Jones C. D"],
    year: "2023",
    publicationVenue: "Journal of Clinical Research",
  },
);
test(
  "GB/T journal marker supports Chinese titles",
  "[12] 张三, 李四, 等. 肺癌围术期治疗的研究进展[J]. 中华肿瘤杂志, 2024, 46(2): 100-108.",
  {
    title: "肺癌围术期治疗的研究进展",
    authors: ["张三", "李四 et al."],
    year: "2024",
    publicationVenue: "中华肿瘤杂志",
  },
);
test(
  "Chinese citation needs no spaces",
  "12.张三,李四.肺癌治疗的研究进展[J].中华肿瘤杂志,2024,46(2):100-108.",
  {
    title: "肺癌治疗的研究进展",
    authors: ["张三", "李四"],
    year: "2024",
    publicationVenue: "中华肿瘤杂志",
  },
);
test(
  "Multiple title sentences remain together",
  "Smith AB, Jones CD. Treatment has changed. What next? Journal of Clinical Research. 2024;12:20–30.",
  {
    title: "Treatment has changed. What next?",
    publicationVenue: "Journal of Clinical Research",
    year: "2024",
  },
);
test(
  "Dotted journal initials remain part of venue",
  "Smith AB. Treatment effects. N. Engl. J. Med. 2024;12:20–30.",
  {
    title: "Treatment effects",
    publicationVenue: "N. Engl. J. Med",
    year: "2024",
  },
);
test(
  "Quoted full title supports embedded punctuation",
  "Smith AB, Jones CD. “Treatment, follow-up, and survival.” Journal of Clinical Research. 2024;12:20–30.",
  {
    title: "Treatment, follow-up, and survival",
    publicationVenue: "Journal of Clinical Research",
    year: "2024",
  },
);
test(
  "Internal quoted phrases are not extracted as full title",
  'Smith AB. The evolving uses of "real-world data" in medicine. Journal of Clinical Research. 2024;12:20–30.',
  {
    title: 'The evolving uses of "real-world data" in medicine',
    year: "2024",
  },
);
test(
  "Publication year at the end is recognized",
  "Smith AB. Treatment effects. Journal of Clinical Research 12:20–30 (2023).",
  {
    title: "Treatment effects",
    publicationVenue: "Journal of Clinical Research",
    year: "2023",
  },
);
test(
  "A title's historical year is retained",
  "Smith AB. How treatment changed after 1986. Journal of Clinical Research. 2024;12:20–30.",
  {
    title: "How treatment changed after 1986",
    year: "2024",
    publicationVenue: "Journal of Clinical Research",
  },
);
test(
  "DOI-only year is not a publication year",
  "Smith AB. Treatment effects. Journal of Clinical Research 12:20–30. doi:10.5555/2020.12345",
  {
    title: "Treatment effects",
    year: undefined,
  },
);
test(
  "Old publication years remain supported",
  "Smith AB. Treatment effects. Journal of Clinical Research. 1875;12:20–30.",
  {
    title: "Treatment effects",
    year: "1875",
  },
);
test(
  "Unicode surnames and particles remain intact",
  "García-López AB, van der Meer CD, O’Neill EF. Treatment effects. Journal of Clinical Research. 2024;12:20–30.",
  {
    title: "Treatment effects",
    authors: ["García-López AB", "van der Meer CD", "O’Neill EF"],
  },
);
test(
  "Initials-first author format",
  "A. B. Smith, C. D. Jones. Treatment effects. Journal of Clinical Research. 2024;12:20–30.",
  {
    title: "Treatment effects",
    authors: ["A. B. Smith", "C. D. Jones"],
  },
);
test(
  "Opening quoted phrase followed by prose remains in the full title",
  'Smith AB. "Real-world data" in medicine. Journal of Clinical Research. 2024;12:20–30.',
  { title: '"Real-world data" in medicine', year: "2024" },
);
test(
  "Quoted title with external comma is supported",
  'Smith AB. "Treatment effects", Journal of Clinical Research. 2024;12:20–30.',
  {
    title: "Treatment effects",
    year: "2024",
    publicationVenue: "Journal of Clinical Research",
  },
);
// Bibliographic strings below reproduce failures observed in the authorized
// local ten-PDF check. No PDFs, library keys, or local paths are included.
test(
  "Historical colon-delimited authors retain a multi-sentence title",
  "Peto R, Pike MC, Armitage NE, et al: Design and analysis of randomized clinical trials requiring prolonged observation of each patient. Part II. Analysis and examples. Br J Cancer 35:139, 1977",
  {
    title:
      "Design and analysis of randomized clinical trials requiring prolonged observation of each patient. Part II. Analysis and examples",
    authors: ["Peto R", "Pike MC", "Armitage NE et al."],
    year: "1977",
    publicationVenue: "Br J Cancer",
  },
);
test(
  "Nature-style spaced initials never split off their second initial",
  "Travis, W. D., Brambilla, E. & Riely, G. J. New pathologic classification of lung cancer: relevance for clinical practice and clinical trials. J. Clin. Oncol. 31 , 992–1001 (2013).",
  {
    title:
      "New pathologic classification of lung cancer: relevance for clinical practice and clinical trials",
    authors: ["Travis W. D", "Brambilla E", "Riely G. J"],
    year: "2013",
    publicationVenue: "J. Clin. Oncol",
  },
);
test(
  "Four-digit page ranges are not publication years",
  "Akhtar-Danseh, G. G., Akhtar-Danesh, N. & Finley, C. Uptake and survival effects of minimally invasive surgery for lung cancer: a population-based study. Eur. J. Surg. Oncol. 47 , 1791–1796 (2021).",
  {
    title:
      "Uptake and survival effects of minimally invasive surgery for lung cancer: a population-based study",
    year: "2021",
    publicationVenue: "Eur. J. Surg. Oncol",
  },
);
test(
  "The complete abbreviated journal remains outside the title",
  "Bucknell, N. W. et al. Avoiding toxicity with lung radiation therapy: an IASLC perspective. J. Thorac. Oncol. 17 , 961–973 (2022).",
  {
    title:
      "Avoiding toxicity with lung radiation therapy: an IASLC perspective",
    publicationVenue: "J. Thorac. Oncol",
  },
);
test(
  "A title year does not mask APA volume-page metadata",
  "Siegel, R.L., Miller, K.D., Wagle, N.S., and Jemal, A. (2023). Cancer statistics, 2023. CA Cancer J. Clin. 73 , 17–48. https://doi.org/10.3322/ caac.21763.",
  {
    title: "Cancer statistics, 2023",
    authors: ["Siegel R.L", "Miller K.D", "Wagle N.S", "Jemal A"],
    year: "2023",
    publicationVenue: "CA Cancer J. Clin",
  },
);
test(
  "An explicit research-team author may precede named APA authors",
  "National Lung Screening Trial Research Team, Aberle, D.R., Adams, A.M., Berg, C.D., Black, W.C., Clapp, J.D., Fagerstrom, R.M., Gareen, I.F., Gatsonis, C., Marcus, P.M., and Sicks, J.D. (2011). Reduced lung-cancer mortality with low-dose computed tomographic screening. N. Engl. J. Med. 365 , 395–409. https://doi.org/10.1056/NEJMoa1102873.",
  {
    title:
      "Reduced lung-cancer mortality with low-dose computed tomographic screening",
    year: "2011",
    publicationVenue: "N. Engl. J. Med",
  },
);
test(
  "An ordinary title word matching an abbreviation remains in the title",
  "Schurch, C.M., Bhate, S.S., Barlow, G.L., Phillips, D.J., Noti, L., Zlobec, I., Chu, P., Black, S., Demeter, J., McIlwain, D.R., et al. (2020). Coordinated Cellular Neighborhoods Orchestrate Antitumoral Immunity at the Colorectal Cancer Invasive Front. Cell 183 , 838. https://doi.org/10.1016/ j.cell.2020.10.021.",
  {
    title:
      "Coordinated Cellular Neighborhoods Orchestrate Antitumoral Immunity at the Colorectal Cancer Invasive Front",
    year: "2020",
    publicationVenue: "Cell",
  },
);
test(
  "An ordinal name suffix does not invalidate the author segment",
  "Hao, Y., Hao, S., Andersen-Nissen, E., Mauck, W.M., 3rd, Zheng, S., Butler, A., Lee, M.J., Wilk, A.J., Darby, C., Zager, M., et al. (2021). Integrated analysis of multimodal single-cell data. Cell 184 , 3573–3587. e29. https://doi.org/10.1016/j.cell.2021.04.048.",
  {
    title: "Integrated analysis of multimodal single-cell data",
    year: "2021",
    publicationVenue: "Cell",
  },
);
test(
  "PDF-spaced GB/T type markers and et al. are normalized",
  "Chen W , Zheng R , Baade PD , et al . Cancer statistics in China , 2015 [ J ]. CA Cancer J Clin , 2016 , 66 ( 2 ): 115 ‐ 132 . DOI : 10 . 3322 /caac . 21338 .",
  {
    title: "Cancer statistics in China, 2015",
    authors: ["Chen W", "Zheng R", "Baade PD et al."],
    year: "2016",
    publicationVenue: "CA Cancer J Clin",
  },
);
test(
  "PDF spacing between Han characters is removed from title and venue",
  "黄焰 , 张莉萍 , 侯立坤 , 等 . 非小细胞肺癌新辅助治疗后手术 切 除 标 本 的 病 理 评 估 [ J ]. 中 华 病 理 学 杂 志 , 2021 , 50 ( 7 ): 773 ‐ 778 . DOI : 10 . 3760 /cma . j . cn 112151 ‐ 20201224 ‐ 00962 .",
  {
    title: "非小细胞肺癌新辅助治疗后手术切除标本的病理评估",
    authors: ["黄焰", "张莉萍", "侯立坤 et al."],
    year: "2021",
    publicationVenue: "中华病理学杂志",
  },
);
test(
  "Unicode hyphens are valid inside an author surname",
  "Reck M , Rodríguez‐Abreu D , Robinson AG , et al . Pembrolizumab versus chemotherapy for PD‐L 1 ‐positive non‐small‐cell lung cancer [ J ]. N Engl J Med , 2016 , 375 ( 19 ): 1823 ‐ 1833 . DOI : 10 . 1056 /NEJMoa 1606774 .",
  {
    title:
      "Pembrolizumab versus chemotherapy for PD‐L 1 ‐positive non‐small‐cell lung cancer",
    authors: ["Reck M", "Rodríguez‐Abreu D", "Robinson AG et al."],
    year: "2016",
  },
);
test(
  "An explicit publication year after a DOI URL is preserved",
  "Díaz-Gay, M. et al. The mutagenic forces shaping the genomic landscape of lung cancer in never smokers. Preprint at medRxiv https://doi.org/10.1101/2024.05.15.24307318 (2024).",
  {
    title:
      "The mutagenic forces shaping the genomic landscape of lung cancer in never smokers",
    year: "2024",
    publicationVenue: "medRxiv",
  },
);
test(
  "Supplement page prefixes still locate the journal boundary",
  "Mao, L. Molecular abnormalities in lung carcinogenesis and their potential clinical implications. Lung Cancer 34 , S27–S34 (2001).",
  {
    title:
      "Molecular abnormalities in lung carcinogenesis and their potential clinical implications",
    year: "2001",
    publicationVenue: "Lung Cancer",
  },
);
test(
  "A title ending in a group letter still ends before the journal",
  "Vokes, E. E. et al. Induction chemotherapy followed by chemoradiotherapy compared with chemoradiotherapy alone for regionally advanced unresectable stage III Non-small-cell lung cancer: Cancer and Leukemia Group B. J. Clin. Oncol. 25 , 1698–1704 (2007).",
  {
    title:
      "Induction chemotherapy followed by chemoradiotherapy compared with chemoradiotherapy alone for regionally advanced unresectable stage III Non-small-cell lung cancer: Cancer and Leukemia Group B",
    year: "2007",
    publicationVenue: "J. Clin. Oncol",
  },
);
for (const raw of [
  "2024. What we learned about treatment",
  "A short title. A much longer and rather important journal name. 2024.",
  "Treatment works. Patients improved. The study began in 2024.",
  "Smith AB. Treatment effects.",
  "Smith AB. Treatment effects. doi:10.5555/2020.12345",
  "A scientific report discussing 2024 and 2025 without citation boundaries",
]) {
  test(`Ambiguous input stays intact: ${raw.slice(0, 28)}`, raw, {
    title: raw,
    authors: undefined,
    publicationVenue: undefined,
    year: undefined,
  });
}
console.log(`\n${passed} raw-citation regression tests passed.`);
