/* ============================================================
   Focus Group Simulator — App entry
   ============================================================ */

import {
  $,
  state,
  defaultData,
  fields,
  getConfig,
  getRawConfig,
  setConfig,
  buildTopics,
  getCompletedRoundCount,
  formatDate,
} from "./app-state.js";
import {
  RECENT_DISPLAY,
  saveDraft,
  loadDraft,
  loadProjects,
  deleteProjectById,
  getProjectById,
  newProjectId,
  persistCurrent,
  loadProjectIntoState,
} from "./app-storage.js";
import { postJson, showToast } from "./app-api.js";
import { escapeHtml, escapeAttr } from "./app-markdown.js";
import {
  renderPersonaGrid,
  renderChatLog,
  renderEvidencePackHtml,
  renderRunReport,
  scrollChatPreviewToBottom,
  updateEvidencePackButton,
  hasUsableEvidencePack,
} from "./app-render.js";
import { copyReport, downloadReport } from "./app-export.js";

const RUN_PANELS = ["personas", "session", "report"];

/* ============================================================
   View switching
   ============================================================ */

function setView(name) {
  state.view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const target = $("view" + name.charAt(0).toUpperCase() + name.slice(1));
  if (target) target.classList.add("active");
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* ============================================================
   Recent projects rendering
   ============================================================ */

function renderRecentProjects() {
  const grid = $("recentGrid");
  const projects = loadProjects().slice(0, RECENT_DISPLAY);

  if (!projects.length) {
    grid.className = "recent-grid empty-state-soft";
    grid.innerHTML = `<p>还没有保存的项目。完成一次访谈或在主界面保存草稿后，会出现在这里。</p>`;
    return;
  }

  grid.className = "recent-grid";
  grid.innerHTML = projects
    .map((project) => {
      const date = formatDate(project.updatedAt || project.createdAt);
      const isDone = project.status === "completed";
      const statusBadge = isDone
        ? `<span class="badge badge-success">已完成</span>`
        : `<span class="badge badge-muted">草稿</span>`;
      const concept = (project.config?.productConcept || "").slice(0, 64);
      const personasCount = (project.personas || []).length;
      const messageCount = (project.messages || []).length;
      return `
        <article class="recent-card" data-id="${escapeAttr(project.id)}">
          <header class="recent-card-head">
            ${statusBadge}
            <button class="recent-delete" type="button" data-action="delete" data-id="${escapeAttr(project.id)}" aria-label="删除项目">×</button>
          </header>
          <h3 class="recent-name">${escapeHtml(project.name || "未命名项目")}</h3>
          <p class="recent-concept">${escapeHtml(concept)}${concept.length >= 64 ? "…" : ""}</p>
          <footer class="recent-meta">
            <span>${date}</span>
            <span>${personasCount} 人 · ${messageCount} 条记录</span>
          </footer>
        </article>
      `;
    })
    .join("");

  grid.querySelectorAll(".recent-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action='delete']")) return;
      const id = card.dataset.id;
      handleRecentClick(id);
    });
  });

  grid.querySelectorAll("[data-action='delete']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (confirm("确定删除该项目？此操作不可撤销。")) {
        deleteProjectById(id);
        renderRecentProjects();
        showToast("项目已删除");
      }
    });
  });
}

function handleRecentClick(id) {
  const project = getProjectById(id);
  if (!project) {
    showToast("项目不存在或已被删除");
    renderRecentProjects();
    return;
  }
  loadProjectIntoState(project);
  if ((project.personas || []).length || (project.messages || []).length) {
    restoreDraftRunView(project);
  } else {
    showToast("草稿已恢复，可继续编辑");
    setView("home");
  }
}

