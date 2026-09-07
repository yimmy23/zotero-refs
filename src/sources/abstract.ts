import { normalizeAbstractText } from "../core/abstractText";
import { http } from "../core/http";
import { cleanText, normalizeTitle } from "../core/text";
import type { RefItem } from "../core/types";
import { extractAbstractRecord } from "./pubmed";

// Missing-abstract enrichment, independent of the popup's lifetime. As in Zest,
// exact identifiers are preferred and source failures are never cached as misses.
const MAX_TEXT = 40_000;
const MAX_CACHE = 200;
const POSITIVE_TTL = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL = 5 * 60 * 1000;
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const PUBMED = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const OPTIONS = { noCache: true, timeout: 8000, retries: 0 };

interface Identity {
  key: string;
  doi: string;
  pmid: string;
  title: string;
  queryTitle: string;
  year: string;
  surname: string;
}
interface Outcome {
  ref: RefItem | null;
  missing: boolean;
  pmid?: string;
}
const completed = new Map<string, { ref: RefItem; time: number }>();
const misses = new Map<string, number>();
const pending = new Map<string, Promise<RefItem | null>>();

function requestJSON(url: string, deadline: number): Promise<any> {
  const remaining = deadline - Date.now();
  return remaining > 0
    ? http.getJSON(url, {
        ...OPTIONS,
        timeout: Math.min(OPTIONS.timeout, remaining),
      })
    : Promise.resolve(null);
}

function doiOf(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw
    .trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "")
    .toLowerCase();
  return value.length <= 300 && /^10\.\d{4,9}\/[^\s"<>]+$/.test(value)
    ? value
    : "";
}

function pmidOf(raw: unknown): string {
  return typeof raw === "string" && /^[1-9]\d{0,11}$/.test(raw.trim())
    ? raw.trim()
    : "";
}

function authorKey(raw: unknown): string {
  return typeof raw === "string" ? normalizeTitle(raw).replace(/\s/g, "") : "";
}

function surnameOf(raw: string): string {
  // Local/API author arrays may contain either "Molina JR" or "Julian R. Molina".
  // Title fallback uses a full token match against the source's family name;
  // this is corroboration, never a substitute for an exact long title + year.
  return raw.split(/[,，]/)[0].trim();
}

function identityOf(ref: RefItem): Identity | null {
  const doi = doiOf(ref.identifiers?.DOI);
  const pmid = pmidOf(ref.identifiers?.PMID);
  const title = normalizeTitle(cleanText(ref.title || ""));
  const queryTitle = cleanText(ref.title || "");
  const year = /^\d{4}$/.test(ref.year || "") ? ref.year! : "";
  const surname = surnameOf(ref.authors?.[0] || "");
  const key =
    doi || pmid
      ? `id:${doi}|${pmid}`
      : `title:${title}|${year}|${authorKey(surname)}`;
  return doi || pmid || (title.length >= 25 && year && surname)
    ? { key, doi, pmid, title, queryTitle, year, surname }
    : null;
}

function copy(ref: RefItem): RefItem {
  return {
    ...ref,
    identifiers: { ...ref.identifiers },
    authors: [...ref.authors],
  };
}

function sameIdentifiers(identity: Identity, ref: RefItem): boolean {
  return (
    (!identity.doi || doiOf(ref.identifiers.DOI) === identity.doi) &&
    (!identity.pmid || pmidOf(ref.identifiers.PMID) === identity.pmid)
  );
}

function trimCache<T>(cache: Map<string, T>): void {
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
}

function cached(identity: Identity): RefItem | null {
  const keys = [identity.key];
  if (identity.doi) keys.push(`id:${identity.doi}|`);
  if (identity.pmid) keys.push(`id:|${identity.pmid}`);
  for (const key of keys) {
    const entry = completed.get(key);
    if (!entry) continue;
    if (Date.now() - entry.time > POSITIVE_TTL) {
      completed.delete(key);
      continue;
    }
    if (!sameIdentifiers(identity, entry.ref)) continue;
    completed.delete(key);
    completed.set(key, entry);
    return copy(entry.ref);
  }
  return null;
}

