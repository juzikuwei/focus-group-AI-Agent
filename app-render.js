/* ============================================================
   DOM rendering: personas, chat log, evidence pack, report
   ============================================================ */

import { $, state } from "./app-state.js";
import { escapeHtml, markdownToHtml } from "./app-markdown.js";

const RADAR_LABELS = ["价格敏感", "创新开放", "品牌忠诚", "理性决策", "社交影响", "使用频率"];
const RADAR_SIDES = 6;
const RADAR_CX = 180;
const RADAR_CY = 160;
const RADAR_R = 100;
const RADAR_LEVELS = 5;

function buildRadarMetrics(persona) {
  if (persona.radarMetrics && persona.radarMetrics.length === RADAR_SIDES) {
    return persona.radarMetrics.map((v) => Math.max(1, Math.min(10, Number(v) || 5)));
  }
  const sensitivity = Number(persona.priceSensitivity);
  const priceScore = Number.isNaN(sensitivity) ? 5 : Math.round(sensitivity / 10);
  const segment = String(persona.segment || "").toLowerCase();
  const bio = String(persona.snapshot || persona.bio || "").toLowerCase();
  const text = segment + " " + bio;
  const innovation = /创新|尝鲜|新潮|科技|极客/.test(text) ? 8 : /保守|传统|稳健/.test(text) ? 3 : 5;
  const loyalty = /品牌|忠诚|固定|习惯/.test(text) ? 7 : /随意|无所谓|换着用/.test(text) ? 3 : 5;
  const rational = /理性|分析|数据|对比|研究/.test(text) ? 8 : /感性|冲动|直觉|跟风/.test(text) ? 3 : 6;
  const social = /社交|分享|推荐|影响|kol|意见领袖/.test(text) ? 8 : /独来独往|不太分享/.test(text) ? 3 : 5;
  const frequency = /每天|高频|日常|经常/.test(text) ? 8 : /偶尔|很少|几乎不/.test(text) ? 3 : 6;
  return [priceScore, innovation, loyalty, rational, social, frequency];
}