function restoreDraftRunView(project) {
  const config = getConfig();
  state.isRunning = false;
  state.abortController = null;
  state.lastFailedSubStage = null;
  state.runToken += 1;
  stopRunTimer();

  $("runProjectName").textContent = config.projectName || project.name || "访谈草稿";
  resetStages();
  hideAllControlPanels();
  setSpinnerVisible(false);
  $("runMeta").hidden = true;

  showSection("personas", state.personas.length > 0);
  showSection("session", state.personas.length > 0);
  showSection("report", false);
  renderPersonaGrid($("previewPersonas"), state.personas);
  renderChatLog($("previewChat"), state.messages);
  updateEvidencePackButton();
  renderRunReport();
  scrollChatPreviewToBottom();

  state.currentRound = Math.min(getCompletedRoundCount(state.messages), state.topics.length);
  updateRoundBadge();

  if (!state.personas.length) {
    setStage("personas", "pending");
    setRunStatus("草稿已恢复", "可返回主界面继续编辑，或重新开始访谈。");
    setActiveRunPanel("personas", { force: true });
  } else if (state.currentRound >= state.topics.length && state.messages.length && state.reportMarkdown) {
    setStage("personas", "done");
    setStage("session", "done");
    setStage("report", "done");
    showSection("report", true);
    state.runSubStage = "done";
    setRunStatusVisible(false);
    setActiveRunPanel("report");
  } else if (state.currentRound >= state.topics.length && state.messages.length) {
    setStage("personas", "done");
    setStage("session", "done");
    setStage("report", "active");
    showSection("report", true);
    state.runSubStage = "report-ready";
    setRunStatus("访谈已完成，尚未生成报告", "点击下方按钮继续生成洞察报告。");
    showReportReadyControl();
    setActiveRunPanel("session");
  } else if (state.messages.length) {
    setStage("personas", "done");
    setStage("session", "active");
    state.runSubStage = "session-step-paused";
    setRunStatus(
      stageMeta.sessionPaused.headline.replace("{round}", state.currentRound),
      "草稿已恢复，可继续下一轮深访。",
    );
    showNextRoundControl();
    $("nextRoundNumber").textContent = state.currentRound + 1;
    showControlPanel("ctrlContinueRound");
    setActiveRunPanel("session");
  } else {
    setStage("personas", "done");
    setStage("session", "active");
    state.runSubStage = "mode-choice";
    setRunStatus(stageMeta.modeChoice.headline, "草稿已恢复，受访者已生成，可继续选择访谈方式。");
    showControlPanel("ctrlModeChoice");
    setActiveRunPanel("session");
  }

  setView("running");
  showToast("草稿已恢复");
}

function showReportReadyControl() {
  showControlPanel("ctrlContinueRound");
  $("continueRoundBtn").innerHTML = "生成洞察报告 →";
  $("continueRoundBtn").dataset.action = "report";
  const pending = $("reportPendingText");
  if (pending) pending.textContent = "访谈已完成，尚未生成报告。请在访谈阶段点击生成洞察报告。";
}

function showNextRoundControl() {
  $("continueRoundBtn").innerHTML = '继续第 <span id="nextRoundNumber">2</span> 轮 →';
  $("continueRoundBtn").dataset.action = "round";
  if (state.currentRound > 0) {
    $("nextRoundNumber").textContent = state.currentRound + 1;
  }
}

/* ============================================================
   Quick fill
   ============================================================ */

