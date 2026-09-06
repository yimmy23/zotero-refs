# Refs

**References, citations, related papers and a citation graph for every Zotero item.**

A ground-up rebuild of [zotero-reference](https://github.com/MuiseDestiny/zotero-reference) for **Zotero 7–10**, implementing its full feature set on modern official APIs, plus new capabilities.

[English](#install) | [中文说明](#中文说明) | [For AI agents](#for-ai-agents)

## Install

Download `refs.xpi` from [Releases](https://github.com/yimmy23/zotero-refs/releases), then in Zotero: `Tools → Plugins → ⚙ → Install Plugin From File…`. Supports Zotero 7–10; the 1.1.0 interface was tested on 10.0.1, with earlier releases tested on 9.0.6 and 10.0. Later versions arrive through Zotero's built-in plugin updater (`Tools → Plugins → ⚙ → Check for Updates`, or automatically).

## API keys — what do I need to fill in?

**Nothing is required.** All primary data sources (Crossref, OpenAlex, Semantic Scholar, arXiv, PubMed, Unpaywall) work anonymously out of the box. Optional settings in `Settings → Refs`:

| Setting                      | Needed for                                      | Effect                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Email**                    | nothing (a default is shipped)                  | Crossref uses it for its polite pool; Unpaywall requires a contact email. Recommended: put your own email. OpenAlex ignores the historical mailto parameter. |
| **Semantic Scholar API key** | nothing                                         | higher rate limits for Cited By / Related / hover cards. Free from [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api).           |
| **OpenAlex API key**         | nothing for basic queries                       | optional; increases the budget for graph and batch requests. Sent in an Authorization header, not a URL.                                                     |
| **CNKI 研学 account**        | only the CNKI _reference list_ of Chinese items | search/import of individual Chinese papers works without it.                                                                                                 |

## Using the plugin

After install, four collapsible sections appear in the right-hand item pane (library **and** PDF reader): **References**, **Cited By**, **Related**, **Citation Graph**.

### References

The list loads automatically (configurable) and is a single **fused** view: the PDF text layer provides the skeleton — the exact entries the paper prints, their order, numbering and in-page positions — and web APIs (Crossref → Semantic Scholar → OpenAlex → CNKI) fill in what the text lacks, above all the DOI (historical 699-paper corpus: DOI coverage rose from ~19% to ~80%; this is not a current accuracy estimate). Whichever side is unavailable (no open PDF, no identifiers, offline), the other alone still renders; the sources that contributed are named next to the count. Entries found only online are appended at the tail with an `API` tag — only when the parsed list is genuinely shorter.

- **Refresh button**: click to refresh (cache-first); **long-press** to bypass the cache and re-fetch both sides; `Ctrl+click` in a thesis/book PDF parses backwards from the current page (thesis mode).
- **Per row**: solid = already in your library, dimmed = not. Click to **copy the citation** (clean text, list numbering stripped) · long-press to **edit** the raw text (`Esc` cancels) · `Ctrl+click` to **locate in library / open in browser** · `+` to **import and bidirectionally relate** (`Ctrl+click +` picks the target collection) · `−` to unlink. Every control has a hover tooltip. Works flagged as **retracted** by OpenAlex / PubMed carry a red RETRACTED badge and ask for confirmation before import.
- **Toolbar**: labelled Refresh and Import All buttons retain the original icons. The More menu exposes a fresh fetch, parsing from the current PDF page, and copying the list as plain text, Markdown or CSV. Filtering supports citation text, authors, identifiers and badges, with a result count and clear button. Import All uses exactly the same filter and asks for confirmation. Click its progress window to stop; double-click the count to copy the whole list. Rows support Enter to copy, Ctrl/Cmd+Enter to locate, and F2 to edit.

### Hover card

Hover any row for one integrated card: title, publication details, selected authors, abstract and source links. Verified fields from several sources fill gaps in a fixed order; one abstract is shown with its provenance, and citation counts are never added together. Explicit first/co-first and corresponding/co-corresponding authors have separate labels. When roles are unavailable, the first and last listed authors are shown; a truncated author list never implies a last author. Links follow **Full text → Paper page → PubMed → Google Scholar → Zotero**, when available. Missing abstracts are labelled **Original citation**. Text is selectable and copyable; `Ctrl+wheel` zooms; translation is available when Translate for Zotero is installed. Late source responses preserve reading position and keyboard focus.

### In-PDF citation links

In the reader, hovering an in-text citation keeps Zotero’s native preview; clicking an in-text link (citation / figure / equation) jumps in a **split view**, so your reading position never moves. Split direction is configurable; outline and back-button navigation are untouched.

Items are looked up by DOI, or — when there is none — by PMID / arXiv id from the Extra field or URL, so PubMed-imported items work throughout.

### Cited By · Related · Citation Graph

- **Cited By** — paged list of works citing this item (Semantic Scholar / OpenAlex; paging is source-pinned and deduplicated) with a keyword filter over the loaded rows.
- **Related** — Semantic Scholar recommendations (OpenAlex fallback), merged with your Zotero related items.
- **Citation Graph** — a Connected-Papers-style force graph built from OpenAlex references + citations + related works with bibliographic-coupling edges (shared references). Node size = citation count; **solid = in your library**. **Hover** a node for the same multi-source card as a reference row (with a `+ Import` chip when the work is not in your library); **right-click** for import / show in library / open DOI / PubMed / Google Scholar / copy citation / **re-centre the graph on that work** (a "back to this item" button appears); click selects the item in your library, double-click opens it online; `Ctrl+wheel` zooms, drag pans. Legend on top; Rebuild button refetches.

### Settings overview

`Settings → Refs` groups settings into References, Hover cards, PDF reader, Discovery, Cache and Accounts. It follows Zest’s neutral material cards and native light/dark colors. Options include auto-refresh, item types excluded from auto-refresh, PDF pre-parse page count, per-item caching of PDF/API results and cache TTL, hover-card delay/behavior/translation, reader link behavior (click-to-jump, split direction), Cited By page size, graph max nodes, dimming opacity for not-in-library rows, network identity (email / S2 key / OpenAlex key), CNKI account.

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

**Refs——为每个 Zotero 条目提供参考文献、被引、相关文献与引文图谱。** 支持 Zotero 7–10；1.1.0 界面在 10.0.1 上实测，早期版本曾在 9.0.6 与 10.0 上验证。

### 安装

从 [Releases](https://github.com/yimmy23/zotero-refs/releases) 下载 `refs.xpi`，在 Zotero 中 `工具 → 插件 → ⚙ → Install Plugin From File…` 安装；之后的新版本会通过 Zotero 自带的插件更新机制自动推送（`工具 → 插件 → ⚙ → 检查更新`）。

### 需要填写哪些 API？

**一个都不必填。** 所有主数据源（Crossref、OpenAlex、Semantic Scholar、arXiv、PubMed、Unpaywall）均免密钥匿名可用。`设置 → Refs → 数据源账号` 中可配置：

- **Email**——默认值已内置；Crossref 据此使用 polite pool，Unpaywall 将其作为必要联系参数；OpenAlex 已忽略此邮箱参数，建议填自己的邮箱。
- **Semantic Scholar API key**——免费申请，仅用于放宽被引/相关/悬浮卡片的限流，不填也能用。
- **OpenAlex API key**——基础查询可匿名使用；可选密钥提高图谱及批量请求额度，通过请求头发送。
- **知网研学账号**——只有获取中文文献的「知网参考文献列表」才需要；单篇中文文献的检索与导入不依赖它。

### 使用方法

安装后，右侧条目面板（文库和 PDF 阅读器中均有）出现四个折叠区：**参考文献**、**被引用**、**相关文献**、**引文图谱**。

**参考文献**：自动加载，单一**融合**列表——PDF 文本层提供骨架（论文实际印出的条目、顺序、编号、页内位置），Crossref → Semantic Scholar → OpenAlex → 知网 逐条补全元数据（尤其是 DOI；历史 699 篇语料的 DOI 覆盖率约 19% → 80%，并非本版准确率）。任一侧不可用（未打开 PDF / 无标识符 / 离线）另一侧独立成表；计数旁标注参与的来源，仅在线找到的条目带 `API` 标签追加在表尾。刷新按钮：单击刷新（优先缓存），**长按**跳过缓存重新获取，学位论文中 `Ctrl+单击` 从当前页向前解析。行内操作：实心行=已入库、半透明=未入库；单击**复制干净引文**（自动去掉序号）；长按**编辑**原文（`Esc` 取消）；`Ctrl+单击` 在文库定位或浏览器打开；`+` **导入并双向关联**（`Ctrl+单击 +` 选择目标分类）；`−` 取消关联；所有控件悬停均有提示。被 OpenAlex / PubMed 标记**撤稿**的文献显示红色「已撤稿」标签，导入前会再次确认。工具栏保留原图标并显示操作名称；“更多”菜单提供跳过缓存重新获取、从 PDF 当前页解析及纯文本／Markdown／CSV 导出。筛选支持题录、作者、标识符和徽章，并显示结果数量；批量导入遵循同一筛选条件，执行前确认，中途点击进度窗口即可停止。Enter 复制、Ctrl/Cmd+Enter 定位、F2 编辑；双击计数复制全部。条目按 DOI 查询，无 DOI 时用 Extra/URL 中的 PMID 或 arXiv 号，PubMed 导入的条目同样可用。

**悬浮卡片**：多源信息整合成一张卡片，统一展示题名、发表信息、作者、摘要及来源链接。字段按固定优先顺序补缺，只采用一份摘要并标明出处，被引次数不跨来源相加。明确的第一／共同第一作者、通讯／共同通讯作者分别展示；缺少角色标注时显示首位和末位作者，截断的名单不冒充完整名单。跳转按钮按 **阅读全文 → 论文页面 → PubMed → 谷歌学术 → Zotero** 排列，仅显示可用入口；全文链接也可能打开HTML页面。没有摘要时明确显示“原始引文”。文字可选中、复制，`Ctrl+滚轮` 缩放；装有 Translate for Zotero 时提供翻译。异步更新保留滚动位置与键盘焦点。

**阅读器引文链接**：悬停正文引文保留 Zotero 原生预览；点击正文跳转链接（引文/图/公式）在**分栏**中打开，主视图阅读位置不动，分栏方向可设置。

**被引用**（分页加载，锁源去重，可关键词筛选）·**相关文献**（S2 推荐 + OpenAlex 兜底，合并 Zotero 关联条目）·**引文图谱**（OpenAlex 数据 + 基于共同参考文献的文献耦合边的力导向图：节点大小=被引量，实心=已入库）。**悬停**节点显示与参考文献行相同的多源卡片（未入库时带「+ 导入」）；**右键**菜单：导入并关联 / 在文库中显示 / 打开 DOI / PubMed / Google Scholar / 复制引文 / **以此文献为中心重建图谱**（出现「回到本文」按钮）；单击在文库中选中，双击在线打开；`Ctrl+滚轮` 缩放、拖动平移。

### 协议

AGPL-3.0-or-later——PDF 解析核心移植自 AGPL 的 zotero-reference，衍生作品依法必须保持 AGPL；这与 Zotero 本体及插件生态（官方模板、Translate for Zotero、Better BibTeX）一致。本仓库完整开源。

## Verification

Run `npm run check` for a production build, TypeScript and the synthetic regression suites. Run `PYTHONDONTWRITEBYTECODE=1 python3 scripts/parser-corpus/dev_client_regression.py` for the isolated development client checks. These checks cover matching, cache/network behavior, PDF text-layer parsing, reader teardown and UI state. They do not establish accuracy on every PDF layout. The 699-paper figures above describe the historical corpus, not a new benchmark for this revision. The new parser guards deliberately reject ambiguous unheaded tables and weakly structured book lists.

以上 699 篇语料指标是历史验证结果，不代表 1.1.0 重新测得的准确率。本版增加合成反例测试以减少误匹配；复杂版面、OCR 和结构不清晰的文献表仍需人工核对。

Provider contracts were checked against [OpenAlex authentication](https://help.openalex.org/api/authentication/), [arXiv API terms](https://info.arxiv.org/help/api/tou.html#rate-limits) and [NCBI usage guidance](https://www.ncbi.nlm.nih.gov/books/NBK25497/). The HTTP client now spaces arXiv starts by at least three seconds and NCBI starts by 350 ms. Anonymous Semantic Scholar requests may still be rate limited.
