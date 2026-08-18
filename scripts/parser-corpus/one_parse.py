import json, urllib.request, sys
import os
S=os.environ.get('CORPUS_DIR','.corpus')
sel=json.load(open(f'{S}/pdf_sample.json'))
i=int(sys.argv[1]); e=sel[i]
show=int(sys.argv[2]) if len(sys.argv)>2 else 6
code = r'''
const win = Zotero.getMainWindow();
Zotero.Debug.setStore(true);
const item = new Zotero.Item("journalArticle"); item.setField("title", "[parser-test] %s"); await item.saveTx();
const att = await Zotero.Attachments.importFromFile({ file: %s, parentItemID: item.id });
await Zotero.Reader.open(att.id);
let reader = null;
for (let w = 0; w < 40 && !reader; w++) { await new Promise((r) => win.setTimeout(r, 500)); reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID); if (reader && reader.itemID !== att.id) reader = null; }
await reader._initPromise; await new Promise((r) => win.setTimeout(r, 2500));
const mark = "MARK-" + Date.now();
Zotero.debug(mark);
const refs = await dev.parsePDFReferences(reader, {});
const log = await Zotero.Debug.get();
const after = log.split(mark).pop() || "";
const lines = after.split("\n").filter((l) => /pdfparser/.test(l)).map((l) => l.replace(/^\(\d\)\(\+\d+\): /, "").slice(0, 220));
win.Zotero_Tabs.close(win.Zotero_Tabs.selectedID);
return JSON.stringify({ n: refs.length, lines, sample: refs.slice(0, %d).map((r) => `[${r.number}|p${r.page}] ` + (r.text||"").slice(0, 110)), tail: refs.slice(-3).map((r) => `[${r.number}|p${r.page}] ` + (r.text||"").slice(0, 110)) });
''' % (e['title'][:60].replace('"','\\"'), json.dumps(e['scratch']), show)
req = urllib.request.Request("http://127.0.0.1:%s/refs-dev/eval" % __import__("os").environ.get("ZPORT","23124"), json.dumps({'token':'refs-dev-7f3fa390','code':code}).encode(), {'Content-Type':'application/json'})
r = json.loads(urllib.request.urlopen(req, timeout=600).read().decode())
if not r.get('ok'): print("ERR", r); sys.exit(1)
res=json.loads(r['result'])
print(f"== {i} {e['journal']} truth={e.get('crossref_refs')} parsed={res['n']}")
print('\n'.join(res['lines']))
print('--- sample'); print('\n'.join(res['sample'])); print('--- tail'); print('\n'.join(res['tail']))

