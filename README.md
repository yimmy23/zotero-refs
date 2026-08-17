# Refs

**References, citations, related papers and a citation graph for every Zotero item.**

A ground-up rebuild of [zotero-reference](https://github.com/MuiseDestiny/zotero-reference) for **Zotero 7 / 8 / 9**, implementing its full feature set on modern official APIs, plus new capabilities.

[English](#install) | [中文说明](#中文说明) | [For AI agents](#for-ai-agents)

## Install

Download `refs.xpi` from [Releases](https://github.com/yimmy23/zotero-refs/releases), then in Zotero: `Tools → Plugins → ⚙ → Install Plugin From File…`. Supports Zotero 7–9.

## API keys — what do I need to fill in?

**Nothing is required.** All primary data sources (Crossref, OpenAlex, Semantic Scholar, arXiv, PubMed, Unpaywall) work anonymously out of the box. Three optional settings in `Settings → Refs`:

| Setting | Needed for | Effect |
|---|---|---|
| **Email** | nothing (a default is shipped) | Crossref / OpenAlex / Unpaywall grant faster, more reliable access to requests that carry a contact email (their "polite pool"). Recommended: put your own email. |
| **Semantic Scholar API key** | nothing | higher rate limits for Cited By / Related / hover cards. Free from [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api). |
| **CNKI 研学 account** | only the CNKI *reference list* of Chinese items | search/import of individual Chinese papers works without it. |

## Using the plugin

After install, four collapsible sections appear in the right-hand item pane (library **and** PDF reader): **References**, **Cited By**, **Related**, **Citation Graph**.

### References

The list loads automatically (configurable). The source is shown next to the count — `PDF` means parsed from the PDF text layer, `API` means fetched from Crossref → Semantic Scholar → OpenAlex → CNKI.

- **Refresh button**: click to fetch the current source (the `PDF`/`API` badge switches sources); **long-press** to bypass the cache; `Ctrl+click` in a thesis/book PDF parses backwards from the current page (thesis mode).
- **Per row**: solid = already in your library, dimmed = not. Click to **copy the citation** (clean text, list numbering stripped) · long-press to **edit** the raw text (`Esc` cancels) · `Ctrl+click` to **locate in library / open in browser** · `+` to **import and bidirectionally relate** (`Ctrl+click +` picks the target collection) · `−` to unlink. Every control has a hover tooltip. Works flagged as **retracted** by OpenAlex / PubMed carry a red RETRACTED badge and ask for confirmation before import.
- **Toolbar**: `PDF | API` source switch · keyword filter box · Import All (respects the filter; asks for confirmation, click the progress window to stop midway) · export list (click = plain text, `Ctrl` = Markdown, `Shift` = CSV) · double-click the count to copy the whole list.

### Hover card

Hover any row for title / venue / authors / abstract, fetched from several sources at once — the dots at the top switch source (hover a dot for its name; your per-identifier choice is remembered). Chips link to **DOI / arXiv / PMID / CNKI / open-access PDF**, plus **Scholar** and **PubMed** title-search links for any reference. Text is selectable; `Ctrl+wheel` zooms; `Ctrl+click` translates (with Translate for Zotero installed).

### In-PDF citation links

In the reader, hovering an in-text citation shows the Refs card instead of the native preview; clicking an in-text link (citation / figure / equation) jumps in a **split view**, so your reading position never moves. Split direction is configurable; outline and back-button navigation are untouched.

Items are looked up by DOI, or — when there is none — by PMID / arXiv id from the Extra field or URL, so PubMed-imported items work throughout.

### Cited By · Related · Citation Graph

- **Cited By** — paged list of works citing this item (Semantic Scholar / OpenAlex; paging is source-pinned and deduplicated) with a keyword filter over the loaded rows.
- **Related** — Semantic Scholar recommendations (OpenAlex fallback), merged with your Zotero related items.
- **Citation Graph** — a Connected-Papers-style force graph built from OpenAlex references + citations + related works with co-citation edges. Node size = citation count; **solid = in your library**; click to select, double-click to open. Legend on top; Rebuild button refetches.

### Settings overview

`Settings → Refs`: auto-refresh & priority source (PDF/API), item types excluded from auto-refresh, PDF pre-parse page count, per-item caching of PDF/API results and cache TTL, hover-card delay/behavior/translation, reader link behavior (hover card, click-to-jump, split direction), Cited By page size, graph max nodes, dimming opacity for not-in-library rows, network identity (email / S2 key), CNKI account.

## Build & develop

```bash
npm install
npm run build   # production xpi in .scaffold/build/
npm start       # hot-reload development in an isolated Zotero profile (.env)
```

Copy `.env.example` to `.env` and set your Zotero binary path first. `npm start` runs an **isolated** profile — it never touches your working Zotero.

## For AI agents

Architecture, invariants, and verified gotchas (Fluent l10n rules, hook guarding, matching strictness, dev-loop debugging) are documented in [AGENTS.md](AGENTS.md). Read it before modifying this codebase.

## License

**AGPL-3.0-or-later.** The PDF-parsing heuristics and feature design are ported from [zotero-reference](https://github.com/MuiseDestiny/zotero-reference) (AGPL-3.0); derivative works must remain AGPL — which also matches Zotero itself and the plugin ecosystem (zotero-plugin-template, Translate for Zotero, Better BibTeX are all AGPL). The full source is open in this repository.

## Credits

- Feature design & PDF parser heuristics: [MuiseDestiny/zotero-reference](https://github.com/MuiseDestiny/zotero-reference)
- Tooling: [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) · [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) · [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)
- Data: Crossref, OpenAlex, Semantic Scholar, arXiv, PubMed, Unpaywall, CNKI, ReadPaper, Connected Papers

---

## 中文说明

**Refs——为每个 Zotero 条目提供参考文献、被引、相关文献与引文图谱。** 支持 Zotero 7–9。

### 安装

从 [Releases](https://github.com/yimmy23/zotero-refs/releases) 下载 `refs.xpi`，在 Zotero 中 `工具 → 插件 → ⚙ → Install Plugin From File…` 安装。

### 需要填写哪些 API？

**一个都不必填。** 所有主数据源（Crossref、OpenAlex、Semantic Scholar、arXiv、PubMed、Unpaywall）均免密钥匿名可用。`设置 → Refs` 里有三项可选：

- **Email**——默认值已内置；Crossref / OpenAlex / Unpaywall 对附带联系邮箱的请求给予更快、更稳定的配额，建议填自己的邮箱。
- **Semantic Scholar API key**——免费申请，仅用于放宽被引/相关/悬浮卡片的限流，不填也能用。
- **知网研学账号**——只有获取中文文献的「知网参考文献列表」才需要；单篇中文文献的检索与导入不依赖它。

### 使用方法

安装后，右侧条目面板（文库和 PDF 阅读器中均有）出现四个折叠区：**参考文献**、**被引用**、**相关文献**、**引文图谱**。

**参考文献**：自动加载，计数旁标注来源（`PDF` = 从 PDF 文本层解析；`API` = Crossref → Semantic Scholar → OpenAlex → 知网）。刷新按钮：单击获取当前数据源（点 `PDF`/`API` 徽章切换来源），**长按**跳过缓存，学位论文中 `Ctrl+单击` 从当前页向前解析。行内操作：实心行=已入库、半透明=未入库；单击**复制干净引文**（自动去掉序号）；长按**编辑**原文（`Esc` 取消）；`Ctrl+单击` 在文库定位或浏览器打开；`+` **导入并双向关联**（`Ctrl+单击 +` 选择目标分类）；`−` 取消关联；所有控件悬停均有提示。被 OpenAlex / PubMed 标记**撤稿**的文献显示红色「已撤稿」标签，导入前会再次确认。工具栏：`PDF | API` 数据源开关、关键词筛选、批量导入（遵循筛选；执行前确认，中途点击进度窗口即可停止）、导出（单击=纯文本，`Ctrl`=Markdown，`Shift`=CSV）、双击计数复制全部。条目按 DOI 查询，无 DOI 时用 Extra/URL 中的 PMID 或 arXiv 号，PubMed 导入的条目同样可用。

**悬浮卡片**：悬停任意行，多源并发获取标题/期刊/作者/摘要，顶部圆点切换数据源并按标识符类型记忆偏好。标签可点击跳转 **DOI / arXiv / PMID / 知网 / OA-PDF**，并对每条文献提供 **Scholar**（Google Scholar 检索）与 **PubMed**（标题检索）链接。文本可选中，`Ctrl+滚轮` 缩放，装有 Translate for Zotero 时 `Ctrl+单击` 翻译。

**阅读器引文链接**：悬停正文引文显示 Refs 卡片（替代原生预览）；点击正文跳转链接（引文/图/公式）在**分栏**中打开，主视图阅读位置不动，分栏方向可设置。

**被引用**（分页加载，锁源去重，可关键词筛选）·**相关文献**（S2 推荐 + OpenAlex 兜底，合并 Zotero 关联条目）·**引文图谱**（OpenAlex 数据 + 共被引边的力导向图：节点大小=被引量，实心=已入库，单击选中，双击打开）。

### 协议

AGPL-3.0-or-later——PDF 解析核心移植自 AGPL 的 zotero-reference，衍生作品依法必须保持 AGPL；这与 Zotero 本体及插件生态（官方模板、Translate for Zotero、Better BibTeX）一致。本仓库完整开源。