async function handleQuickFill(seed) {
  const input = $("quickFillInput");
  const value = (seed || input.value).trim();
  if (!value) {
    showToast("请输入产品想法或点击示例");
    return;
  }
  if (state.isQuickFilling) return;

  state.isQuickFilling = true;
  const btn = $("quickFillBtn");
  const btnLabel = btn.querySelector(".btn-label");
  const quickFillLabels = ["理解想法中…", "搜索资料中…", "生成项目中…"];
  let labelIndex = 0;
  let labelTimerId = null;
  btn.disabled = true;
  btnLabel.textContent = quickFillLabels[labelIndex];
  labelTimerId = window.setInterval(() => {
    labelIndex = Math.min(labelIndex + 1, quickFillLabels.length - 1);
    btnLabel.textContent = quickFillLabels[labelIndex];
  }, 5000);
  input.disabled = true;

  try {
    const data = await postJson("/api/quick-fill", { seed: value });
    setConfig({ ...defaultData, ...data.config });
    saveDraft();
    const search = data.search || {};
    if (search.status === "used" && Number(search.sourceCount) > 0) {
      showToast(`已结合 ${search.sourceCount} 条公开资料生成项目初稿`);
    } else if (search.status === "failed") {
      showToast("搜索增强失败，已使用模型生成项目初稿");
    } else {
      showToast("AI 已生成项目初稿，可继续编辑");
    }
    document.querySelector(".form-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.warn(error);
    showToast(`快捷生成失败：${(error.message || "").slice(0, 80)}`);
  } finally {
    if (labelTimerId) window.clearInterval(labelTimerId);
    state.isQuickFilling = false;
    btn.disabled = false;
    btnLabel.textContent = "生成项目";
    input.disabled = false;
  }
}

/* ============================================================
   Run flow (3 stages, with manual control)
   ============================================================ */

const stageMeta = {
  personas: {
    headline: "正在召集受访者…",
    detail: "AI 正在根据你的产品概念生成多名差异化虚拟受访者，约需 10-30 秒。",
  },
  modeChoice: {
    headline: "请选择访谈方式",
    detail: "准备阶段已完成。你可以一步一轮慢慢推进，也可以直接跑完整场访谈。",
  },
  session: {
    headline: "焦点小组讨论中…",
    detail: "主持人正在按议程引导讨论，受访者按各自人设发言。这一步耗时最长，请耐心等待。",
  },
  sessionDirect: {
    headline: "直接到位模式运行中…",
    detail: "系统会先做桌面研究资料包，再一次性生成完整访谈。这一步可能需要 1-3 分钟。",
  },
  sessionStep: {
    headline: "正在进行第 {round} 轮…",
    detail: "AI 主持人会先提主问题，再根据受访者发言追问，并完成本轮小结。",
  },
  sessionPaused: {
    headline: "已完成第 {round} 轮",
    detail: "可在下方查看本轮发言。点击「继续」开始下一轮，或返回主界面暂停。",
  },
  report: {
    headline: "正在整理洞察…",
    detail: "AI 正在汇总抗性、期待和心理痛点，生成 Markdown 报告。",
  },
};

function setStage(name, status) {
  const node = $("stage" + name.charAt(0).toUpperCase() + name.slice(1));
  if (!node) return;
  node.dataset.status = status;
}

function resetStages() {
  ["personas", "session", "report"].forEach((s) => setStage(s, "pending"));
}

function setActiveRunPanel(name, options = {}) {
  if (!RUN_PANELS.includes(name)) return;
  if (!options.force && !isRunPanelAvailable(name)) {
    showToast("这个阶段还没有可查看的内容");
    return;
  }
  state.activeRunPanel = name;
  updateRunPanels();
}

function isRunPanelAvailable(name) {
  const node = $("section" + name.charAt(0).toUpperCase() + name.slice(1));
  return node?.dataset.available === "true";
}

function updateRunPanels() {
  const availablePanels = RUN_PANELS.filter(isRunPanelAvailable);
  if (!availablePanels.length) {
    RUN_PANELS.forEach((name) => {
      const section = $("section" + name.charAt(0).toUpperCase() + name.slice(1));
      const stage = $("stage" + name.charAt(0).toUpperCase() + name.slice(1));
      if (section) section.hidden = true;
      if (stage) {
        stage.dataset.available = "false";
        delete stage.dataset.viewActive;
        stage.removeAttribute("aria-current");
      }
    });
    return;
  }

  if (!availablePanels.includes(state.activeRunPanel)) {
    state.activeRunPanel = availablePanels[availablePanels.length - 1];
  }

  RUN_PANELS.forEach((name) => {
    const section = $("section" + name.charAt(0).toUpperCase() + name.slice(1));
    const stage = $("stage" + name.charAt(0).toUpperCase() + name.slice(1));
    const available = availablePanels.includes(name);
    const active = available && state.activeRunPanel === name;
    if (section) section.hidden = !active;
    if (stage) {
      stage.dataset.available = available ? "true" : "false";
      if (active) {
        stage.dataset.viewActive = "true";
        stage.setAttribute("aria-current", "step");
      } else {
        delete stage.dataset.viewActive;
        stage.removeAttribute("aria-current");
      }
    }
  });
}

function setRunStatus(headline, detail, error = false) {
  setRunStatusVisible(true);
  $("runHeadline").textContent = headline;
  $("runDetail").textContent = detail;
  $("runHeadline").classList.toggle("is-error", error);
  document.querySelector(".run-spinner").classList.toggle("is-error", error);
}

function setRunStatusVisible(visible) {
  const status = document.querySelector(".run-status");
  if (status) status.hidden = !visible;
}

function startRunTimer(label) {
  stopRunTimer();
  state.runStartedAt = Date.now();
  state.stageStartedAt = state.runStartedAt;
  state.currentStageLabel = label;
  $("runMeta").hidden = false;
  updateRunMeta();
  state.timerId = window.setInterval(updateRunMeta, 1000);
}

function setStageTimerLabel(label) {
  if (!state.runStartedAt) {
    startRunTimer(label);
    return;
  }
  state.stageStartedAt = Date.now();
  state.currentStageLabel = label;
  updateRunMeta();
}

function stopRunTimer() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
  updateRunMeta();
}

