import json, urllib.request, sys, time
import os
S=os.environ.get('CORPUS_DIR','.corpus')
sel=json.load(open(f'{S}/pdf_sample.json'))
start=int(sys.argv[1]); end=int(sys.argv[2])
batch=[{'i':i,'pdf':sel[i]['scratch'],'title':sel[i]['title'][:80]} for i in range(start,min(end,len(sel)))]
code = r'''
const win = Zotero.getMainWindow();
const batch = %s;
const out = [];
for (const b of batch) {
  const rec = { i: b.i };
  try {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "[parser-test] " + b.title);
    await item.saveTx();
    const att = await Zotero.Attachments.importFromFile({ file: b.pdf, parentItemID: item.id });
    await Zotero.Reader.open(att.id);
    let reader = null;
    for (let w = 0; w < 40 && !reader; w++) { await new Promise((r) => win.setTimeout(r, 500)); reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID); if (reader && reader.itemID !== att.id) reader = null; }
    if (!reader) { rec.err = "no reader"; out.push(rec); continue; }
    await reader._initPromise;
    await new Promise((r) => win.setTimeout(r, 2500));
    const t0 = Date.now();
    const refs = await dev.parsePDFReferences(reader, {});
    rec.ms = Date.now() - t0;
    rec.n = refs.length;
    rec.numbers = refs.map((r) => r.number);
    rec.pages = [...new Set(refs.map((r) => r.page))];
    rec.first = (refs[0]?.text || "").slice(0, 100);
    rec.last = (refs[refs.length - 1]?.text || "").slice(0, 100);
    rec.mid = (refs[Math.floor(refs.length / 2)]?.text || "").slice(0, 100);
    rec.avgLen = refs.length ? Math.round(refs.reduce((a, r) => a + (r.text || "").length, 0) / refs.length) : 0;
    rec.withDOI = refs.filter((r) => r.identifiers?.DOI).length;
    win.Zotero_Tabs.close(win.Zotero_Tabs.selectedID);
    await new Promise((r) => win.setTimeout(r, 400));
  } catch (e) { rec.err = String(e).slice(0, 200); }
  out.push(rec);
}
return JSON.stringify(out);
''' % json.dumps(batch, ensure_ascii=False)
req = urllib.request.Request("http://127.0.0.1:%s/refs-dev/eval" % __import__("os").environ.get("ZPORT","23124"), json.dumps({'token':'refs-dev-7f3fa390','code':code}).encode(), {'Content-Type':'application/json'})
r = json.loads(urllib.request.urlopen(req, timeout=900).read().decode())
if not r.get('ok'):
    print("ERR", r); sys.exit(1)
res = json.loads(r['result'])
prev = json.load(open(f'{S}/parse_results.json')) if start>0 else {}
for rec in res:
    e=sel[rec['i']]
    rec['journal']=e['journal']; rec['truth']=e.get('crossref_refs')
    prev[str(rec['i'])]=rec
    flag = "" if rec.get('n')==rec.get('truth') else ("  <-- MISMATCH" if rec.get('truth') else "")
    print(f"{rec['i']:02d} {e['journal'][:30]:30} parsed={rec.get('n')} truth={rec.get('truth')} pages={rec.get('pages')} ms={rec.get('ms')} err={rec.get('err','')}{flag}")
json.dump(prev,open(f'{S}/parse_results.json','w'),ensure_ascii=False,indent=1)

