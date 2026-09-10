/** Offline same-byte A/B runner. Results describe differences, not correctness. */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import console from "node:console";
import process from "node:process";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const help = `Usage: node scripts/sequence-benchmark.mjs --manifest FILE --out-dir NEW_DIRECTORY [--from-page N]

Manifest: [{"key":"sample","path":"/absolute/or/manifest-relative.pdf","sha256":"optional"}]
Each PDF runs in a fresh child process with a 60-second total deadline. Both engines
open the same verified bytes independently; text/annotation results are cloned.
Writes frozen bundles, source hashes, old-summary.json, new-summary.json,
comparison.json, per-engine outputs, and one raw-page artifact per PDF.
Existing output directories are refused. No metadata APIs or PDF uploads.
Timing is observational: OS caches and process scheduling are uncontrolled.
`;

function options(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const allowed = new Set(["--manifest", "--out-dir", "--from-page"]);
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1] || values.has(argv[i]))
      throw new Error(`Invalid or repeated option: ${argv[i]}`);
    values.set(argv[i], argv[i + 1]);
  }
  if (!values.has("--manifest") || !values.has("--out-dir"))
    throw new Error("--manifest and --out-dir are required; use --help");
  const fromPage = values.has("--from-page")
    ? Number(values.get("--from-page"))
    : undefined;
  if (
    fromPage !== undefined &&
    (!Number.isSafeInteger(fromPage) || fromPage < 1)
  )
    throw new Error("--from-page must be a positive physical page number");
  return {
    manifest: path.resolve(values.get("--manifest")),
    outDir: path.resolve(values.get("--out-dir")),
    fromPage,
  };
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
async function fileHash(file) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
}
const writeJSON = (file, value) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
async function updateJSON(file, value) {
  const temporary = `${file}.next`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(temporary, file);
}

async function freezeBundle(engine, entry, outDir) {
  const output = path.join(outDir, `${engine}.bundle.mjs`);
  const loadedHashes = new Map();
  const stubs = {
    prefs:
      "export function getPref(){return 4;} export function getNumPref(){return 4;}",
    locale: "export function getString(key){return String(key);}",
  };
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "offline-stubs",
        setup(builder) {
          builder.onResolve(
            { filter: /(?:^|\/)utils\/(prefs|locale)$/ },
            (args) => ({
              path: args.path.endsWith("prefs") ? "prefs" : "locale",
              namespace: "offline-stub",
            }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "offline-stub" },
            (args) => ({ contents: stubs[args.path], loader: "js" }),
          );
          builder.onLoad(
            { filter: /\.(?:[cm]?[jt]sx?|json)$/, namespace: "file" },
            async (args) => {
              const contents = await fs.readFile(args.path);
              loadedHashes.set(args.path, hash(contents));
              const extension = path.extname(args.path).slice(1);
              const loader = ["json", "ts", "tsx", "jsx"].includes(extension)
                ? extension
                : "js";
              return { contents, loader };
            },
          );
        },
      },
    ],
  });
  const sources = [];
  for (const input of Object.keys(result.metafile.inputs).sort()) {
    const virtual = input.startsWith("offline-stub:");
    sources.push({
      path: input,
      sha256: virtual
        ? hash(stubs[input.slice("offline-stub:".length)])
        : loadedHashes.get(path.resolve(root, input)),
    });
    if (!sources.at(-1).sha256)
      throw new Error(`Missing frozen input hash: ${input}`);
  }
  return {
    entry: path.relative(root, entry),
    bundle: output,
    bundleSHA256: await fileHash(output),
    sources,
  };
}

