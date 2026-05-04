const { cleanGeneratedText, truncateText } = require("./text-utils");
const { todayIsoDate, normalizeSearchQueries } = require("./evidence-pack");

function normalizeQuickFill(input) {
  const safe = (value, fallback) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).join("\n");
    return fallback;
  };
  return {
    projectName: safe(input.projectName, "AI 生成项目"),
    productConcept: safe(input.productConcept, ""),
    coreSellingPoints: safe(input.coreSellingPoints, ""),
    targetAudience: safe(input.targetAudience, ""),
    discussionTopics: safe(input.discussionTopics, ""),
  };
}

function safeSearchResultCards(value, limit, maxContentLength) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => ({
    title: truncateText(item.title, 140),
    url: cleanGeneratedText(item.url),
    content: truncateText(item.content || item.summary || "", maxContentLength),
    publishedDate: cleanGeneratedText(item.publishedDate || item.published_date || ""),
    score: item.score,
  })).filter((item) => item.title || item.content);
}

function normalizeQuickFillResearch(input) {
  const source = input && typeof input === "object" ? input : {};
  const sourceCards = Array.isArray(source.sourceCards) ? source.sourceCards : [];
  const queryInsights = Array.isArray(source.queryInsights) ? source.queryInsights : [];
  return {
    status: cleanGeneratedText(source.status || "skipped"),
    generatedAt: cleanGeneratedText(source.generatedAt || todayIsoDate()),
    seed: truncateText(source.seed, 400),
    provider: cleanGeneratedText(source.provider || ""),
    skipReason: cleanGeneratedText(source.skipReason || ""),
    error: truncateText(source.error, 300),
    queries: normalizeSearchQueries(source.queries || []).slice(0, 4),
    queryInsights: queryInsights.slice(0, 4).map((item) => ({
      query: truncateText(item.query, 120),
      purpose: truncateText(item.purpose, 120),
      type: truncateText(item.type, 60),
      answer: truncateText(item.answer, 500),
      topResults: safeSearchResultCards(item.topResults, 3, 420),
    })),
    sourceCards: safeSearchResultCards(sourceCards, 10, 520),
  };
}

function normalizeQuickFillResearchFromSearch(seed, searchResults) {
  const sourceCardsByUrl = new Map();
  const queryInsights = (Array.isArray(searchResults?.results) ? searchResults.results : []).slice(0, 4).map((group) => {
    const topResults = (Array.isArray(group.response?.results) ? group.response.results : []).slice(0, 3).map((result) => {
      const card = {
        title: result.title,
        url: result.url,
        content: result.content || result.raw_content || "",
        publishedDate: result.published_date || result.publishedDate || "",
        score: result.score,
      };
      if (card.url && !sourceCardsByUrl.has(card.url)) sourceCardsByUrl.set(card.url, card);
      return card;
    });
    return {
      query: group.query,
      purpose: group.purpose,
      type: group.type,
      answer: group.response?.answer || "",
      topResults,
    };
  });

  const sourceCards = Array.from(sourceCardsByUrl.values()).slice(0, 10);
  return normalizeQuickFillResearch({
    status: sourceCards.length ? "used" : "skipped",
    generatedAt: todayIsoDate(),
    seed,
    provider: searchResults?.provider || "",
    skipReason: sourceCards.length ? "" : searchResults?.reason || "search returned no usable results",
    queries: searchResults?.queries || [],
    queryInsights,
    sourceCards,
  });
}

function buildFallbackQuickFillQueries(seed, maxQueries = 4) {
  const text = truncateText(seed, 80);
  if (!text) return [];
  return [
    { query: `${text} 用户痛点 评价`, purpose: "了解真实用户痛点和评价语言", type: "pain_points", priority: 1 },
    { query: `${text} 竞品 价格`, purpose: "了解竞品和价格锚点", type: "competitor", priority: 2 },
    { query: `${text} 评测 推荐`, purpose: "了解购买理由和使用场景", type: "reviews", priority: 3 },
    { query: `${text} 替代方案`, purpose: "了解用户当前替代行为", type: "alternatives", priority: 4 },
  ].slice(0, maxQueries);
}

function summarizeQuickFillResearch(research) {
  const normalized = normalizeQuickFillResearch(research);
  return {
    status: normalized.status,
    provider: normalized.provider,
    sourceCount: normalized.sourceCards.length,
    queryCount: normalized.queries.length,
    skipReason: normalized.skipReason,
    error: normalized.error,
  };
}

module.exports = {
  normalizeQuickFill,
  safeSearchResultCards,
  normalizeQuickFillResearch,
  normalizeQuickFillResearchFromSearch,
  buildFallbackQuickFillQueries,
  summarizeQuickFillResearch,
};