export function cachedAbstract(ref: RefItem): RefItem | null {
  const identity = identityOf(ref);
  return identity ? cached(identity) : null;
}

function abstractText(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > MAX_TEXT * 2) return undefined;
  const text = normalizeAbstractText(raw);
  return text.length >= 40 && text.length <= MAX_TEXT ? text : undefined;
}

function titleMatch(identity: Identity, row: any): boolean {
  if (identity.title.length < 25 || !identity.year || !identity.surname)
    return false;
  const family = cleanText(row.authorList?.author?.[0]?.lastName || "");
  const sourceAuthor = authorKey(family);
  const tokens = identity.surname
    .split(/[\s.]+/)
    .filter(Boolean)
    .map(authorKey);
  return (
    normalizeTitle(cleanText(row.title || "")) === identity.title &&
    String(row.pubYear || "") === identity.year &&
    !!sourceAuthor &&
    (authorKey(identity.surname) === sourceAuthor ||
      tokens.includes(sourceAuthor))
  );
}

function validRow(row: any): boolean {
  return (
    row &&
    typeof row.source === "string" &&
    /^[A-Z]+$/.test(row.source) &&
    typeof row.id === "string" &&
    /^[A-Za-z0-9_-]+$/.test(row.id) &&
    (row.source !== "MED" || !!pmidOf(row.id))
  );
}

function authorsOf(row: any): string[] {
  const authors = row.authorList?.author;
  if (
    !Array.isArray(authors) ||
    !authors.length ||
    /\bet\s+al\.?\s*$/i.test(String(row.authorString || ""))
  )
    return [];
  const names = authors.map((author: any) => {
    if (!author || typeof author !== "object") return "";
    const first =
      typeof author.firstName === "string" ? author.firstName.trim() : "";
    const last =
      typeof author.lastName === "string" ? author.lastName.trim() : "";
    const name = first && last ? `${first} ${last}` : "";
    return cleanText(
      name ||
        (typeof author.fullName === "string" ? author.fullName : "") ||
        (typeof author.collectiveName === "string"
          ? author.collectiveName
          : "") ||
        last ||
        first,
    );
  });
  // Dropping an unnamed/omitted contributor changes the first/last positions.
  // A partial byline must not masquerade as a complete author list.
  return names.every((name) => name && !/^(?:et\s+al\.?|\.{3}|…)/i.test(name))
    ? names
    : [];
}

/** Two DOI registrations can name the same publisher article (e.g. old Mayo
 * DOI and Elsevier DOI). Verify the exact publisher PII in BOTH authoritative
 * Crossref records; matching titles alone never overrides a DOI conflict. */
async function verifiedAlias(
  identity: Identity,
  candidateDOI: string,
  deadline: number,
): Promise<boolean> {
  if (!identity.doi || !candidateDOI) return false;
  const [left, right] = await Promise.all(
    [identity.doi, candidateDOI].map((doi) =>
      requestJSON(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        deadline,
      ),
    ),
  );
  const a = left?.message;
  const b = right?.message;
  if (
    doiOf(a?.DOI) !== identity.doi ||
    doiOf(b?.DOI) !== candidateDOI ||
    !a.publisher ||
    a.publisher !== b.publisher ||
    normalizeTitle(cleanText(a.title?.[0] || "")) !== identity.title ||
    normalizeTitle(cleanText(b.title?.[0] || "")) !== identity.title
  )
    return false;
  const year = (row: any) =>
    String(
      (row["published-print"] || row["published-online"] || row.published)?.[
        "date-parts"
      ]?.[0]?.[0] || "",
    );
  if (year(a) !== identity.year || year(b) !== identity.year) return false;
  const firstAuthor = (row: any) => cleanText(row.author?.[0]?.family || "");
  if (
    !firstAuthor(a) ||
    authorKey(firstAuthor(a)) !== authorKey(firstAuthor(b)) ||
    !titleMatch(identity, {
      title: a.title[0],
      pubYear: year(a),
      authorList: { author: [{ lastName: firstAuthor(a) }] },
    })
  )
    return false;
  const piis = (row: any): string[] =>
    Array.isArray(row.link)
      ? row.link.flatMap((link: any) => {
          if (typeof link?.URL !== "string") return [];
          const match = link.URL.match(
            /^https:\/\/api\.elsevier\.com\/content\/article\/PII:(S\d{16})(?:\?|$)/,
          );
          return match &&
            Array.isArray(row["alternative-id"]) &&
            row["alternative-id"].includes(match[1])
            ? [match[1]]
            : [];
        })
      : [];
  const candidates = new Set(piis(a));
  return piis(b).some((pii) => candidates.has(pii));
}

