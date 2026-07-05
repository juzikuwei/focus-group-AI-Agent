/* ============================================================
   API + toast helpers
   ============================================================ */

export const LOCAL_SETTINGS_KEY = "focus-group-local-settings";

export function getLocalSettings() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_SETTINGS_KEY) || "null") || {};
  } catch {
    return {};
  }
}

export function saveLocalSettings(settings) {
  localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(settings || {}));
}

export function clientSettingsHeaders() {
  const settings = getLocalSettings();
  const headers = {};
  const pairs = [
    ["apiProvider", "X-FG-API-Provider"],
    ["apiKey", "X-FG-API-Key"],
    ["apiBaseUrl", "X-FG-API-Base-URL"],
    ["model", "X-FG-API-Model"],
    ["searchProvider", "X-FG-Search-Provider"],
    ["searchApiKey", "X-FG-Search-API-Key"],
  ];
  pairs.forEach(([key, header]) => {
    const value = String(settings[key] || "").trim();
    if (value) headers[header] = value;
  });
  return headers;
}

export async function postJson(url, payload, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...clientSettingsHeaders() },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || data.error || `Request failed: ${response.status}`);
  }
  return data;
}

export async function postJsonStream(url, payload, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...clientSettingsHeaders() },
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || data.error || `Request failed: ${response.status}`);
  }

  if (!response.body?.getReader) {
    const data = await response.json().catch(() => ({}));
    if (data.markdown) options.onEvent?.({ type: "done", markdown: data.markdown });
    return data;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalEvent = null;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      console.warn("[stream] skipping non-JSON NDJSON line:", trimmed.slice(0, 200));
      return;
    }
    finalEvent = event;
    options.onEvent?.(event);
    if (event.type === "error") {
      throw new Error(event.error || "Stream failed");
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    lines.forEach(processLine);
  }

  buffer += decoder.decode();
  buffer.split(/\r?\n/).forEach(processLine);
  return finalEvent || {};
}

export function showToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 2200);
}
