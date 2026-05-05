const { cleanGeneratedText, truncateText } = require("./text-utils");

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function safeTextList(value, limit, maxLength) {
  if (Array.isArray(value)) {
    return value.map((item) => truncateText(item, maxLength)).filter(Boolean).slice(0, limit);
  }
  if (typeof value === "string" && value.trim()) return [truncateText(value, maxLength)];
  return [];
}

function normalizeSearchQueries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (typeof item === "string") {
        return { query: item.trim(), purpose: "桌面研究", type: "general", priority: index + 1 };
      }
      return {
        query: cleanGeneratedText(item?.query || ""),
        purpose: cleanGeneratedText(item?.purpose || "桌面研究"),
        type: cleanGeneratedText(item?.type || "general"),
        priority: Number(item?.priority) || index + 1,
      };
    })
    .filter((item) => item.query)
    .sort((a, b) => a.priority - b.priority);
}

function prepareSearchResultsForPrompt(searchResults) {
  return {
    status: searchResults?.status || "skipped",
    provider: searchResults?.provider || "",
    reason: searchResults?.reason || "",
    queries: normalizeSearchQueries(searchResults?.queries || []),
    results: (Array.isArray(searchResults?.results) ? searchResults.results : []).map((group) => ({
      query: group.query,
      purpose: group.purpose,
      type: group.type,
      answer: truncateText(group.response?.answer, 500),
      responseTime: group.response?.response_time || "",
      results: (Array.isArray(group.response?.results) ? group.response.results : []).slice(0, 4).map((result) => ({
        title: truncateText(result.title, 140),
        url: cleanGeneratedText(result.url),
        content: truncateText(result.content || result.raw_content, 650),
        score: result.score,
        publishedDate: result.published_date || result.publishedDate || "",
      })),
    })),
  };
}

function normalizeEvidencePack(input, fallback = {}) {
  const source = input && typeof input === "object" ? input : {};
  const pack = source.evidencePack && typeof source.evidencePack === "object" ? source.evidencePack : source;
  const sourceCards = Array.isArray(pack.sourceCards) ? pack.sourceCards : [];

  return {
    status: cleanGeneratedText(pack.status || fallback.status || "skipped"),
    generatedAt: cleanGeneratedText(pack.generatedAt || todayIsoDate()),
    topic: cleanGeneratedText(pack.topic || ""),
    stimulusScript: cleanGeneratedText(pack.stimulusScript || ""),
    skipReason: cleanGeneratedText(pack.skipReason || ""),
    error: cleanGeneratedText(pack.error || ""),
    queries: Array.isArray(pack.queries) ? pack.queries : (fallback.queries || []),
    sourceCards: sourceCards.slice(0, 12).map((card, index) => ({
      id: cleanGeneratedText(card.id || `S${index + 1}`),
      type: cleanGeneratedText(card.type || "other"),
      title: truncateText(card.title, 140),
      url: cleanGeneratedText(card.url),
      sourceDate: cleanGeneratedText(card.sourceDate || "未知"),
      reliability: cleanGeneratedText(card.reliability || "medium"),
      keyFacts: safeTextList(card.keyFacts, 5, 180),
      userSignals: safeTextList(card.userSignals, 5, 180),
      competitors: safeTextList(card.competitors, 5, 80),
      relevantFor: safeTextList(card.relevantFor, 5, 80),
      quoteSnippets: safeTextList(card.quoteSnippets, 4, 140),
    })),
    marketPatterns: safeTextList(pack.marketPatterns, 8, 180),
    competitors: safeTextList(pack.competitors, 12, 80),
    commonComplaints: safeTextList(pack.commonComplaints, 10, 160),
    purchaseBarriers: safeTextList(pack.purchaseBarriers, 10, 160),
    openQuestions: safeTextList(pack.openQuestions, 10, 180),
  };
}

function attachEvidencePackToContextState(contextState, evidencePack, values, normalizeContextState) {
  const pack = normalizeEvidencePack(evidencePack);
  if (pack.status !== "used" || !pack.sourceCards.length) return contextState;

  const externalFindings = pack.sourceCards.map((card) => ({
    source: card.id,
    title: card.title,
    summary: [
      ...card.keyFacts.slice(0, 3),
      ...card.userSignals.slice(0, 3),
    ].join("；"),
    url: card.url,
    usedFor: card.relevantFor.join("、"),
  }));

  return normalizeContextState({
    ...contextState,
    externalFindings: [
      ...(Array.isArray(contextState?.externalFindings) ? contextState.externalFindings : []),
      ...externalFindings,
    ],
  }, values);
}

module.exports = {
  todayIsoDate,
  safeTextList,
  normalizeSearchQueries,
  prepareSearchResultsForPrompt,
  normalizeEvidencePack,
  attachEvidencePackToContextState,
};