function stopDirectModeProgress() {
  if (state.directProgressTimerId) {
    window.clearInterval(state.directProgressTimerId);
    state.directProgressTimerId = null;
  }
}

function startDirectModeProgress() {
  stopDirectModeProgress();
  const startedAt = Date.now();
  const steps = [
    {
      after: 0,
      label: "规划搜索资料",
      headline: "正在规划桌面研究…",
      detail: "AI 正在根据产品概念、目标受众和议题生成搜索关键词。",
    },
    {
      after: 7000,
      label: "搜索公开资料",
      headline: "正在搜索公开资料…",
      detail: "系统正在检索竞品、价格、用户评论、常见痛点和替代方案。",
    },
    {
      after: 22000,
      label: "整理资料包",
      headline: "正在整理外部资料包…",
      detail: "AI 正在把网页结果压缩成 sourceCards、市场信号、购买阻力和可展示材料。",
    },
    {
      after: 55000,
      label: "生成完整访谈",
      headline: "正在生成完整访谈实录…",
      detail: "主持人会把资料包作为访谈前刺激材料，受访者基于人设和材料作出反应。",
    },
    {
      after: 95000,
      label: "校验访谈结构",
      headline: "正在校验访谈结构…",
      detail: "系统正在等待模型返回完整 JSON。搜索启用时，直接到位会比普通模式更慢。",
    },
  ];
  let appliedIndex = -1;

  const apply = () => {
    const elapsed = Date.now() - startedAt;
    const index = steps.reduce((result, step, stepIndex) => (elapsed >= step.after ? stepIndex : result), 0);
    if (index === appliedIndex) return;
    appliedIndex = index;
    const step = steps[index];
    setStageTimerLabel(step.label);
    setRunStatus(step.headline, step.detail);
  };

  apply();
  state.directProgressTimerId = window.setInterval(apply, 1000);
}