async function runWorker(worker, jobFile, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=2048", worker, jobFile],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let timedOut = false;
    const collect = (chunk) => {
      if (output.length < 256_000)
        output += String(chunk).slice(0, 256_000 - output.length);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timer);
      try {
        await fs.writeFile(logFile, output, { flag: "wx" });
        resolve({ exitCode, signal, timedOut });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function compare(old, newer) {
  const normalize = (value) =>
    String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/gu, "")
      .trim();
  const differences = [];
  for (
    let i = 0;
    i < Math.max(old.refs?.length ?? 0, newer.refs?.length ?? 0);
    i++
  ) {
    const a = old.refs?.[i],
      b = newer.refs?.[i];
    const anchor = (ref) =>
      ref ? { page: ref.page, x: ref.x, y: ref.y } : null;
    const row = {
      index: i,
      oldNumber: a?.number ?? null,
      newNumber: b?.number ?? null,
      missingOld: !a,
      missingNew: !b,
      textChanged: (a?.text ?? "") !== (b?.text ?? ""),
      normalizedTextChanged: normalize(a?.text) !== normalize(b?.text),
      anchorChanged: JSON.stringify(anchor(a)) !== JSON.stringify(anchor(b)),
    };
    if (
      row.missingOld ||
      row.missingNew ||
      row.textChanged ||
      row.anchorChanged ||
      row.oldNumber !== row.newNumber
    )
      differences.push(row);
  }
  return {
    oldCount: old.count ?? 0,
    newCount: newer.count ?? 0,
    countDelta: (newer.count ?? 0) - (old.count ?? 0),
    positionalNumberChanges: differences.filter(
      (row) => row.oldNumber !== row.newNumber,
    ).length,
    positionalTextChanges: differences.filter((row) => row.textChanged).length,
    positionalNormalizedTextChanges: differences.filter(
      (row) => row.normalizedTextChanged,
    ).length,
    positionalAnchorChanges: differences.filter((row) => row.anchorChanged)
      .length,
    differences,
  };
}

async function main() {
  const args = options(process.argv.slice(2));
  if (!args) {
    console.log(help);
    return;
  }
  try {
    await fs.lstat(args.outDir);
    throw new Error("Output directory already exists; choose a new directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const manifestBytes = await fs.readFile(args.manifest);
  const manifest = JSON.parse(manifestBytes);
  if (!Array.isArray(manifest) || !manifest.length || manifest.length > 10_000)
    throw new Error("Manifest must contain 1–10000 records");
  const keys = new Set();
  const records = [];
  for (const item of manifest) {
    if (
      !item ||
      typeof item.key !== "string" ||
      !item.key.length ||
      item.key.length > 512 ||
      keys.has(item.key) ||
      typeof item.path !== "string"
    )
      throw new Error("Every record needs a unique nonempty key and PDF path");
    keys.add(item.key);
    const sourcePath = await fs.realpath(
      path.resolve(path.dirname(args.manifest), item.path),
    );
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile() || stat.size > 512 * 1024 * 1024)
      throw new Error(`Invalid or over-budget PDF: ${item.key}`);
    const sourcePDFSHA256 = await fileHash(sourcePath);
    if (
      item.sha256 !== undefined &&
      (typeof item.sha256 !== "string" ||
        item.sha256.toLowerCase() !== sourcePDFSHA256)
    )
      throw new Error(`PDF SHA256 mismatch: ${item.key}`);
    records.push({
      key: item.key,
      path: sourcePath,
      sourcePDFSHA256,
      bytes: stat.size,
    });
  }
  const pdfjsPackage = fileURLToPath(
    import.meta.resolve("pdfjs-benchmark/package.json"),
  );
  const pdfjsRoot = path.dirname(pdfjsPackage);
  const pdfjsVersion = JSON.parse(
    await fs.readFile(pdfjsPackage, "utf8"),
  ).version;
  await fs.mkdir(path.dirname(args.outDir), { recursive: true });
  await fs.mkdir(args.outDir); // Exclusive creation is intentional, including races.
  const worker = path.join(args.outDir, "worker.mjs");
  const workerSource = fileURLToPath(
    new URL("sequence-benchmark-worker.mjs", import.meta.url),
  );
  await fs.copyFile(workerSource, worker);
  const oldVersion = await freezeBundle(
    "old",
    path.join(root, "src/pdf/parser.ts"),
    args.outDir,
  );
  const newVersion = await freezeBundle(
    "new",
    path.join(root, "src/pdf/sequenceReader.ts"),
    args.outDir,
  );
  let gitHEAD;
  try {
    gitHEAD = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    gitHEAD = null;
  }
  const config = {
    schema: 1,
    createdAt: new Date().toISOString(),
    node: process.version,
    pdfjsVersion,
    gitHEAD,
    fromPage: args.fromPage ?? null,
    timeoutMs: 60_000,
    manifestSHA256: hash(manifestBytes),
    harnessSHA256: await fileHash(fileURLToPath(import.meta.url)),
    workerSHA256: await fileHash(worker),
    old: oldVersion,
    new: newVersion,
    records,
    timingNote:
      "One child per PDF; two independent documents from identical bytes. OS caches and scheduling are uncontrolled. Measurements are not a correctness or speedup claim.",
  };
  await writeJSON(path.join(args.outDir, "config.json"), config);
  const summaries = Object.fromEntries(
    ["old", "new"].map((engine) => [
      engine,
      {
        schema: 1,
        engine,
        completed: false,
        total: records.length,
        processed: 0,
        startedAt: config.createdAt,
        sourceVersion: config[engine],
        timingNote: config.timingNote,
        results: [],
      },
    ]),
  );
  const comparisons = {
    schema: 1,
    completed: false,
    note: "Position-aligned differences only; insertions shift subsequent positions. Neither continuity nor changed counts establishes correctness. Legacy numbers may be generated; new numbers are source labels.",
    results: [],
  };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const directory = path.join(
      args.outDir,
      `${String(i + 1).padStart(4, "0")}-${hash(record.key).slice(0, 10)}`,
    );
    await fs.mkdir(directory);
    const job = {
      ...record,
      directory,
      fromPage: args.fromPage ?? null,
      old: oldVersion,
      new: newVersion,
      pdfjsRoot,
      pdfjsVersion,
      domModule: import.meta.resolve("@xmldom/xmldom"),
    };
    const jobFile = path.join(directory, "job.json");
    await writeJSON(jobFile, job);
    const workerStatus = await runWorker(
      worker,
      jobFile,
      path.join(directory, "worker.log"),
    );
    const executionIssues = [];
    if (workerStatus.timedOut) executionIssues.push("worker-timeout");
    else if (workerStatus.exitCode !== 0 || workerStatus.signal)
      executionIssues.push("worker-exit-failed");
    let rawPageSHA256;
    try {
      const bytes = await fs.readFile(path.join(directory, "pages.json"));
      const raw = JSON.parse(bytes.toString("utf8"));
      if (
        raw.sourcePDFSHA256 !== record.sourcePDFSHA256 ||
        !Array.isArray(raw.pages) ||
        raw.capturedPages !== raw.pages.length ||
        raw.complete !==
          (raw.documentPages > 0 && raw.pages.length === raw.documentPages) ||
        new Set(raw.pages.map((p) => p.page)).size !== raw.pages.length ||
        raw.pages.some(
          (p) =>
            !Number.isInteger(p.page) ||
            p.page < 0 ||
            p.page >= raw.documentPages,
        )
      )
        throw new Error("raw-page-identity-or-coverage-mismatch");
      rawPageSHA256 = hash(bytes);
    } catch {
      executionIssues.push("raw-page-artifact-unavailable-or-invalid");
    }
    const outputs = {};
    for (const engine of ["old", "new"]) {
      const rawOutput = path.join(directory, `${engine}.json`);
      try {
        outputs[engine] = JSON.parse(await fs.readFile(rawOutput, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        outputs[engine] = {
          schema: 1,
          key: record.key,
          path: record.path,
          sourcePDFSHA256: record.sourcePDFSHA256,
          status: workerStatus.timedOut ? "timeout" : "worker-error",
          count: 0,
          pages: null,
          refs: [],
          workerStatus,
        };
        await writeJSON(rawOutput, outputs[engine]);
      }
      const data = outputs[engine];
      data.parserStatus = data.status;
      data.executionIssues = [...executionIssues];
      if (data.destroyError)
        data.executionIssues.push("document-cleanup-failed");
      if (data.sourcePDFSHA256 !== record.sourcePDFSHA256)
        data.executionIssues.push("engine-source-identity-mismatch");
      if (data.networkRequestsBlocked)
        data.executionIssues.push("network-attempt-blocked");
      if (data.executionIssues.length)
        data.status = workerStatus.timedOut ? "timeout" : "execution-error";
      data.rawOutput = rawOutput;
      data.rawPageSHA256 = rawPageSHA256;
      data.workerStatus = workerStatus;
      const output = path.join(directory, `validated-${engine}.json`);
      await writeJSON(output, data);
      summaries[engine].results.push({
        ...record,
        output,
        status: data.status,
        pages: data.pages,
        count: data.count,
        extractionStatus: data.extraction?.status,
        diagnosticCodes: [
          ...new Set(
            data.extraction?.diagnostics?.map((item) => item.code) ?? [],
          ),
        ],
        loadMs: data.loadMs,
        parseMs: data.parseMs,
        reads: data.reads,
        workerStatus,
        executionIssues: data.executionIssues,
        rawPageSHA256,
      });
      summaries[engine].processed++;
    }
    comparisons.results.push({
      key: record.key,
      sourcePDFSHA256: record.sourcePDFSHA256,
      oldStatus: outputs.old.status,
      newStatus: outputs.new.status,
      newExtractionStatus: outputs.new.extraction?.status,
      ...compare(outputs.old, outputs.new),
    });
    for (const engine of ["old", "new"])
      await updateJSON(
        path.join(args.outDir, `${engine}-summary.json`),
        summaries[engine],
      );
    await updateJSON(path.join(args.outDir, "comparison.json"), comparisons);
    console.log(
      `${i + 1}/${records.length} ${record.key}: ${outputs.old.count} -> ${outputs.new.count} (${outputs.old.status}/${outputs.new.status}; extraction=${outputs.new.extraction?.status ?? "unavailable"}; diagnostics=${[...new Set(outputs.new.extraction?.diagnostics?.map((item) => item.code) ?? [])].join(",") || "none"})`,
    );
  }
  for (const engine of ["old", "new"]) {
    summaries[engine].completed = true;
    summaries[engine].completedAt = new Date().toISOString();
    await updateJSON(
      path.join(args.outDir, `${engine}-summary.json`),
      summaries[engine],
    );
  }
  comparisons.completed = true;
  await updateJSON(path.join(args.outDir, "comparison.json"), comparisons);
  console.log(`Completed ${records.length} PDFs; outputs: ${args.outDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
