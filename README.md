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

Hover any row for one integrated card: title, publication details, selected authors, abstract and source links. Verified fields from several sources fill gaps in a fixed order; one abstract is shown with its provenance, and citation counts are never added together. Explicit first/co-first and corresponding/co-corresponding authors have separate labels. When roles are unavailable, the first and last listed authors are shown; a truncated author list never implies a last author. Links follow **Full text → Paper page → PubMed → Google Scholar → Zotero**, when available. Missing abstracts are looked up through Europe PMC and PubMed using verified article identities; **Original citation** is shown when no abstract is available. Full author names are preferred when compatible source records supply them. Text is selectable and copyable; `Ctrl+wheel` zooms; translation is available when Translate for Zotero is installed. Requested translations and the original/translated view are retained when reopening the card during the current plugin session; pending requests are reused. Late source responses preserve reading position and keyboard focus.

### In-PDF citation links

In the reader, hovering an in-text citation keeps Zotero’s native preview; a normal click on a citation or internal link uses Zotero’s native jump in the current view. **Alt / Option+click** opens the destination in a split view when enabled, preserving your reading position. Split direction is configurable; outline and back-button navigation are untouched.

Items are looked up by DOI, or — when there is none — by PMID / arXiv id from the Extra field or URL, so PubMed-imported items work throughout.

### Cited By · Related · Citation Graph

- **Cited By** — paged list of works citing this item (Semantic Scholar / OpenAlex; paging is source-pinned and deduplicated) with a keyword filter over the loaded rows.
- **Related** — existing Zotero links first, followed by up to 20 recommendations from Semantic Scholar and OpenAlex. Both sources are queried concurrently (at most 40 candidates each), and source-list positions are combined with reciprocal rank fusion. Each row shows the contributing sources and their list positions; these are not similarity probabilities. Matching uses compatible shared identifiers, not titles alone, and citation counts do not boost the ranking. A working source can display results while the other is pending or unavailable. Update recomputes the list, potentially reusing the source HTTP cache; complete results have a bounded 30-minute panel cache. No abstract upload or local AI model is required.
- **Citation Graph** — a Connected-Papers-style force graph built from OpenAlex references + citations + related works with bibliographic-coupling edges (shared references). Node size = citation count; **solid = in your library**. **Hover** a node for the same multi-source card as a reference row (with a `+ Import` chip when the work is not in your library); **right-click** for import / show in library / open DOI / PubMed / Google Scholar / copy citation / **re-centre the graph on that work** (a "back to this item" button appears); click selects the item in your library, double-click opens it online; `Ctrl+wheel` zooms, drag pans. Legend on top; Rebuild button refetches.

Graph arrows run from the citing work to the cited work. Dashed links are provider recommendations, not confirmed citations; thin links represent shared references. Zest's Library Relations view instead covers local item links, authors, tags and collections.

### Settings overview

`Settings → Refs` groups settings into References, Hover cards, PDF reader, Discovery, Cache and Accounts. It follows Zest’s neutral material cards and native light/dark colors. Options include auto-refresh, item types excluded from auto-refresh, PDF pre-parse page count, per-item caching of PDF/API results and cache TTL, hover-card delay/behavior/translation, reader link behavior (Alt / Option+click to split, split direction), Cited By page size, graph max nodes, dimming opacity for not-in-library rows, network identity (email / S2 key / OpenAlex key), CNKI account.

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

**悬浮卡片**：多源信息整合成一张卡片，统一展示题名、发表信息、作者、摘要及来源链接。字段按固定优先顺序补缺，只采用一份摘要并标明出处，被引次数不跨来源相加。明确的第一／共同第一作者、通讯／共同通讯作者分别展示；缺少角色标注时显示首位和末位作者，截断的名单不冒充完整名单。跳转按钮按 **阅读全文 → 论文页面 → PubMed → 谷歌学术 → Zotero** 排列，仅显示可用入口；全文链接也可能打开HTML页面。摘要缺失时通过 Europe PMC 和 PubMed 核验文献身份后补抓；仍未获得摘要时显示“原始引文”。兼容的来源提供全名时，优先展示作者全名。文字可选中、复制，`Ctrl+滚轮` 缩放；装有 Translate for Zotero 时提供翻译；当前插件会话内重新打开卡片会保留已请求的译文及原文／译文选择，并复用进行中的请求。异步更新保留滚动位置与键盘焦点。

**阅读器引文链接**：悬停正文引文保留 Zotero 原生预览；普通点击引文或内部链接按 Zotero 原生方式在当前视图跳转；启用相关设置后，**Alt / Option＋点击**在分栏中打开目标，保留当前阅读位置，分栏方向可设置。

**被引用**（分页加载，锁源去重，可关键词筛选）·**相关文献**（先列出 Zotero 人工关联，再融合 Semantic Scholar 与 OpenAlex 推荐）·**引文图谱**（OpenAlex 数据 + 基于共同参考文献的文献耦合边的力导向图：节点大小=被引量，实心=已入库）。**悬停**节点显示与参考文献行相同的多源卡片（未入库时带「+ 导入」）；**右键**菜单：导入并关联 / 在文库中显示 / 打开 DOI / PubMed / Google Scholar / 复制引文 / **以此文献为中心重建图谱**（出现「回到本文」按钮）；单击在文库中选中，双击在线打开；`Ctrl+滚轮` 缩放、拖动平移。

相关文献并行获取两个来源的候选（每源最多 40 篇），按来源列表位次进行倒数排名融合，排除本文和已有关联后最多显示 20 条推荐。行下标明来源及其列表位次，不把它们当成相似概率，不按被引数提高排名。同名但 DOI 不同的论文保留；仅凭标题不会合并。先返回的来源可以先显示，另一来源失败不会清空已有结果。更新按钮重新组装推荐，可能复用来源 HTTP 缓存；完整双源结果另有最多 40 个条目、30 分钟的面板缓存。无需上传摘要或安装本地 AI 模型。

引文图谱中的箭头方向是“引用者 → 被引用者”；来源推荐使用无箭头虚线，共享参考文献使用细线。与 Zest 的文库关系图分工不同，后者呈现本地条目、作者、标签和分类关系。

### 协议

AGPL-3.0-or-later——PDF 解析核心移植自 AGPL 的 zotero-reference，衍生作品依法必须保持 AGPL；这与 Zotero 本体及插件生态（官方模板、Translate for Zotero、Better BibTeX）一致。本仓库完整开源。

## Verification

Run `npm run check` for a production build, TypeScript and the synthetic regression suites. Run `PYTHONDONTWRITEBYTECODE=1 python3 scripts/parser-corpus/dev_client_regression.py` for the isolated development client checks. These checks cover matching, cache/network behavior, PDF text-layer parsing, reader teardown and UI state. They do not establish accuracy on every PDF layout. The 699-paper figures above describe the historical corpus, not a new benchmark for this revision. The new parser guards deliberately reject ambiguous unheaded tables and weakly structured book lists.

以上 699 篇语料指标是历史验证结果，不代表 1.1.0 重新测得的准确率。本版增加合成反例测试以减少误匹配；复杂版面、OCR 和结构不清晰的文献表仍需人工核对。

Provider contracts were checked against [OpenAlex authentication](https://help.openalex.org/api/authentication/), [arXiv API terms](https://info.arxiv.org/help/api/tou.html#rate-limits) and [NCBI usage guidance](https://www.ncbi.nlm.nih.gov/books/NBK25497/). The HTTP client now spaces arXiv starts by at least three seconds and NCBI starts by 350 ms. Anonymous Semantic Scholar requests may still be rate limited.