async function europePMC(
  identity: Identity,
  deadline: number,
  byTitle = false,
): Promise<Outcome> {
  const query = byTitle
    ? `TITLE:"${identity.queryTitle.replace(/["\\]/g, " ")}"`
    : identity.doi
      ? `DOI:"${identity.doi.replace(/\\/g, "\\\\")}"`
      : `EXT_ID:${identity.pmid} AND SRC:MED`;
  const body = await requestJSON(
    `${EPMC}?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=10`,
    deadline,
  );
  const rows = body?.resultList?.result;
  if (
    !Array.isArray(rows) ||
    !Number.isInteger(body.hitCount) ||
    body.hitCount < rows.length
  )
    return { ref: null, missing: false };
  if (!body.hitCount && !rows.length) return { ref: null, missing: true };
  let matches = rows.filter(
    (row: any) =>
      validRow(row) &&
      (!identity.pmid || (row.source === "MED" && row.id === identity.pmid)) &&
      (byTitle
        ? titleMatch(identity, row)
        : !identity.doi || doiOf(row.doi) === identity.doi),
  );
  if (byTitle) {
    // Search truncation or distinct records with the same title are ambiguous.
    if (body.hitCount > rows.length || matches.length !== 1)
      return { ref: null, missing: false };
    const candidateDOI = doiOf(matches[0].doi);
    if (
      identity.doi &&
      candidateDOI !== identity.doi &&
      !(await verifiedAlias(identity, candidateDOI, deadline))
    )
      return { ref: null, missing: false };
  }
  if (!matches.length) return { ref: null, missing: false };
  matches = matches.sort(
    (a: any, b: any) => Number(b.source === "MED") - Number(a.source === "MED"),
  );
  let knownPMID: string | undefined;
  for (const row of matches) {
    const pmid = row.source === "MED" ? pmidOf(row.id) : "";
    if (pmid) knownPMID ||= pmid;
    const text = abstractText(row.abstractText);
    if (!text) continue;
    const doi = identity.doi || doiOf(row.doi);
    return {
      ref: {
        identifiers: {
          ...(doi ? { DOI: doi } : {}),
          ...(pmid ? { PMID: pmid } : {}),
        },
        title: cleanText(row.title || "") || undefined,
        year: /^\d{4}$/.test(String(row.pubYear || ""))
          ? String(row.pubYear)
          : undefined,
        authors: authorsOf(row),
        abstract: text,
        source: "europepmc",
        url: `https://europepmc.org/article/${row.source}/${row.id}`,
      },
      missing: false,
    };
  }
  return {
    ref: null,
    missing: matches.every(
      (row: any) => row.abstractText == null || row.abstractText === "",
    ),
    pmid: knownPMID,
  };
}

