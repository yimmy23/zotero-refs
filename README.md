# References for Zotero

A ground-up rebuild of [zotero-reference](https://github.com/MuiseDestiny/zotero-reference) for **Zotero 7**, implementing its full feature set on modern APIs, plus new capabilities.

[English] | [中文说明](#中文说明)

## Features

### Everything from zotero-reference, rebuilt

- **References panel** (item pane section, works in both the library and the PDF reader)
  - Parse the bibliography straight from the **PDF text layer** (column detection, header/footer removal, cross-page merging, thesis mode with `Ctrl+Refresh` parsing backwards from the current page)
  - Or fetch it from **web APIs**: Crossref → Semantic Scholar → OpenAlex → CNKI (Chinese)
  - Click **Refresh** to fetch; click again to toggle PDF ↔ API; **long-press** to bypass the local cache
  - Per-row actions: click to **copy**, long-press to **edit**, `Ctrl+click` to **locate in library / open in browser**, `+` to **import & bidirectionally relate** (with `Ctrl+click +` collection picker), `−` to unlink
  - Rows dim when the reference is not in your library; type icons follow the matched item
  - **Search box** filters rows by keywords; double-click the count label to copy everything
  - Per-item persistent cache of parsed/fetched references
- **Hover popup card** — hover a reference to get title / venue / authors / abstract from several sources at once, with the little **source dots** to switch source (choice remembered per identifier type). Tags for DOI / arXiv / PMID / CNKI / OA-PDF links, citation counts. Text selectable, `Ctrl+wheel` zoom, `Ctrl+click` translation (via Translate for Zotero), dark-mode aware.
- **PDF reader citation links** — click an in-text link (Fig/Eq/citation) to jump in a **split view** instead of losing your place; hover an in-text citation to see the reference card. Split view toolbar buttons included.
- **Related papers** — recommendations via the official Semantic Scholar recommendations API with OpenAlex fallback (the original readcube/connectedpapers endpoints are dead), merged with your Zotero related items.

### New

- **Cited By section** — paged list of works citing the current item (Semantic Scholar / OpenAlex)
- **Citation Graph section** — a Connected-Papers-style force graph built from OpenAlex references + citations + related works with co-citation edges; in-library items highlighted; click to select, double-click to open
- **Import All** — batch import (respects the current filter) with progress
- **Export** — copy the list as plain text, Markdown (with links), or CSV
- **PubMed + OpenAlex + Unpaywall** as first-class metadata sources (PMID support, open-access PDF links)
- **Performance**: request de-duplication, per-host rate limiting, retry with backoff, TTL cache, one-pass library index for O(1) in-library matching, chunked list rendering

## Install

Download the `.xpi` from Releases (or build it, below), then in Zotero: `Tools → Plugins → ⚙ → Install Plugin From File…`

## Build

```bash
npm install
npm run build        # produces .scaffold/build/*.xpi
npm start            # development: launches Zotero with the plugin loaded
```

## Preferences

`Settings → References`: auto-fetch, preferred source, PDF scan depth, caching, popup timing/translation, reader link behavior, related/citations/graph toggles, polite-pool email, Semantic Scholar API key, CNKI 研学 account (only needed for CNKI reference lists).

## Credits

- Feature design and PDF-parsing heuristics ported from [MuiseDestiny/zotero-reference](https://github.com/MuiseDestiny/zotero-reference) (AGPL-3.0)
- Built on [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template), [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit), [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)
- Data: Crossref, OpenAlex, Semantic Scholar, arXiv, PubMed, Unpaywall, CNKI, ReadPaper, Connected Papers

License: AGPL-3.0-or-later

---

## 中文说明

[zotero-reference](https://github.com/MuiseDestiny/zotero-reference) 的 **Zotero 7 全功能重构版**：

- **参考文献面板**（条目面板 + 阅读器右侧栏）：PDF 文本层解析（分栏识别、页眉页脚去除、跨页合并、`Ctrl+刷新` 学位论文模式）或 API 获取（Crossref → Semantic Scholar → OpenAlex → 知网）；单击刷新、再次单击切换 PDF/API、长按忽略缓存；行内操作：单击复制、长按编辑、`Ctrl+单击` 定位/打开、`+` 导入并双向关联（`Ctrl+单击+` 选择分类）、`−` 取消关联；关键词筛选；双击数字复制全部；本地缓存。
- **悬浮卡片**：多源并发获取标题/期刊/作者/摘要，顶部圆点切换数据源并记忆偏好；DOI/arXiv/PMID/知网/OA-PDF 标签；`Ctrl+滚轮` 缩放、`Ctrl+单击` 翻译（需 Translate for Zotero）；适配深色模式。
- **阅读器引文链接**：正文跳转链接在**分栏**中打开不丢失阅读位置；悬停正文引文显示参考文献卡片；工具栏分栏按钮。
- **相关文献**：官方 Semantic Scholar 推荐 API + OpenAlex 兜底（原 readcube/connectedpapers 接口已失效），并合并 Zotero 已有关联条目。

**新增**：被引用列表（分页）、引文图谱（OpenAlex 数据 + 共被引边的力导向图）、批量导入、导出（文本/Markdown/CSV）、PubMed/OpenAlex/Unpaywall 数据源、请求去重/限速/重试/缓存、O(1) 文库匹配索引。
