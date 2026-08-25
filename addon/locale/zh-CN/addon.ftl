startup-begin = References 加载中
startup-finish = References 已就绪

item-section-references-head-text =
    .label = 参考文献
item-section-references-sidenav-tooltip =
    .tooltiptext = 参考文献
item-section-citations-head-text =
    .label = 被引用
item-section-citations-sidenav-tooltip =
    .tooltiptext = 引用了本文献的文章
item-section-related-head-text =
    .label = 相关文献
item-section-related-sidenav-tooltip =
    .tooltiptext = 相关与推荐文献
item-section-graph-head-text =
    .label = 引文图谱
item-section-graph-sidenav-tooltip =
    .tooltiptext = 本文献的引文图谱

panel-count-suffix = 条参考文献
panel-no-source = 没有可用的数据来源——请在阅读器中打开 PDF，或为条目补充 DOI / arXiv / PMID
panel-api-fail = 未能从网络 API 获取参考文献
panel-copy-all-done = 已复制全部参考文献
panel-copy-all-tip = 双击复制全部参考文献
panel-refresh = 刷新
panel-refresh-tip = 单击：刷新 · 长按：跳过缓存重新获取 · Ctrl+单击：从当前页向前解析（学位论文）
panel-parsing = 正在解析 PDF…
panel-requesting = 正在请求参考文献…
panel-copied = 已复制
popup-source-local = 本地（从引文解析）
panel-import-all = 全部导入
panel-import-all-tip = 将全部（或筛选后的）参考文献导入文库并建立双向关联
panel-export-tip = 复制列表 — 单击：纯文本 · Ctrl+单击：Markdown · Shift+单击：CSV
panel-export-done = 参考文献已复制
panel-search-placeholder = 筛选参考文献…
panel-cached = 缓存
row-api-only-tip = 仅在线来源——未能与 PDF 中印出的条目对齐

citations-count-suffix = 篇引证文献
citations-load-more = 加载更多

related-count-suffix = 篇相关文献

graph-loading = 正在构建引文图谱…
graph-unavailable = 无法构建引文图谱（需要 OpenAlex 收录的 DOI）
graph-rebuild = 重新构建

menu-references =
    .label = 参考文献
menu-fetch-refs =
    .label = 抓取并缓存参考文献
menu-import-refs =
    .label = 导入全部参考文献
menu-copy-refs =
    .label = 复制参考文献

graph-legend-origin = 本文
graph-legend-reference = 参考文献
graph-legend-citation = 引证文献
graph-legend-related = 相关
graph-legend-hint = 实心 = 已在文库

import-confirm = 将 { $count } 条参考文献导入文库并与本条目关联？附件按 Zotero 设置自动下载。导入过程中点击进度窗口可随时停止。
import-cancel-hint = 点击此处停止
import-cancelled = 已停止——已导入 { $ok } 条，其余 { $left } 条未处理

row-tip = 单击：复制 · 长按：编辑 · Ctrl/⌘+单击：在文库中定位或在线打开 · 悬停：详情
row-tip-readonly = 单击：复制 · Ctrl/⌘+单击：在文库中定位或在线打开 · 悬停：详情
row-import-tip = 导入文库并与本条目关联 · Ctrl/⌘+单击：选择分类
row-unlink-tip = 取消关联（条目仍保留在文库中）
retracted-badge = 已撤稿
retracted-tip = OpenAlex / PubMed 标记为已撤稿
retracted-import-confirm = 该文献已被标记为撤稿，仍要导入吗？
citations-filter-placeholder = 筛选引证文献…
graph-menu-import = 导入文库并关联
graph-menu-locate = 在文库中显示
graph-menu-open-doi = 打开 DOI
graph-menu-pubmed = 在 PubMed 中打开
graph-menu-scholar = 在 Google Scholar 中检索
graph-menu-copy = 复制引文
graph-menu-recenter = 以此文献为中心重建图谱
graph-back-home = 回到本文
graph-centered-on = 当前中心：
popup-import = + 导入

# 徽章提示——同一概念统一文案，绝不显示原始 API 字段名
tag-cited-tip = 被引次数（{ $source } 统计）
tag-refcount-tip = 参考文献数（{ $source } 统计）
tag-download-tip = 知网下载量
tag-oa-tip = 开放获取（{ $status }）
tag-oa-pdf-tip = 开放获取 PDF 全文
tag-scholar-tip = 在 Google Scholar 检索该标题
tag-pubmed-search-tip = 在 PubMed 检索该标题
popup-untitled = 文献

# 来源徽章提示
source-tip-pdf = 从 PDF 文本层解析
source-tip-crossref = Crossref——DOI 注册机构的官方元数据
source-tip-semanticscholar = Semantic Scholar——Allen AI 研究所的学术检索
source-tip-openalex = OpenAlex——完全开放的学术著作目录
source-tip-pubmed = PubMed——美国国立医学图书馆生物医学文献库
source-tip-unpaywall = Unpaywall——开放获取状态
source-tip-readpaper = ReadPaper 论文阅读平台
source-tip-connectedpapers = Connected Papers——可视化文献探索
source-tip-cnki = 中国知网 CNKI
source-tip-arxiv = arXiv——开放获取预印本库
source-tip-zotero = 该文献已在你的 Zotero 文库中

# 进度窗口标题/行
progress-refs = 参考文献
progress-refs-local = [缓存] 参考文献
progress-refs-pending = [获取中] 参考文献
progress-refs-done = [完成] 参考文献
progress-refs-fail = [失败] 参考文献
progress-searching-url = 正在查找链接
progress-no-url = 未找到可打开的链接
progress-importing = 正在导入文献
progress-import-done = [完成] 导入
progress-import-fail = [失败] 导入
progress-unlinking = 正在取消关联
progress-unlinked = 已取消关联
panel-requesting-source = 正在请求 { $source } 参考文献…
importer-search-doi = 正在查找 DOI
importer-importing = 正在导入
importer-create = 正在创建条目
parser-read-text = 读取文本
parser-analyze = 分析版面
parser-done = 完成
graph-status-lookup = 正在 OpenAlex 查询本文…
graph-status-refs = 正在加载 { $count } 条参考文献…
graph-status-citing = 正在加载引证文献…
graph-status-related = 正在加载相关文献…
graph-status-match = 正在与文库匹配…
graph-status-edges = 正在构建连线…
graph-status-ready = 图谱就绪：{ $nodes } 个节点，{ $edges } 条连线