async function pubmed(
  identity: Identity,
  deadline: number,
  knownPMID?: string,
): Promise<Outcome> {
  let pmids = identity.pmid || knownPMID ? [identity.pmid || knownPMID!] : [];
  if (!pmids.length && identity.doi) {
    const body = await requestJSON(
      `${PUBMED}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(`"${identity.doi}"[AID]`)}&retmode=json&retmax=3`,
      deadline,
    );
    const ids = body?.esearchresult?.idlist;
    if (!Array.isArray(ids) || !/^\d+$/.test(String(body.esearchresult.count)))
      return { ref: null, missing: false };
    if (!ids.length && String(body.esearchresult.count) === "0")
      return { ref: null, missing: true };
    pmids = ids.filter((id: unknown) => !!pmidOf(id));
    if (pmids.length !== 1 || Number(body.esearchresult.count) !== 1)
      return { ref: null, missing: false };
  }
  if (!pmids.length) return { ref: null, missing: true };
  let allMissing = true;
  for (const pmid of pmids) {
    if (Date.now() >= deadline) return { ref: null, missing: false };
    const raw = await http.getText(
      `${PUBMED}/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`,
      { ...OPTIONS, timeout: Math.min(OPTIONS.timeout, deadline - Date.now()) },
    );
    const ref = raw
      ? extractAbstractRecord(raw, pmid, identity.doi || undefined)
      : null;
    if (!ref) {
      allMissing = false;
      continue;
    }
    if (
      ref.abstract &&
      ref.abstract.length >= 40 &&
      ref.abstract.length <= MAX_TEXT
    )
      return { ref, missing: false };
    if (ref.abstract) allMissing = false;
  }
  return { ref: null, missing: allMissing };
}

async function resolve(identity: Identity): Promise<Outcome> {
  // Stop starting fallbacks after the lookup budget. The HTTP host gate may
  // additionally queue a request; its transport timeout uses the remaining
  // budget and automatic retries are disabled.
  const deadline = Date.now() + 24_000;
  const outcomes: Outcome[] = [];
  if (identity.doi || identity.pmid) {
    const first = await europePMC(identity, deadline);
    if (first.ref) return first;
    outcomes.push(first);
    const fallback = await pubmed(identity, deadline, first.pmid);
    if (fallback.ref) return fallback;
    outcomes.push(fallback);
  }
  if (identity.title.length >= 25 && identity.year && identity.surname) {
    const title = await europePMC(identity, deadline, true);
    if (title.ref) return title;
    outcomes.push(title);
  }
  return {
    ref: null,
    missing:
      outcomes.length > 0 && outcomes.every((outcome) => outcome.missing),
  };
}

export async function fetchAbstract(ref: RefItem): Promise<RefItem | null> {
  const identity = identityOf(ref);
  if (!identity || ref.abstract?.trim()) return null;
  const hit = cached(identity);
  if (hit) return hit;
  // A prior identifier-only miss must not suppress a later title/author match.
  const key = `${identity.key}|${identity.title}|${identity.year}|${authorKey(identity.surname)}`;
  const missed = misses.get(key);
  if (missed && Date.now() - missed < MISS_TTL) return null;
  misses.delete(key);
  let job = pending.get(key);
  if (!job) {
    // Hovering rapidly must not enqueue an unbounded number of network jobs.
    if (pending.size >= 40) return null;
    job = resolve(identity)
      .then((result) => {
        if (result.ref) {
          const entry = { ref: copy(result.ref), time: Date.now() };
          completed.set(identity.key, entry);
          if (result.ref.identifiers.DOI)
            completed.set(`id:${doiOf(result.ref.identifiers.DOI)}|`, entry);
          if (result.ref.identifiers.PMID)
            completed.set(`id:|${pmidOf(result.ref.identifiers.PMID)}`, entry);
          trimCache(completed);
        } else if (result.missing) {
          misses.set(key, Date.now());
          trimCache(misses);
        }
        return result.ref;
      })
      .catch(() => null)
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, job);
  }
  const result = await job;
  return result ? copy(result) : null;
}
