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
  "POST /api/session": focusGroup.handleSession,
  "POST /api/session/round": focusGroup.handleSessionRound,
  "POST /api/report": focusGroup.handleReport,
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
    if (error.name === "AbortError") {
      if (!res.writableEnded && !res.destroyed) {
        return sendJson(res, 499, { error: "Request cancelled" });
      }
      return undefined;
    }
    if (error.statusCode && error.statusCode < 500) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    if (isSafeConfigError(error)) {
      return sendJson(res, 400, { error: error.message });
    }
    console.error(error);
    return sendJson(res, 502, { error: "AI 服务调用失败，请检查服务端日志或稍后重试。" });
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

function isSafeConfigError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("没有配置 endpoint") ||
    (message.includes("缺少") && message.includes("API Key"))
  );
}
