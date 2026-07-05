const http = require("http");

const {
  buildSearchProviders,
  loadApiConfig,
  loadSearchConfig,
  buildProviders,
  resolveActiveProviderName,
  resolveActiveSearchProviderName,
  normalizeProviderName,
} = require("./lib/config");
const { createPromptStore } = require("./lib/prompts");
const { createLlmClient, createLlmClientWithOverrides } = require("./lib/llm");
const { createFocusGroupService } = require("./lib/focus-group-service");
const { createSearchClient } = require("./lib/search");
const { sendJson } = require("./lib/http");
const { serveStatic } = require("./lib/static");
const { toClientError } = require("./lib/error-response");

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "localhost";
const ROOT = __dirname;

const apiConfig = loadApiConfig(ROOT);
const providers = buildProviders(apiConfig);
const activeProviderName = resolveActiveProviderName(apiConfig, providers);
const activeProvider = providers[activeProviderName];
const searchConfig = loadSearchConfig(ROOT);
const searchProviders = buildSearchProviders(searchConfig);
const activeSearchProviderName = resolveActiveSearchProviderName(searchConfig, searchProviders);
const activeSearchProvider = activeSearchProviderName ? searchProviders[activeSearchProviderName] : null;
const promptStore = createPromptStore(ROOT);
const llm = createLlmClient({ activeProvider, activeProviderName });
const searchClient = createSearchClient({
  config: searchConfig,
  activeProviderName: activeSearchProviderName,
  activeProvider: activeSearchProvider,
});
const focusGroup = createFocusGroupService({ promptStore, llm, searchClient });

const routes = {
  "POST /api/personas": focusGroup.handlePersonas,
  "POST /api/moderator-guide": focusGroup.handleModeratorGuide,
  "POST /api/evidence-pack": focusGroup.handleEvidencePack,
  "POST /api/session/round/stream": focusGroup.handleSessionRoundStream,
  "POST /api/report/stream": focusGroup.handleReportStream,
  "POST /api/quick-fill": focusGroup.handleQuickFill,
};

const server = http.createServer(async (req, res) => {
  const requestAbort = new AbortController();
  req.requestSignal = requestAbort.signal;
  req.on("aborted", () => requestAbort.abort());
  res.on("close", () => {
    if (!res.writableEnded && !res.destroyed) requestAbort.abort();
  });

  try {
    const urlPath = getRequestPath(req);

    if (urlPath.startsWith("/api/")) {
      applyRequestClientOverrides(req);
    }

    const route = routes[`${req.method} ${urlPath}`];
    if (route) {
      return await route(req, res, sendJson);
    }

    if (req.method === "GET" && urlPath === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        provider: activeProvider.name,
        endpoint: activeProvider.endpoint,
        textEndpoint: activeProvider.textEndpoint,
        model: activeProvider.model,
        requiresKey: activeProvider.requiresKey,
        hasKey: Boolean(activeProvider.apiKey),
        providers: Object.keys(providers),
        search: searchClient.getStatus(),
      });
    }

    if (req.method === "GET" && urlPath === "/api/config") {
      const visibleSearchClient = req.userSearchClient || searchClient;
      return sendJson(res, 200, {
        activeProvider: activeProvider.name,
        providers: Object.fromEntries(
          Object.entries(providers).map(([key, provider]) => [
            key,
            {
              name: provider.name,
              format: provider.format,
              endpoint: provider.endpoint,
              model: provider.model,
              requiresKey: provider.requiresKey,
              hasKey: Boolean(provider.apiKey),
            },
          ]),
        ),
        prompts: promptStore.listPromptFiles(),
        search: visibleSearchClient.getStatus(),
      });
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    return serveStatic(ROOT, req, res);
  } catch (error) {
    const clientError = toClientError(error);
    if (clientError.shouldLog) console.error(error);
    if (!res.writableEnded && !res.destroyed) {
      return sendJson(res, clientError.statusCode, clientError.payload);
    }
    return undefined;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nFocus Group MVP running at http://${HOST}:${PORT}`);
  console.log(`  Provider : ${activeProvider.name} (${activeProviderName}) [format: ${activeProvider.format}]`);
  console.log(`  Endpoint : ${activeProvider.endpoint || "(none)"}`);
  console.log(`  Model    : ${activeProvider.model || "(none)"}`);
  if (activeProvider.requiresKey) {
    console.log(`  API Key  : ${activeProvider.apiKey ? "loaded" : "MISSING - set apiKey in config/api.config.local.json"}`);
  } else {
    console.log("  API Key  : (not required)");
  }
  const searchStatus = searchClient.getStatus();
  console.log(`  Search   : ${searchStatus.enabled ? "enabled" : "disabled"}${searchStatus.provider ? ` (${searchStatus.provider})` : ""}${searchStatus.hasKey ? " [key loaded]" : ""}`);
  console.log(`  Available providers: ${Object.keys(providers).join(", ")}\n`);
});

function getRequestPath(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function applyRequestClientOverrides(req) {
  const settings = readClientSettings(req);
  const providerName = normalizeProviderName(settings.apiProvider);
  const apiKey = settings.apiKey;
  if (apiKey) {
    const userProvider = (providerName && providers[providerName]) || activeProvider;
    req.userLlm = createLlmClientWithOverrides(userProvider, {
      apiProvider: providerName || activeProviderName,
      apiKey,
      apiBaseUrl: settings.apiBaseUrl,
      model: settings.model,
    });
  }
  req.userSearchClient = buildUserSearchClient(settings);
}

function readClientSettings(req) {
  return {
    apiProvider: firstHeader(req, "x-fg-api-provider"),
    apiKey: firstHeader(req, "x-fg-api-key"),
    apiBaseUrl: firstHeader(req, "x-fg-api-base-url"),
    model: firstHeader(req, "x-fg-api-model"),
    searchProvider: firstHeader(req, "x-fg-search-provider"),
    searchApiKey: firstHeader(req, "x-fg-search-api-key"),
  };
}

function firstHeader(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

function buildUserSearchClient(settings) {
  const searchProviderName = String(settings?.searchProvider || "").trim();
  const searchApiKey = String(settings?.searchApiKey || "").trim();
  if (!searchProviderName || !searchApiKey) return null;

  const baseProvider = searchProviders[searchProviderName] || activeSearchProvider;
  if (!baseProvider) return null;

  return createSearchClient({
    config: searchConfig,
    activeProviderName: searchProviderName,
    activeProvider: {
      ...baseProvider,
      apiKey: searchApiKey,
    },
  });
}