function radarSvg(metrics, colorIdx) {
  const angleStep = (2 * Math.PI) / RADAR_SIDES;
  const startAngle = -Math.PI / 2;
  const colors = [
    ["#2f6cff", "rgba(47,108,255,0.12)"],
    ["#ef4444", "rgba(239,68,68,0.10)"],
    ["#f59e0b", "rgba(245,158,11,0.10)"],
    ["#6366f1", "rgba(99,102,241,0.10)"],
    ["#10b981", "rgba(16,185,129,0.10)"],
    ["#8b5cf6", "rgba(139,92,246,0.10)"],
    ["#06b6d4", "rgba(6,182,212,0.10)"],
    ["#84cc16", "rgba(132,204,22,0.10)"],
    ["#ec4899", "rgba(236,72,153,0.10)"],
  ];
  const [stroke, fill] = colors[colorIdx % colors.length];

  const point = (index, ratio) => {
    const angle = startAngle + index * angleStep;
    return [
      RADAR_CX + RADAR_R * ratio * Math.cos(angle),
      RADAR_CY + RADAR_R * ratio * Math.sin(angle),
    ];
  };

  const gridPaths = [];
  for (let level = 1; level <= RADAR_LEVELS; level++) {
    const ratio = level / RADAR_LEVELS;
    const pts = [];
    for (let i = 0; i < RADAR_SIDES; i++) pts.push(point(i, ratio));
    gridPaths.push(`<polygon points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="rgba(200,210,225,0.4)" stroke-width="0.8"/>`);
  }

  const axisLines = [];
  for (let i = 0; i < RADAR_SIDES; i++) {
    const [x, y] = point(i, 1);
    axisLines.push(`<line x1="${RADAR_CX}" y1="${RADAR_CY}" x2="${x}" y2="${y}" stroke="rgba(200,210,225,0.35)" stroke-width="0.6"/>`);
  }

  const dataPts = metrics.map((v, i) => point(i, v / 10));
  const dataPolygon = `<polygon points="${dataPts.map((p) => p.join(",")).join(" ")}" fill="${fill}" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round"/>`;
  const dots = dataPts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.5" fill="${stroke}" stroke="none"/>`).join("");

  const dataDots = dataPts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.5" fill="${stroke}" stroke="none"/>`).join("");

  const labels = RADAR_LABELS.map((label, i) => {
    const [x, y] = point(i, 1.18);
    const anchor = x < RADAR_CX - 8 ? "end" : x > RADAR_CX + 8 ? "start" : "middle";
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central" fill="#3d5070" font-size="14" font-weight="700">${label}</text>`;
  }).join("");

  return `<svg class="persona-radar" viewBox="0 0 360 320">${gridPaths.join("")}${axisLines.join("")}${dataPolygon}${dataDots}${labels}</svg>`;
}

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
  const concerns = persona.concerns || [];
  const role = persona.discussionRole || "真实用户";
  const current = persona.currentAlternative || persona.usageScenario || "";
  const trigger = persona.switchTrigger || persona.decisionCriteria || "";
  const budget = persona.budgetAnchor || legacyBudgetAnchor(persona);
  const evidence = persona.evidenceNeeded || persona.dealBreaker || "";
  const metrics = buildRadarMetrics(persona);
  const seq = index + 1;

  return `
    <article class="persona-card" data-color="${index % 9}" data-persona-index="${index}">
      <div class="persona-header">
        <div class="avatar">${escapeHtml(avatarChar(persona.name))}</div>
        <div class="persona-info">
          <strong class="persona-name"><span class="persona-seq">${seq}</span>${escapeHtml(persona.name)}</strong>
          <span class="persona-role">${escapeHtml(role)}</span>
        </div>
        ${state.isViewOnly ? '' : `<button class="persona-edit-btn ghost compact-btn" type="button" data-action="edit-persona" data-index="${index}">编辑</button>`}
      </div>
      <div class="persona-radar-wrap">
        ${radarSvg(metrics, index)}
      </div>
      <div class="persona-body">
        <p class="persona-segment">${escapeHtml(persona.segment)}</p>
        <p class="persona-bio">${escapeHtml(persona.snapshot || buildLegacyPersonaBio(persona))}</p>
      </div>
      ${concerns.length ? `<div class="tag-row">${concerns.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <div class="persona-stats">
        ${personaStat("当前方案", current)}
        ${personaStat("核心顾虑", trigger)}
        ${personaStat("价格锚点", budget)}
        ${personaStat("决策关键", evidence)}
      </div>
      ${persona.speakingStyle ? `<p class="persona-style">${escapeHtml(persona.speakingStyle)}</p>` : ""}
    </article>
  `;
}

function personaStat(label, value) {
  if (!value) return "";
  return `<div class="persona-stat"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function buildLegacyPersonaBio(persona) {
  return [
    persona.age ? `${Number(persona.age)} 岁` : "",
    persona.job,
    persona.motivation,
  ]
    .filter(Boolean)
    .join("，") || "目标用户，关注真实使用价值";
}

function legacyBudgetAnchor(persona) {
  const sensitivity = Number(persona.priceSensitivity);
  if (Number.isNaN(sensitivity)) return "";
  if (sensitivity >= 75) return "必须接近日常替代成本";
  if (sensitivity <= 35) return "愿为确定价值付溢价";
  return "对照现有替代方案判断";
}

function avatarChar(name) {
  const trimmed = String(name || "").trim();
  return trimmed ? trimmed.charAt(0) : "?";
}

function buildPersonaColorMap(personasArray) {
  const map = new Map();
  (personasArray || []).forEach((persona, idx) => {
    if (persona?.name) map.set(persona.name, idx % 9);
  });
  return map;
}

export function renderChatLog(container, messages) {
  if (!messages.length) {
    container.classList.add("empty-state-soft");
    container.innerHTML = "<p>访谈尚未开始</p>";
    return;
  }
  container.classList.remove("empty-state-soft");
  const colorMap = buildPersonaColorMap(state.personas);
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
        : ` data-color="${colorMap.get(message.speaker) ?? 0}"`;
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
  const url = safeExternalUrl(card.url || "");
  const titleHtml = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(id)}｜${escapeHtml(title)}</a>`
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

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""), window.location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
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
  const isStreaming = !project && state.reportStreaming;
  content.hidden = !hasReport;
  actions.hidden = !hasReport || isStreaming;
  pending.hidden = hasReport && !isStreaming;
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
  const roleCount = new Set(personas.map((p) => p.discussionRole || p.segment).filter(Boolean)).size;

  const signals = `
    <div class="report-signals">
      <div class="report-signal"><span>受访者</span><strong>${personas.length}</strong></div>
      <div class="report-signal"><span>讨论轮次</span><strong>${rounds}</strong></div>
      <div class="report-signal"><span>讨论角色</span><strong>${roleCount}</strong></div>
    </div>
  `;
  container.innerHTML = signals + markdownToHtml(markdown);
  addChartBars(container);
}

/** Post-process tables: add CSS bar charts for cells containing percentages or scores */
function addChartBars(container) {
  container.querySelectorAll("table").forEach((table) => {
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    if (rows.length < 2) return;

    rows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      cells.forEach((td) => {
        const text = td.textContent.trim();
        // Match patterns like "85%", "3.5/5", "4.2 分", "8人"
        const pctMatch = text.match(/^(\d+(?:\.\d+)?)%$/);
        if (pctMatch) {
          const val = parseFloat(pctMatch[1]);
          td.classList.add("bar-cell");
          td.innerHTML = `<span class="bar-label">${text}</span><div class="bar-track"><div class="bar-fill" style="--bar-width: ${Math.min(val, 100)}%"></div></div>`;
          return;
        }
        const scoreMatch = text.match(/^(\d+(?:\.\d+)?)\s*[\/分]/);
        if (scoreMatch) {
          const val = parseFloat(scoreMatch[1]);
          const maxVal = text.includes("/") ? parseFloat(text.split("/")[1]) : 5;
          const pct = Math.round((val / maxVal) * 100);
          td.classList.add("bar-cell");
          td.innerHTML = `<span class="bar-label">${text}</span><div class="bar-track"><div class="bar-fill" style="--bar-width: ${Math.min(pct, 100)}%"></div></div>`;
        }
      });
    });
  });
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
