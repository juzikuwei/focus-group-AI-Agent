/* ============================================================
   DOM rendering: personas, chat log, evidence pack, report
   ============================================================ */

import { $, state } from "./app-state.js";
import { escapeHtml, escapeAttr, markdownToHtml } from "./app-markdown.js";

export function renderPersonaGrid(container, personas) {
  if (!personas.length) {
    container.className = container.className.replace("persona-grid-compact", "").trim();
    container.classList.add("persona-grid", "empty-state-soft");
    container.innerHTML = "<p>暂无受访者</p>";
    return;
  }
  container.classList.remove("empty-state-soft");
  if (!container.classList.contains("persona-grid")) container.classList.add("persona-grid");
  container.innerHTML = personas
    .map((persona, index) => personaCardHtml(persona, index))
    .join("");
}

function personaCardHtml(persona, index) {
  return `
    <article class="persona-card" data-color="${index % 9}">
      <header class="persona-head">
        <div class="avatar">${escapeHtml(avatarChar(persona.name))}</div>
        <div class="persona-id">
          <strong>${escapeHtml(persona.name)}</strong>
          <span class="segment">${escapeHtml(persona.segment)}</span>
        </div>
        <span class="age-pill">${Number(persona.age) || 30} 岁</span>
      </header>
      <p class="persona-bio">${escapeHtml(persona.job)}，收入${escapeHtml(persona.income)}。${escapeHtml(persona.motivation)}。</p>
      <div class="persona-depth">
        ${personaInsight("场景", persona.usageScenario)}
        ${personaInsight("标准", persona.decisionCriteria)}
        ${personaInsight("阻碍", persona.dealBreaker)}
      </div>
      <div class="metric-list">
        ${metric("价格敏感", persona.priceSensitivity, "var(--rose)")}
        ${metric("尝鲜意愿", persona.adoption, "var(--green)")}
        ${metric("怀疑程度", persona.skepticism, "var(--amber)")}
      </div>
      <p class="persona-style">"${escapeHtml(persona.speakingStyle)}"</p>
      <div class="tag-row">
        ${(persona.concerns || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
      </div>
    </article>
  `;
}

function personaInsight(label, value) {
  if (!value) return "";
  return `
    <div class="persona-insight">
      <span>${label}</span>
      <p>${escapeHtml(value)}</p>
    </div>
  `;
}

function metric(label, value, color) {
  const v = Number(value) || 0;
  return `
    <div class="metric">
      <span>${label}</span>
      <div class="meter"><span style="width:${v}%;background:${color}"></span></div>
      <b>${v}</b>
    </div>
  `;
}

function avatarChar(name) {
  const trimmed = String(name || "").trim();
  return trimmed ? trimmed.charAt(0) : "?";
}

function personaColorIndex(personasArray, name) {
  const idx = personasArray.findIndex((p) => p.name === name);
  return idx >= 0 ? idx % 9 : 0;
}

export function renderChatLog(container, messages) {
  if (!messages.length) {
    container.classList.add("empty-state-soft");
    container.innerHTML = "<p>访谈尚未开始</p>";
    return;
  }
  container.classList.remove("empty-state-soft");
  let lastRound = 0;
  container.innerHTML = messages
    .map((message) => {
      const divider =
        message.round !== lastRound
          ? `<div class="round-divider">第 ${message.round} 轮讨论</div>`
          : "";
      lastRound = message.round;
      const isModerator = message.type === "moderator";
      const isError = message.segment === "解析失败";
      const colorIdx = isModerator
        ? ""
        : ` data-color="${personaColorIndex(state.personas, message.speaker)}"`;
      const cls = isError ? "message error" : `message${isModerator ? " moderator" : ""}`;
      return `
        ${divider}
        <article class="${cls}">
          <div class="avatar sm"${colorIdx}>${escapeHtml(avatarChar(message.speaker))}</div>
          <div class="bubble">
            <header class="bubble-head">
              <strong>${escapeHtml(message.speaker)}</strong>
              <span class="segment-tag">${escapeHtml(message.segment)}</span>
            </header>
            <p>${escapeHtml(message.text)}</p>
          </div>
        </article>
      `;
    })
    .join("");
}

export function scrollChatPreviewToBottom() {
  const el = $("previewChat");
  if (el) el.scrollTop = el.scrollHeight;
}

