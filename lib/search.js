const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;

function createSearchClient({ config, activeProviderName, activeProvider }) {
  const enabled = Boolean(config?.enabled && activeProviderName && activeProvider);

  function getStatus() {
    return {
      enabled,
      activeProvider: activeProviderName || "",
      provider: activeProvider?.name || "",
      endpoint: activeProvider?.endpoint || "",
      requiresKey: Boolean(activeProvider?.requiresKey),
      hasKey: Boolean(activeProvider?.apiKey),
      maxQueries: getMaxQueries(),
      maxResultsPerQuery: getMaxResultsPerQuery(),
    };
  }

  function canSearch() {
    if (!enabled) return false;
    if (!activeProvider.endpoint) return false;
    if (activeProvider.requiresKey && !activeProvider.apiKey) return false;
    return true;
  }

  async function searchMany(queries) {
    if (!canSearch()) {
      return {
        status: "skipped",
        reason: enabled ? "search API key or endpoint is missing" : "search is disabled",
        queries: [],
        results: [],
      };
    }

    const safeQueries = normalizeQueries(queries).slice(0, getMaxQueries());
    const groups = await mapWithConcurrency(safeQueries, 2, async (item) => {
      const response = await searchOne(item.query);
      return {
        ...item,
        response,
      };
    });

    return {
      status: "used",
      provider: activeProvider.name,
      queries: safeQueries,
      results: groups,
    };
  }

  async function searchOne(query) {
    if ((activeProvider.format || "").toLowerCase() !== "tavily") {
      throw new Error(`Unsupported search provider format: ${activeProvider.format}`);
    }
    return searchTavily(query);
  }

  async function searchTavily(query) {
    const body = {
      query,
      topic: "general",
      search_depth: activeProvider.searchDepth || "advanced",
      max_results: getMaxResultsPerQuery(),
      include_answer: activeProvider.includeAnswer ? "basic" : false,
      include_raw_content: activeProvider.includeRawContent || false,
      include_images: false,
      chunks_per_source: clampNumber(activeProvider.chunksPerSource, 1, 3),
    };
    if (activeProvider.country) body.country = activeProvider.country;

    const timeoutMs = getEnvTimeout("FOCUS_GROUP_SEARCH_TIMEOUT_MS", DEFAULT_SEARCH_TIMEOUT_MS, 5_000, 120_000);
    let response;
    try {
      response = await fetchWithTimeout(activeProvider.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeProvider.apiKey}`,
        },
        body: JSON.stringify(body),
      }, timeoutMs);
    } catch (error) {
      if (error.name === "TimeoutError") {
        throw new Error(`${activeProvider.name} search API timeout after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${activeProvider.name} search API ${response.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${activeProvider.name} search API returned non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  function getMaxQueries() {
    return clampNumber(config?.maxQueries || 4, 1, 8);
  }

  function getMaxResultsPerQuery() {
    return clampNumber(activeProvider?.maxResultsPerQuery || config?.maxResultsPerQuery || 5, 1, 10);
  }

  return {
    canSearch,
    getStatus,
    searchMany,
  };
}

function normalizeQueries(queries) {
  if (!Array.isArray(queries)) return [];
  return queries
    .map((item, index) => {
      if (typeof item === "string") {
        return { query: item.trim(), purpose: "桌面研究", type: "general", priority: index + 1 };
      }
      return {
        query: String(item?.query || "").trim(),
        purpose: String(item?.purpose || "桌面研究").trim(),
        type: String(item?.type || "general").trim(),
        priority: Number(item?.priority) || index + 1,
      };
    })
    .filter((item) => item.query);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length || 1);
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
  return results;
}

function clampNumber(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`request timed out after ${timeoutMs}ms`);
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getEnvTimeout(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

module.exports = {
  createSearchClient,
};
