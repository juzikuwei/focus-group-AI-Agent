const fs = require("fs");
const path = require("path");

function loadApiConfig(root) {
  const configPath = path.join(root, "config", "api.config.json");
  const localConfigPath = path.join(root, "config", "api.config.local.json");
  const baseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

  if (!fs.existsSync(localConfigPath)) {
    return baseConfig;
  }

  const localConfig = JSON.parse(fs.readFileSync(localConfigPath, "utf8"));
  return mergeApiConfig(baseConfig, localConfig);
}

function loadSearchConfig(root) {
  const configPath = path.join(root, "config", "search.config.json");
  const localConfigPath = path.join(root, "config", "search.config.local.json");
  if (!fs.existsSync(configPath)) {
    return { enabled: false, active: "", providers: {} };
  }

  const baseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!fs.existsSync(localConfigPath)) {
    return baseConfig;
  }

  const localConfig = JSON.parse(fs.readFileSync(localConfigPath, "utf8"));
  return mergeProviderConfig(baseConfig, localConfig);
}

function buildProviders(config) {
  return Object.fromEntries(
    Object.entries(config.providers || {})
      .filter(([key]) => !key.startsWith("_") && !key.startsWith("$"))
      .map(([key, provider]) => [
        key,
        {
          name: provider.name || key,
          format: provider.format || "openai",
          endpoint: provider.endpoint || "",
          textEndpoint: provider._textEndpoint || provider.textEndpoint || "",
          model: provider.model || "",
          apiKey: provider.apiKey || "",
          requiresKey: provider.requiresKey !== false,
          supportsJsonMode: provider.supportsJsonMode !== false,
        },
      ]),
  );
}

function buildSearchProviders(config) {
  return Object.fromEntries(
    Object.entries(config.providers || {})
      .filter(([key]) => !key.startsWith("_") && !key.startsWith("$"))
      .map(([key, provider]) => [
        key,
        {
          name: provider.name || key,
          format: provider.format || key,
          endpoint: provider.endpoint || "",
          apiKey: provider.apiKey || "",
          requiresKey: provider.requiresKey !== false,
          searchDepth: provider.searchDepth || provider.search_depth || "advanced",
          chunksPerSource: Number(provider.chunksPerSource || provider.chunks_per_source || 2),
          maxResultsPerQuery: Number(provider.maxResultsPerQuery || provider.max_results_per_query || config.maxResultsPerQuery || 5),
          includeRawContent: provider.includeRawContent || provider.include_raw_content || false,
          includeAnswer: provider.includeAnswer !== false,
          country: provider.country || "",
        },
      ]),
  );
}

function resolveActiveProviderName(config, providerMap) {
  const configuredName = config.active || config.activeProvider;
  if (configuredName && providerMap[configuredName]) return configuredName;

  const firstProvider = Object.keys(providerMap)[0];
  if (!firstProvider) {
    throw new Error("没有可用的 API provider。请检查 config/api.config.json。");
  }

  if (configuredName) {
    console.warn(`Provider "${configuredName}" 不存在，已回退到 "${firstProvider}"。`);
  }
  return firstProvider;
}

function resolveActiveSearchProviderName(config, providerMap) {
  const configuredName = config.active || config.activeProvider;
  if (configuredName && providerMap[configuredName]) return configuredName;
  return Object.keys(providerMap)[0] || "";
}

function mergeApiConfig(baseConfig, localConfig) {
  return mergeProviderConfig(baseConfig, localConfig);
}

function mergeProviderConfig(baseConfig, localConfig) {
  return {
    ...baseConfig,
    ...localConfig,
    providers: {
      ...(baseConfig.providers || {}),
      ...Object.fromEntries(
        Object.entries(localConfig.providers || {}).map(([key, localProvider]) => [
          key,
          {
            ...((baseConfig.providers || {})[key] || {}),
            ...localProvider,
          },
        ]),
      ),
    },
  };
}

module.exports = {
  buildSearchProviders,
  loadApiConfig,
  loadSearchConfig,
  buildProviders,
  resolveActiveProviderName,
  resolveActiveSearchProviderName,
};