export function renderEvidencePackHtml(pack) {
  const cards = Array.isArray(pack.sourceCards) ? pack.sourceCards : [];
  const stat = (label, value) => `
    <div class="evidence-stat">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;

  return `
    <div class="evidence-summary">
      ${stat("状态", pack.status || "used")}
      ${stat("来源卡片", `${cards.length} 个`)}
      ${stat("生成日期", pack.generatedAt || "-")}
    </div>
    ${pack.stimulusScript ? `
      <section class="evidence-block">
        <h4>主持人材料说明</h4>
        <ul class="evidence-list"><li>${escapeHtml(pack.stimulusScript)}</li></ul>
      </section>
    ` : ""}
    ${renderEvidenceList("市场模式", pack.marketPatterns)}
    ${renderEvidenceList("常见抱怨", pack.commonComplaints)}
    ${renderEvidenceList("购买阻力", pack.purchaseBarriers)}
    ${renderEvidenceList("访谈需验证问题", pack.openQuestions)}
    <section class="evidence-block">
      <h4>来源卡片</h4>
      <div class="source-card-list">
        ${cards.map(renderSourceCard).join("") || "<p class=\"muted\">没有来源卡片。</p>"}
      </div>
    </section>
  `;
}

function renderEvidenceList(title, items) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!safeItems.length) return "";
  return `
    <section class="evidence-block">
      <h4>${escapeHtml(title)}</h4>
      <ul class="evidence-list">
        ${safeItems.slice(0, 10).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function renderSourceCard(card, index) {
  const title = card.title || `来源 ${index + 1}`;
  const id = card.id || `S${index + 1}`;
  const url = card.url || "";
  const titleHtml = url
    ? `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(id)}｜${escapeHtml(title)}</a>`
    : `${escapeHtml(id)}｜${escapeHtml(title)}`;

  return `
    <article class="source-card">
      <div class="source-card-head">
        <h5 class="source-card-title">${titleHtml}</h5>
        <span class="source-card-meta">${escapeHtml(card.reliability || "medium")}</span>
      </div>
      <div class="source-card-columns">
        ${renderSourceCardList("关键事实", card.keyFacts)}
        ${renderSourceCardList("用户信号", card.userSignals)}
      </div>
      ${renderSourceCardList("展示片段", card.quoteSnippets)}
    </article>
  `;
}

function renderSourceCardList(title, items) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!safeItems.length) return "";
  return `
    <div class="evidence-block">
      <h4>${escapeHtml(title)}</h4>
      <ul class="evidence-list">
        ${safeItems.slice(0, 5).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </div>
  `;
}

export function renderRunReport(project) {
  const content = $("reportContent");
  const pending = $("reportPendingWrap");
  const actions = $("runReportActions");
  if (!content || !pending || !actions) return;

  const data = project || {
    name: undefined,
    personas: state.personas,
    messages: state.messages,
    reportMarkdown: state.reportMarkdown,
  };

  const hasReport = Boolean(data.reportMarkdown);
  content.hidden = !hasReport;
  actions.hidden = !hasReport;
  pending.hidden = hasReport;
  if (hasReport) {
    renderReportContent(content, data);
  }
}

function renderReportContent(container, data) {
  const personas = data.personas || [];
  const messages = data.messages || [];
  const markdown = data.reportMarkdown || "";

  if (!markdown) {
    container.classList.add("empty-state-soft");
    container.innerHTML = "<p>本项目尚未生成报告</p>";
    return;
  }
  container.classList.remove("empty-state-soft");

  const rounds = new Set(messages.map((m) => m.round)).size;
  const avgPrice = personas.length
    ? Math.round(personas.reduce((s, p) => s + (Number(p.priceSensitivity) || 0), 0) / personas.length)
    : 0;

  const signals = `
    <div class="signal-row">
      <div class="signal"><span>受访者</span><strong>${personas.length}</strong></div>
      <div class="signal"><span>讨论轮次</span><strong>${rounds}</strong></div>
      <div class="signal"><span>平均价格敏感</span><strong>${avgPrice}</strong></div>
    </div>
  `;
  container.innerHTML = signals + markdownToHtml(markdown);
}

export function updateEvidencePackButton() {
  const btn = $("viewEvidencePackBtn");
  if (!btn) return;
  btn.hidden = !hasUsableEvidencePack();
}

export function hasUsableEvidencePack() {
  const pack = state.evidencePack;
  return Boolean(pack && pack.status === "used" && Array.isArray(pack.sourceCards) && pack.sourceCards.length);
}
