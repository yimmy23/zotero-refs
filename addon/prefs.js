// Reference list behavior
pref("preLoadingPageNum", 4);
pref("autoRefresh", true);
pref("notAutoRefreshItemTypes", "book, letter, note, thesis");
pref("savePDFReferences", true);
pref("saveAPIReferences", true);
pref("notInLibraryOpacity", "0.7");

// Hover popup
pref("showPopup", true);
pref("popupDelay", 233);
// graph nodes are small targets the pointer crosses on the way elsewhere —
// a longer delay than list rows keeps the card from popping up in transit
pref("graphPopupDelay", 550);
pref("popupFadeMs", 233);
pref("popupRemoveDelay", 500);
pref("ctrlClickTranslate", true);
pref("popupBackgroundColor", "");
pref("popupTitleColor", "#2270d9");

// Preferred metadata source index per identifier kind (popup dots)
pref("arXivInfoIndex", 0);
pref("DOIInfoIndex", 0);
pref("PMIDInfoIndex", 0);
pref("TitleInfoIndex", 0);

// Optional Alt/Option+click split navigation; ordinary clicks stay native.
pref("clickLink", true);
pref("clickLinkCmd", "splitHorizontally");

// Related & citations sections
pref("loadingRelated", true);
pref("loadingCitations", true);
pref("citationsPageSize", 25);

// Graph view
pref("graphEnable", true);
pref("graphMaxNodes", 50);

// Network
pref("email", "zotero-refs@mailinator.com");
pref("s2ApiKey", "");
pref("openAlexApiKey", "");
pref("cacheTTLHours", 168);

// CNKI (知网研学 account, only needed for CNKI reference lists)
pref("CNKI.username", "");
pref("CNKI.password", "");
pref("CNKI.token", "");
