const SYSTEM_JSON = "你是一个严谨的 JSON API。必须只输出合法 JSON 对象，不要输出解释、Markdown 或代码块。";
const SYSTEM_TEXT = "你是一个严谨的中文市场研究模拟系统。遵守用户要求的输出格式。";
const DEFAULT_LLM_TIMEOUT_MS = 240_000;

function createLlmClient({ activeProvider, activeProviderName }) {
  function assertProviderReady() {
    if (!activeProvider.endpoint) {
      throw new Error(`Provider ${activeProvider.name} 没有配置 endpoint。请编辑 config/api.config.json。`);
    }
    if (activeProvider.requiresKey && !activeProvider.apiKey) {
      throw new Error(`缺少 ${activeProvider.name} 的 API Key。请在 config/api.config.local.json 里把 providers.${activeProviderName}.apiKey 填上，然后重启服务。`);
    }
  }

  async function callJson(prompt, temperature, options = {}) {
    const text = await callText(prompt, temperature, true, options);
    try {
      return parseJsonFromText(text);
    } catch (error) {
      console.warn(`[AI JSON repair] ${options.label || "json"} initial output was not valid JSON (${error.message}); issuing one repair call.`);
      const repaired = await callText(
        `请修复下面这个 JSON，使它成为一个合法 JSON 对象。
只输出修复后的 JSON，不要解释，不要 Markdown。
如果内容在末尾被截断，请尽量保留已经完整的数组元素，并补齐必要的括号；不要补写长篇新内容。

待修复内容：
${text}`,
        0.1,
        true,
        {
          label: `${options.label || "json"}.repair`,
          maxTokens: options.repairMaxTokens || Math.min(Math.max((options.maxTokens || 3000) * 2, 3600), 8000),
        },
      );
      return parseJsonFromText(repaired);
    }
  }

  async function callText(prompt, temperature, forceJson = false, options = {}) {
    const format = activeProvider.format || "openai";
    const startedAt = Date.now();
    const label = options.label || (forceJson ? "json" : "text");
    try {
      let content;
      if (format === "anthropic") {
        content = await callAnthropic(prompt, temperature, forceJson, options);
      } else if (format === "gemini") {
        content = await callGemini(prompt, temperature, forceJson, options);
      } else {
        content = await callOpenAICompatible(prompt, temperature, forceJson, options);
      }
      logModelTiming({ label, prompt, content, startedAt, forceJson, maxTokens: options.maxTokens });
      return content;
    } catch (error) {
      logModelTiming({ label, prompt, error, startedAt, forceJson, maxTokens: options.maxTokens });
      throw error;
    }
  }

  async function callOpenAICompatible(prompt, temperature, forceJson, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (activeProvider.apiKey) {
      headers.Authorization = `Bearer ${activeProvider.apiKey}`;
    }

    const requestBody = {
      model: activeProvider.model,
      messages: [
        { role: "system", content: forceJson ? SYSTEM_JSON : SYSTEM_TEXT },
        { role: "user", content: prompt },
      ],
      temperature,
      stream: false,
    };

    if (options.maxTokens) {
      requestBody.max_tokens = options.maxTokens;
    }

    if (forceJson && activeProvider.supportsJsonMode !== false) {
      requestBody.response_format = { type: "json_object" };
    }

    const data = await fetchWithRetry(activeProvider.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, { label: options.label });

    const message = data.choices?.[0]?.message;
    const content =
      message?.content ||
      message?.reasoning_content ||
      message?.reasoning ||
      data.choices?.[0]?.text ||
      "";
    if (!content) throw new Error(`${activeProvider.name} API returned an empty message`);
    return content;
  }

  async function callAnthropic(prompt, temperature, forceJson, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": activeProvider.apiKey,
      "anthropic-version": "2023-06-01",
    };

    const requestBody = {
      model: activeProvider.model,
      max_tokens: options.maxTokens || 4096,
      system: forceJson ? SYSTEM_JSON : SYSTEM_TEXT,
      messages: [{ role: "user", content: prompt }],
      temperature,
    };

    const data = await fetchWithRetry(activeProvider.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, { label: options.label });

    const blocks = Array.isArray(data.content) ? data.content : [];
    const content = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!content) throw new Error(`${activeProvider.name} API returned an empty message`);
    return content;
  }

  async function callGemini(prompt, temperature, forceJson, options = {}) {
    const url = `${activeProvider.endpoint.replace(/\/$/, "")}/${encodeURIComponent(activeProvider.model)}:generateContent?key=${encodeURIComponent(activeProvider.apiKey)}`;

    const requestBody = {
      systemInstruction: {
        parts: [{ text: forceJson ? SYSTEM_JSON : SYSTEM_TEXT }],
      },
      contents: [
        { role: "user", parts: [{ text: prompt }] },
      ],
      generationConfig: {
        temperature,
        ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        ...(forceJson && activeProvider.supportsJsonMode !== false
          ? { responseMimeType: "application/json" }
          : {}),
      },
    };

    const data = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }, { label: options.label });

    const parts = data.candidates?.[0]?.content?.parts || [];
    const content = parts.map((p) => p.text || "").join("").trim();
    if (!content) throw new Error(`${activeProvider.name} API returned an empty message`);
    return content;
  }

  async function fetchWithRetry(url, options, meta = {}) {
    let response;
    let body = "";
    const timeoutMs = getEnvTimeout("FOCUS_GROUP_LLM_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS, 15_000, 600_000);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        response = await fetchWithTimeout(url, options, timeoutMs);
      } catch (error) {
        if (error.name === "TimeoutError") {
          throw new Error(`${activeProvider.name} API timeout after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw error;
      }
      if (response.ok) {
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          if (text.trim().startsWith("data:") || text.includes("\ndata:")) {
            return parseSseToOpenAIShape(text);
          }
          throw new Error(`${activeProvider.name} returned non-JSON response: ${text.slice(0, 200)}`);
        }
      }
      body = await response.text();
      if (response.status !== 429 || attempt === 4) {
        throw new Error(`${activeProvider.name} API ${response.status}: ${body.slice(0, 500)}`);
      }
      console.warn(`[AI retry] ${meta.label || "request"} got 429 on attempt ${attempt}; waiting ${2500 * attempt}ms.`);
      await wait(2500 * attempt);
    }
    throw new Error(`${activeProvider.name} API exhausted retries`);
  }

  return {
    assertProviderReady,
    callJson,
    callText,
  };
}

function parseSseToOpenAIShape(text) {
  let content = "";
  let role = "assistant";
  let lastFullMessage = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.message?.content) {
      lastFullMessage = choice.message;
    }
    const delta = choice.delta || {};
    if (delta.role) role = delta.role;
    if (typeof delta.content === "string") content += delta.content;
  }
  if (lastFullMessage) {
    return { choices: [{ message: lastFullMessage }] };
  }
  return { choices: [{ message: { role, content } }] };
}

function parseJsonFromText(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Model did not return JSON");
    }
    return JSON.parse(match[0]);
  }
}

function logModelTiming({ label, prompt, content = "", error = null, startedAt, forceJson, maxTokens }) {
  const durationMs = Date.now() - startedAt;
  const status = error ? "failed" : "ok";
  const parts = [
    `[AI ${status}]`,
    label,
    `${durationMs}ms`,
    `prompt=${String(prompt || "").length} chars`,
    `output=${String(content || "").length} chars`,
    `json=${forceJson ? "yes" : "no"}`,
  ];
  if (maxTokens) parts.push(`maxTokens=${maxTokens}`);
  if (error) parts.push(`error=${String(error.message || error).slice(0, 160)}`);
  console.log(parts.join(" | "));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  createLlmClient,
  parseJsonFromText,
};