function updateRunMeta() {
  if (!state.runStartedAt) return;
  const now = Date.now();
  $("runElapsed").textContent = `总耗时 ${formatDuration(now - state.runStartedAt)}`;
  $("stageElapsed").textContent = `${state.currentStageLabel || "当前阶段"} ${formatDuration(now - state.stageStartedAt)}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setSpinnerVisible(visible) {
  document.querySelector(".run-spinner").style.visibility = visible ? "visible" : "hidden";
}

function showSection(name, show = true) {
  const node = $("section" + name.charAt(0).toUpperCase() + name.slice(1));
  if (!node) return;
  node.dataset.available = show ? "true" : "false";
  updateRunPanels();
}

function showControlPanel(name) {
  ["ctrlModeChoice", "ctrlContinueRound", "ctrlRetry"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = id !== name;
  });
}

function hideAllControlPanels() {
  ["ctrlModeChoice", "ctrlContinueRound", "ctrlRetry"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = true;
  });
}

async function startRun() {
  if (state.isRunning) {
    showToast("当前访谈仍在进行，请先返回并确认暂停");
    return;
  }

  const config = getConfig();
  if (!config.productConcept || !config.targetAudience) {
    showToast("请先填写产品概念和目标受众");
    return;
  }

  state.isRunning = true;
  state.abortController = new AbortController();
  state.runToken += 1;
  state.lastFailedSubStage = null;
  state.personas = [];
  state.messages = [];
  state.reportMarkdown = "";
  state.moderatorGuide = null;
  state.participantStates = [];
  state.contextState = null;
  state.evidencePack = null;
  state.topics = buildTopics(config);
  state.currentRound = 0;
  state.runMode = null;
  state.activeRunPanel = "personas";
  state.projectId = state.projectId || newProjectId();

  $("runProjectName").textContent = config.projectName || "访谈进行中";
  resetStages();
  hideAllControlPanels();
  showSection("personas", false);
  showSection("session", false);
  showSection("report", false);
  $("roundBadge").hidden = true;
  $("previewPersonas").innerHTML = "";
  $("previewChat").innerHTML = "";
  renderRunReport();
  updateEvidencePackButton();
  startRunTimer("准备访谈");
  setView("running");

  await runPersonasStage(config, state.runToken);
}

async function runPersonasStage(config, runToken) {
  state.runSubStage = "personas-running";
  setStageTimerLabel("召集受访者");
  setStage("personas", "active");
  setRunStatus(stageMeta.personas.headline, stageMeta.personas.detail);
  setSpinnerVisible(true);
  hideAllControlPanels();

  try {
    const personasResp = await postJson("/api/personas", { config }, { signal: state.abortController?.signal });
    if (!isCurrentRun(runToken)) return;
    state.personas = personasResp.personas;
    setStage("personas", "done");
    showSection("personas", true);
    renderPersonaGrid($("previewPersonas"), state.personas);
    setActiveRunPanel("personas");
    persistCurrent("draft");

    setStageTimerLabel("生成主持指南");
    setRunStatus("正在完成访谈准备…", "这一步还没有开始正式访谈。系统正在生成主持指南，完成后你再选择一步一轮或直接到位。");
    const guideResp = await postJson("/api/moderator-guide", {
      config,
      personas: state.personas,
      topics: state.topics,
    }, { signal: state.abortController?.signal });
    if (!isCurrentRun(runToken)) return;
    state.moderatorGuide = guideResp.moderatorGuide || null;
    state.participantStates = guideResp.participantStates || [];
    state.contextState = guideResp.contextState || null;
    persistCurrent("draft");

    state.runSubStage = "mode-choice";
    setStageTimerLabel("等待选择");
    setStage("session", "active");
    setRunStatus(stageMeta.modeChoice.headline, stageMeta.modeChoice.detail);
    setSpinnerVisible(false);
    showSection("session", true);
    setActiveRunPanel("session");
    showControlPanel("ctrlModeChoice");
  } catch (error) {
    handleRunError(error, runToken);
  }
}

async function runSessionAllAtOnce() {
  const runToken = ensureActiveRun("直接到位访谈");
  state.runMode = "all";
  state.runSubStage = "session-running";
  setActiveRunPanel("session");
  hideAllControlPanels();
  setSpinnerVisible(true);
  setRunStatus(stageMeta.sessionDirect.headline, stageMeta.sessionDirect.detail);
  startDirectModeProgress();

  try {
    const config = getConfig();
    const sessionResp = await postJson("/api/session", {
      config,
      personas: state.personas,
      topics: state.topics,
      moderatorGuide: state.moderatorGuide,
      participantStates: state.participantStates,
      contextState: state.contextState,
    }, { signal: state.abortController?.signal });
    if (!isCurrentRun(runToken)) return;
    state.messages = sessionResp.messages || [];
    state.participantStates = Array.isArray(sessionResp.participantStates)
      ? sessionResp.participantStates
      : state.participantStates;
    state.contextState = sessionResp.contextState || state.contextState;
    state.evidencePack = sessionResp.evidencePack || state.evidencePack;
    updateEvidencePackButton();
    state.currentRound = state.topics.length;
    setStage("session", "done");
    renderChatLog($("previewChat"), state.messages);
    scrollChatPreviewToBottom();
    persistCurrent("draft");
    stopDirectModeProgress();

    await runReportStage(runToken);
  } catch (error) {
    stopDirectModeProgress();
    handleRunError(error, runToken);
  }
}

async function runOneRound() {
  const config = getConfig();
  const nextRound = state.currentRound + 1;
  const runToken = ensureActiveRun(`生成第 ${nextRound} 轮`);
  state.runMode = "step";
  setActiveRunPanel("session");
  const topic = state.topics[state.currentRound];

  state.runSubStage = "session-step-running";
  setStageTimerLabel(`生成第 ${nextRound} 轮`);
  hideAllControlPanels();
  showNextRoundControl();
  setSpinnerVisible(true);
  setStage("session", "active");
  setRunStatus(
    stageMeta.sessionStep.headline.replace("{round}", nextRound),
    stageMeta.sessionStep.detail,
  );

  try {
    const resp = await postJson("/api/session/round", {
      config,
      personas: state.personas,
      topic,
      roundNumber: nextRound,
      priorMessages: state.messages,
      moderatorGuide: state.moderatorGuide,
      participantStates: state.participantStates,
      contextState: state.contextState,
    }, { signal: state.abortController?.signal });
    if (!isCurrentRun(runToken)) return;
    const newMessages = (resp.messages || []).map((m) => ({ ...m, round: nextRound }));
    state.messages = [...state.messages, ...newMessages];
    state.participantStates = Array.isArray(resp.participantStates) ? resp.participantStates : state.participantStates;
    state.contextState = resp.contextState || state.contextState;
    state.currentRound = nextRound;
    renderChatLog($("previewChat"), state.messages);
    scrollChatPreviewToBottom();
    updateRoundBadge();
    persistCurrent("draft");

    if (state.currentRound >= state.topics.length) {
      setStage("session", "done");
      await runReportStage(runToken);
    } else {
      state.runSubStage = "session-step-paused";
      setSpinnerVisible(false);
      setRunStatus(
        stageMeta.sessionPaused.headline.replace("{round}", state.currentRound),
        stageMeta.sessionPaused.detail,
      );
      showNextRoundControl();
      $("nextRoundNumber").textContent = state.currentRound + 1;
      showControlPanel("ctrlContinueRound");
    }
  } catch (error) {
    handleRunError(error, runToken);
  }
}

function updateRoundBadge() {
  const total = state.topics.length;
  const done = state.currentRound;
  const badge = $("roundBadge");
  if (total > 0) {
    badge.hidden = false;
    $("completedRounds").textContent = done;
    $("totalRounds").textContent = total;
  } else {
    badge.hidden = true;
  }
}

async function runReportStage(runToken = null) {
  runToken = runToken || ensureActiveRun("生成洞察报告");
  state.runSubStage = "report-running";
  setStageTimerLabel("生成洞察报告");
  hideAllControlPanels();
  setSpinnerVisible(true);
  setStage("report", "active");
  showSection("report", true);
  setActiveRunPanel("report");
  setRunStatus(stageMeta.report.headline, stageMeta.report.detail);
  $("reportPendingText").textContent = "正在汇总抗性、期待和心理痛点…";

  try {
    const config = getConfig();
    const reportResp = await postJson("/api/report", {
      config,
      personas: state.personas,
      messages: state.messages,
      moderatorGuide: state.moderatorGuide,
      participantStates: state.participantStates,
      contextState: state.contextState,
      evidencePack: state.evidencePack,
    }, { signal: state.abortController?.signal });
    if (!isCurrentRun(runToken)) return;
    state.reportMarkdown = reportResp.markdown || "";
    setStage("report", "done");
    persistCurrent("completed");
    state.runSubStage = "done";
    stopRunTimer();
    renderRunReport();
    setActiveRunPanel("report");
    setRunStatusVisible(false);
    showToast("访谈和报告已完成");
  } catch (error) {
    handleRunError(error, runToken);
  } finally {
    if (isCurrentRun(runToken)) {
      state.isRunning = false;
      state.abortController = null;
    }
  }
}

function handleRunError(error, runToken = state.runToken) {
  if (!isCurrentRun(runToken)) return;
  stopDirectModeProgress();
  if (error?.name === "AbortError") {
    state.runSubStage = "cancelled";
    state.isRunning = false;
    state.abortController = null;
    stopRunTimer();
    return;
  }
  console.warn(error);
  state.lastFailedSubStage = state.runSubStage;
  state.runSubStage = "error";
  if (state.personas.length === 0) setStage("personas", "error");
  else if (state.messages.length === 0) setStage("session", "error");
  else setStage("report", "error");
  setSpinnerVisible(false);
  setRunStatus("出错了", error.message?.slice(0, 200) || "API 调用失败，请稍后重试", true);
  stopRunTimer();
  hideAllControlPanels();
  showControlPanel("ctrlRetry");
  persistCurrent("draft");
  state.isRunning = false;
  state.abortController = null;
}

function isCurrentRun(runToken) {
  return state.runToken === runToken;
}

function ensureActiveRun(timerLabel) {
  if (!state.isRunning || !state.abortController) {
    state.isRunning = true;
    state.abortController = new AbortController();
    state.runToken += 1;
    startRunTimer(timerLabel || "继续访谈");
  }
  return state.runToken;
}

function cancelActiveRun() {
  stopDirectModeProgress();
  if (state.abortController) {
    state.abortController.abort();
  }
  state.runToken += 1;
  state.runSubStage = "cancelled";
  state.isRunning = false;
  state.abortController = null;
  stopRunTimer();
  setSpinnerVisible(false);
  hideAllControlPanels();
  if (state.projectId || state.personas.length || state.messages.length) {
    persistCurrent("draft");
  }
}

async function retryCurrentStep() {
  if (state.isRunning) return;
  if (!state.lastFailedSubStage) {
    showToast("没有可重试的失败步骤");
    return;
  }

  state.isRunning = true;
  state.abortController = new AbortController();
  state.runToken += 1;
  const runToken = state.runToken;
  const failedSubStage = state.lastFailedSubStage;
  state.lastFailedSubStage = null;
  stopDirectModeProgress();
  hideAllControlPanels();
  setSpinnerVisible(true);
  startRunTimer("准备重试");

  try {
    if (failedSubStage === "personas-running" || !state.personas.length) {
      await runPersonasStage(getConfig(), runToken);
    } else if (failedSubStage === "session-running") {
      await runSessionAllAtOnce();
    } else if (failedSubStage === "session-step-running") {
      await runOneRound();
    } else if (failedSubStage === "report-running") {
      await runReportStage(runToken);
    } else {
      await runPersonasStage(getConfig(), runToken);
    }
  } catch (error) {
    handleRunError(error, runToken);
  }
}

/* ============================================================
   Evidence pack modal
   ============================================================ */

function openEvidencePackModal() {
  if (!hasUsableEvidencePack()) {
    showToast("当前项目还没有可查看的外部资料包");
    return;
  }
  $("evidencePackContent").innerHTML = renderEvidencePackHtml(state.evidencePack);
  $("evidencePackModal").hidden = false;
  document.body.classList.add("modal-open");
}

function closeEvidencePackModal() {
  const modal = $("evidencePackModal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

/* ============================================================
   Init / event bindings
   ============================================================ */

function init() {
  setConfig(defaultData);
  const draft = loadDraft();
  if (draft) setConfig({ ...defaultData, ...draft });

  fields.forEach((key) => {
    const node = $(key);
    if (!node) return;
    node.addEventListener("input", saveDraft);
    node.addEventListener("change", saveDraft);
  });

  $("quickFillBtn").addEventListener("click", () => handleQuickFill());
  $("quickFillInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleQuickFill();
  });
  document.querySelectorAll(".chip[data-quick]").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("quickFillInput").value = chip.dataset.quick;
      handleQuickFill(chip.dataset.quick);
    });
  });

  $("startBtn").addEventListener("click", startRun);
  $("resetFormBtn").addEventListener("click", () => {
    if (!confirm("确定恢复示例数据？当前编辑的内容将丢失。")) return;
    setConfig(defaultData);
    saveDraft();
    state.projectId = null;
    state.personas = [];
    state.messages = [];
    state.reportMarkdown = "";
    state.moderatorGuide = null;
    state.participantStates = [];
    state.contextState = null;
    state.evidencePack = null;
    renderRunReport();
    updateEvidencePackButton();
    showToast("已恢复示例数据");
  });

  $("cancelRunBtn").addEventListener("click", () => {
    if (state.isRunning) {
      if (!confirm("访谈仍在进行，确定返回？已经生成的内容将保存为草稿。")) return;
      cancelActiveRun();
    }
    setView("home");
    renderRecentProjects();
  });
  $("retryRunBtn").addEventListener("click", retryCurrentStep);
  document.querySelectorAll(".stage[data-stage]").forEach((stage) => {
    const activate = () => setActiveRunPanel(stage.dataset.stage);
    stage.addEventListener("click", activate);
    stage.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
  });
  $("viewEvidencePackBtn").addEventListener("click", openEvidencePackModal);
  $("closeEvidencePackBtn").addEventListener("click", closeEvidencePackModal);
  $("evidencePackModal").addEventListener("click", (event) => {
    if (event.target.id === "evidencePackModal") closeEvidencePackModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("evidencePackModal").hidden) closeEvidencePackModal();
  });

  document.querySelectorAll(".mode-btn[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      $("ctrlModeChoice").hidden = true;
      if (mode === "all") {
        runSessionAllAtOnce();
      } else if (mode === "step") {
        runOneRound();
      }
    });
  });

  $("continueRoundBtn").addEventListener("click", () => {
    if ($("continueRoundBtn").dataset.action === "report") {
      runReportStage();
      return;
    }
    runOneRound();
  });

  $("copyReportBtn").addEventListener("click", copyReport);
  $("downloadReportBtn").addEventListener("click", downloadReport);

  renderRecentProjects();

  setView("home");
}

init();
