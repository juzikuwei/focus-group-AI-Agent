const http = require("http");

const {
  buildSearchProviders,
  loadApiConfig,
  loadSearchConfig,
  buildProviders,
  resolveActiveProviderName,
  resolveActiveSearchProviderName,
} = require("./lib/config");
const { createPromptStore } = require("./lib/prompts");
const { createLlmClient } = require("./lib/llm");
const { createFocusGroupService } = require("./lib/focus-group-service");
const { createSearchClient } = require("./lib/search");
const { sendJson } = require("./lib/http");
const { serveStatic } = require("./lib/static");

const PORT = Number(process.env.PORT || 5173);
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
  "POST /api/session": focusGroup.handleSession,
  "POST /api/session/round": focusGroup.handleSessionRound,
  "POST /api/report": focusGroup.handleReport,
  "POST /api/quick-fill": focusGroup.handleQuickFill,
};

const server = http.createServer(async (req, res) => {
  try {
    const route = routes[`${req.method} ${req.url}`];
    if (route) {
      return await route(req, res, sendJson);
    }

    if (req.method === "GET" && req.url === "/api/health") {
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

    if (req.method === "GET" && req.url === "/api/config") {
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
        search: searchClient.getStatus(),
      });
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    return serveStatic(ROOT, req, res);
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    console.error(error);
    return sendJson(res, 502, { error: "AI service error", detail: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`\nFocus Group MVP running at http://localhost:${PORT}`);
  console.log(`  Provider : ${activeProvider.name} (${activeProviderName}) [format: ${activeProvider.format}]`);
  console.log(`  Endpoint : ${activeProvider.endpoint || "(none)"}`);
  console.log(`  Model    : ${activeProvider.model || "(none)"}`);
  if (activeProvider.requiresKey) {
    console.log(`  API Key  : ${activeProvider.apiKey ? "✓ loaded" : "✗ MISSING — set apiKey in config/api.config.local.json"}`);
  } else {
    console.log("  API Key  : (not required)");
  }
  const searchStatus = searchClient.getStatus();
  console.log(`  Search   : ${searchStatus.enabled ? "enabled" : "disabled"}${searchStatus.provider ? ` (${searchStatus.provider})` : ""}${searchStatus.hasKey ? " [key loaded]" : ""}`);
  console.log(`  Available providers: ${Object.keys(providers).join(", ")}\n`);
});
