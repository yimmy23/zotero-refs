startup-begin = References is loading
startup-finish = References is ready

item-section-references-head-text =
    .label = References
item-section-references-sidenav-tooltip =
    .tooltiptext = References
item-section-citations-head-text =
    .label = Cited By
item-section-citations-sidenav-tooltip =
    .tooltiptext = Works citing this item
item-section-related-head-text =
    .label = Related Papers
item-section-related-sidenav-tooltip =
    .tooltiptext = Related and recommended papers
item-section-graph-head-text =
    .label = Citation Graph
item-section-graph-sidenav-tooltip =
    .tooltiptext = Citation graph of this item

panel-count-suffix = references
panel-no-source = No reference source available — open the PDF in the reader, or add a DOI / arXiv / PMID to the item
panel-api-fail = No references found from web APIs
panel-copy-all-done = All references copied
panel-copy-all-tip = Double-click to copy all references
panel-refresh = Refresh
panel-refresh-tip = Click: refresh · Long press: bypass cache and re-fetch · Ctrl+click: parse from the current page (theses)
panel-parsing = Parsing PDF…
panel-requesting = Requesting references…
panel-copied = Copied
popup-source-local = Local (parsed from the citation)
panel-import-all = Import All
panel-import-all-tip = Import all (or filtered) references into the library and link them as related items
panel-export-tip = Copy list — click: plain text · Ctrl+click: Markdown · Shift+click: CSV
panel-export-done = References copied
panel-search-placeholder = Filter references…
panel-cached = cached
row-api-only-tip = Found online only — not matched to an entry printed in the PDF

citations-count-suffix = citations
citations-load-more = Load more

related-count-suffix = related papers

graph-loading = Building citation graph…
graph-unavailable = Citation graph unavailable (needs a DOI known to OpenAlex)
graph-rebuild = Rebuild

menu-references =
    .label = References
menu-fetch-refs =
    .label = Fetch & cache references
menu-import-refs =
    .label = Import all references
menu-copy-refs =
    .label = Copy references

graph-legend-origin = this paper
graph-legend-reference = references
graph-legend-citation = citing works
graph-legend-related = related
graph-legend-hint = solid = in your library

import-confirm = Import { $count } references into your library and relate them to this item? Attachments are downloaded per your Zotero settings. Click the progress window to stop midway.
import-cancel-hint = Click here to stop
import-cancelled = Stopped — { $ok } imported, { $left } left untouched

row-tip = Click: copy · Hold: edit · Ctrl/⌘+click: locate in library or open online · Hover: details
row-tip-readonly = Click: copy · Ctrl/⌘+click: locate in library or open online · Hover: details
row-import-tip = Import into library and relate to this item · Ctrl/⌘+click: choose collection
row-unlink-tip = Remove the relation (the item stays in your library)
retracted-badge = RETRACTED
retracted-tip = Flagged as retracted by OpenAlex / PubMed
retracted-import-confirm = This work is flagged as RETRACTED. Import it anyway?
citations-filter-placeholder = Filter citing works…
graph-menu-import = Import into library and relate
graph-menu-locate = Show in library
graph-menu-open-doi = Open DOI
graph-menu-pubmed = Open in PubMed
graph-menu-scholar = Search on Google Scholar
graph-menu-copy = Copy citation
graph-menu-recenter = Re-centre graph on this work
graph-back-home = back to this item
graph-centered-on = Graph centred on
popup-import = + Import
popup-list-expand-tip = Click for details

# chip tooltips — one unified label per concept, never a raw API field name
tag-cited-tip = Times cited ({ $source })
tag-refcount-tip = Reference count ({ $source })
tag-download-tip = CNKI download count
tag-oa-tip = Open access ({ $status })
tag-oa-pdf-tip = Open-access PDF full text
tag-scholar-tip = Search this title on Google Scholar
tag-pubmed-search-tip = Search this title on PubMed
popup-untitled = Reference

# source-badge tooltips
source-tip-pdf = Parsed from the PDF text layer
source-tip-crossref = Crossref — official DOI registration agency metadata
source-tip-semanticscholar = Semantic Scholar — AI-powered research tool by Allen Institute for AI
source-tip-openalex = OpenAlex — fully open catalog of scholarly works
source-tip-pubmed = PubMed — biomedical literature from NLM
source-tip-unpaywall = Unpaywall — open-access status
source-tip-readpaper = ReadPaper — paper reading platform
source-tip-connectedpapers = Connected Papers — visual exploration of academic papers
source-tip-cnki = CNKI — China National Knowledge Infrastructure
source-tip-arxiv = arXiv — open-access preprint archive
source-tip-zotero = This reference is in your Zotero library

# progress-window headlines / lines
progress-refs = References
progress-refs-local = [Local] References
progress-refs-pending = [Pending] References
progress-refs-done = [Done] References
progress-refs-fail = [Fail] References
progress-searching-url = Searching URL
progress-no-url = No URL found
progress-importing = Importing Reference
progress-import-done = [Done] Import
progress-import-fail = [Fail] Import
progress-unlinking = Removing Relation
progress-unlinked = Removed
panel-requesting-source = Requesting { $source } references…
importer-search-doi = Searching DOI
importer-importing = Importing
importer-create = Creating item
parser-read-text = Read text
parser-analyze = Analyze layout
parser-done = Done
graph-status-lookup = Looking up work on OpenAlex…
graph-status-refs = Loading { $count } references…
graph-status-citing = Loading citing works…
graph-status-related = Loading related works…
graph-status-match = Matching against your library…
graph-status-edges = Building edges…
graph-status-ready = Graph ready: { $nodes } nodes, { $edges } edges
