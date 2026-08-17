# Refs

**References, citations, related papers and a citation graph for every Zotero item.**

A ground-up rebuild of [zotero-reference](https://github.com/MuiseDestiny/zotero-reference) for **Zotero 7 / 8 / 9**, implementing its full feature set on modern official APIs, plus new capabilities.

[English] | [中文说明](#中文说明)

## Features

### References panel (library + PDF reader)

- Parse the bibliography straight from the **PDF text layer** (column detection, header/footer removal, cross-page merging, thesis mode with `Ctrl+Refresh` parsing backwards from the current page) — or fetch it from **web APIs**: Crossref → Semantic Scholar → OpenAlex → CNKI (Chinese)
- Refresh: click to fetch, click again to toggle PDF ↔ API, **long-press** to bypass the cache
- Per-row: click to **copy**, long-press to **edit**, `Ctrl+click` to **locate in library / open in browser**, `+` to **import & bidirectionally relate** (`Ctrl+click +` picks the target collection), `−` to unlink
- Solid rows are in your library, dimmed rows are not; keyword filter box; double-click the count to copy all
- **Import All** (respects the active filter) and one-click export (plain text / `Ctrl` Markdown / `Shift` CSV)
- Per-item persistent cache

### Hover card

Hover any reference for title / venue / authors / abstract fetched from several sources at once — the dots at the top switch source (your choice per identifier type is remembered). Chips link to DOI / arXiv / PMID / CNKI / open-access PDF. Text selectable, `Ctrl+wheel` zoom, `Ctrl+click` translation (with Translate for Zotero installed), dark-mode aware.

### In-PDF citation links

Built on Zotero 7+'s native reader overlay pipeline: hovering an in-text citation shows the Refs card in place of the native preview; clicking an in-text link (figure / equation / citation) jumps in a **split view** so the primary view never loses your reading position (outline and back-button navigation untouched).

### Cited By · Related · Citation Graph

- **Cited By** — paged list of works citing the item (Semantic Scholar / OpenAlex, source-pinned paging with dedupe)
- **Related Papers** — Semantic Scholar recommendations with OpenAlex fallback, merged with your Zotero related items
- **Citation Graph** — a Connected-Papers-style force graph built from OpenAlex references + citations + related works with co-citation edges; solid nodes are in your library; click to select, double-click to open

### Engineering

Request de-duplication, per-host rate limiting, retry with backoff, TTL-bounded cache, one-pass library index for O(1) in-library matching, chunked rendering, exception-proof hooks (a plugin error can never take down Zotero's item pane).

## Install

Download `refs.xpi` from [Releases](https://github.com/yimmy23/zotero-refs/releases), then in Zotero: `Tools → Plugins → ⚙ → Install Plugin From File…`. Supports Zotero 7–9.

## Build & develop

```bash
npm install
npm run build   # production xpi in .scaffold/build/
npm start       # hot-reload development in an isolated Zotero profile (.env)
```

## License

**AGPL-3.0-or-later.** The PDF-parsing heuristics and feature design are ported from [zotero-reference](https://github.com/MuiseDestiny/zotero-reference) (AGPL-3.0); derivative works must remain AGPL — which also matches Zotero itself and the plugin ecosystem (zotero-plugin-template, Translate for Zotero, Better BibTeX are all AGPL). The full source is open in this repository.

## Credits

- Feature design & PDF parser heuristics: [MuiseDestiny/zotero-reference](https://github.com/MuiseDestiny/zotero-reference)
- Tooling: [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) · [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) · [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)
- Data: Crossref, OpenAlex, Semantic Scholar, arXiv, PubMed, Unpaywall, CNKI, ReadPaper, Connected Papers

---

## 中文说明

**Refs——为每个 Zotero 条目提供参考文献、被引、相关文献与引文图谱。**

[zotero-reference](https://github.com/MuiseDestiny/zotero-reference) 的 Zotero 7/8/9 全功能重构版：

- **参考文献面板**（文库 + 阅读器）：PDF 文本层解析（分栏、页眉页脚去除、跨页合并、`Ctrl+刷新` 学位论文模式）或 API 获取（Crossref → Semantic Scholar → OpenAlex → 知网）；行内复制/长按编辑/`Ctrl+单击` 定位或打开/`+` 导入并双向关联/`−` 取消；实心行=已入库；关键词筛选；批量导入；导出（文本/Markdown/CSV）；本地缓存
- **悬浮卡片**：多源并发元数据，圆点切换数据源并记忆偏好；DOI/arXiv/PMID/知网/OA-PDF 标签；`Ctrl+滚轮` 缩放、`Ctrl+单击` 翻译；适配深色模式
- **阅读器引文链接**：接入 Zotero 原生 overlay 管线——悬停正文引文显示 Refs 卡片；点击跳转链接在分栏中打开、主视图不动
- **被引用**（分页、锁源去重）· **相关文献**（S2 推荐 + OpenAlex 兜底）· **引文图谱**（OpenAlex 数据 + 共被引边力导向图，实心节点=已入库）

**协议**：AGPL-3.0-or-later——PDF 解析核心移植自 AGPL 的 zotero-reference，衍生作品依法必须保持 AGPL；这与 Zotero 本体及插件生态（官方模板、Translate for Zotero、Better BibTeX）一致。本仓库完整开源。
