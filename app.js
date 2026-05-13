/* ============================================================
   Focus Group Simulator — App entry
   ============================================================ */

import {
  $,
  state,
  defaultData,
  fields,
  getConfig,
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
import { postJson, postJsonStream, showToast } from "./app-api.js";
import { escapeHtml } from "./app-markdown.js";
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

let runSpinnerEl = null;
let runStatusEl = null;
const getRunSpinner = () => runSpinnerEl || (runSpinnerEl = document.querySelector(".run-spinner"));
const getRunStatus = () => runStatusEl || (runStatusEl = document.querySelector(".run-status"));

/* ============================================================
   View switching
   ============================================================ */

function setView(name) {
  state.view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const target = $("view" + name.charAt(0).toUpperCase() + name.slice(1));
  if (target) target.classList.add("active");
  window.scrollTo(0, 0);
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
        <article class="recent-card" data-id="${escapeHtml(project.id)}">
          <header class="recent-card-head">
            ${statusBadge}
            <button class="recent-delete" type="button" data-action="delete" data-id="${escapeHtml(project.id)}" aria-label="删除项目">×</button>
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
}

function bindRecentProjectsDelegation() {
  const grid = $("recentGrid");
  if (!grid || grid.dataset.delegated === "true") return;
  grid.dataset.delegated = "true";
  grid.addEventListener("click", (event) => {
    const deleteBtn = event.target.closest("[data-action='delete']");
    if (deleteBtn) {
      event.stopPropagation();
      const id = deleteBtn.dataset.id;
      if (confirm("确定删除该项目？此操作不可撤销。")) {
        deleteProjectById(id);
        renderRecentProjects();
        showToast("项目已删除");
      }
      return;
    }
    const card = event.target.closest(".recent-card");
    if (card) handleRecentClick(card.dataset.id);
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
    headline: "请选择继续方式",
    detail: "准备阶段已完成。极速完整访谈会一次性跑完；逐轮深访适合手动控制节奏。",
  },
  session: {
    headline: "焦点小组讨论中…",
    detail: "主持人正在按议程引导讨论，受访者按各自人设发言。这一步耗时最长，请耐心等待。",
  },
  sessionDirect: {
    headline: "极速完整访谈运行中…",
    detail: "系统会跳过额外桌面研究，直接用受访者画像和议题蓝图生成完整访谈。",
  },
  sessionDirectSearch: {
    headline: "网络搜索增强运行中…",
    detail: "系统会先检索公开资料并整理资料包，再生成完整访谈和报告。",
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
  const spinner = getRunSpinner();
  if (spinner) spinner.classList.toggle("is-error", error);
}

function setRunStatusVisible(visible) {
  const status = getRunStatus();
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
  const spinner = getRunSpinner();
  if (spinner) spinner.style.visibility = visible ? "visible" : "hidden";
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

    setStage("session", "active");
    showSection("session", true);
    setActiveRunPanel("session");

    if (config.runModePreference === "step") {
      state.runSubStage = "moderator-guide-running";
      setStageTimerLabel("启动逐轮深访");
      setRunStatus("逐轮深访启动中…", "受访者已生成，系统会先补充主持指南，然后进入第 1 轮访谈。");
      await runOneRound();
      return;
    }

    state.runSubStage = "session-running";
    setStageTimerLabel("启动完整访谈");
    setRunStatus("极速完整访谈启动中…", "受访者已生成，系统会自动连续生成各轮访谈并继续产出报告。");
    await runSessionAllAtOnce();
  } catch (error) {
    handleRunError(error, runToken);
  }
}

async function runSessionAllAtOnce() {
  const runToken = ensureActiveRun("极速完整访谈");
  state.runMode = "all";
  state.runSubStage = "session-running";
  setActiveRunPanel("session");
  hideAllControlPanels();
  setSpinnerVisible(true);
  setRunStatus("极速完整访谈启动中…", "系统会自动连续生成每一轮，消息会边生成边显示。");

  try {
    const ready = await ensureModeratorGuideForStep(runToken);
    if (!ready) return;
    const evidenceReady = await ensureEvidencePackForAllRun(runToken);
    if (!evidenceReady) return;

    state.runSubStage = "session-running";
    setActiveRunPanel("session");
    hideAllControlPanels();
    setSpinnerVisible(true);

    for (let roundIndex = state.currentRound; roundIndex < state.topics.length; roundIndex += 1) {
      const roundNumber = roundIndex + 1;
      const topic = state.topics[roundIndex] || `第 ${roundNumber} 轮话题`;
      setStageTimerLabel(`生成第 ${roundNumber} 轮`);
      const completed = await streamSessionRound({
        runToken,
        roundNumber,
        topic,
        headline: `极速完整访谈：第 ${roundNumber}/${state.topics.length} 轮`,
        initialDetail: "本轮消息会逐批显示，结束后自动进入下一轮。",
      });
      if (!completed || !isCurrentRun(runToken)) return;
    }

    setStage("session", "done");
    await runReportStage(runToken);
  } catch (error) {
    handleRunError(error, runToken);
  }
}

async function ensureModeratorGuideForStep(runToken) {
  if (state.moderatorGuide && state.participantStates.length && state.contextState) return true;
  state.runSubStage = "moderator-guide-running";
  setStageTimerLabel("生成主持指南");
  setRunStatus("正在生成主持指南…", "逐轮深访需要更细的主持计划和受访者立场记忆，完成后会自动进入本轮访谈。");
  setSpinnerVisible(true);

  const guideResp = await postJson("/api/moderator-guide", {
    config: getConfig(),
    personas: state.personas,
    topics: state.topics,
  }, { signal: state.abortController?.signal });
  if (!isCurrentRun(runToken)) return false;

  state.moderatorGuide = guideResp.moderatorGuide || null;
  state.participantStates = guideResp.participantStates || [];
  state.contextState = guideResp.contextState || null;
  persistCurrent("draft");
  return true;
}

async function ensureEvidencePackForAllRun(runToken) {
  const config = getConfig();
  if (!config.useSearchEnhancement) return true;
  if (state.evidencePack?.status === "used" && Array.isArray(state.contextState?.externalFindings) && state.contextState.externalFindings.length) {
    updateEvidencePackButton();
    return true;
  }

  state.runSubStage = "evidence-pack-running";
  setStageTimerLabel("整理外部资料包");
  setRunStatus("正在整理外部资料包…", "系统正在检索公开资料并整理来源卡片，完成后会继续生成访谈。");
  setSpinnerVisible(true);
  hideAllControlPanels();

  try {
    const data = await postJson("/api/evidence-pack", {
      config,
      personas: state.personas,
      topics: state.topics,
      moderatorGuide: state.moderatorGuide,
      participantStates: state.participantStates,
      contextState: state.contextState,
    }, { signal: state.abortController?.signal });
    if (!isCurrentRun(runToken)) return false;

    state.evidencePack = data.evidencePack || null;
    state.contextState = data.contextState || state.contextState;
    updateEvidencePackButton();
    persistCurrent("draft");

    const sourceCount = Array.isArray(state.evidencePack?.sourceCards) ? state.evidencePack.sourceCards.length : 0;
    if (state.evidencePack?.status === "used" && sourceCount > 0) {
      showToast(`已整理 ${sourceCount} 条外部资料`);
    } else if (state.evidencePack?.status === "failed") {
      showToast("搜索增强失败，已继续生成访谈");
    } else {
      showToast("未生成可用资料包，已继续生成访谈");
    }
    return true;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.warn(error);
    showToast(`搜索增强失败，已继续：${(error.message || "").slice(0, 60)}`);
    return true;
  }
}

async function runOneRound() {
  const nextRound = state.currentRound + 1;
  const runToken = ensureActiveRun(`生成第 ${nextRound} 轮`);
  state.runMode = "step";
  setActiveRunPanel("session");
  try {
    const ready = await ensureModeratorGuideForStep(runToken);
    if (!ready) return;
  } catch (error) {
    handleRunError(error, runToken);
    return;
  }
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
    const completed = await streamSessionRound({
      runToken,
      roundNumber: nextRound,
      topic,
      headline: stageMeta.sessionStep.headline.replace("{round}", nextRound),
      initialDetail: stageMeta.sessionStep.detail,
    });
    if (!completed || !isCurrentRun(runToken)) return;

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

async function streamSessionRound({ runToken, roundNumber, topic, headline, initialDetail }) {
  const config = getConfig();
  const priorMessages = [...state.messages];
  const streamedMessages = [];
  let finalRoundResult = null;

  setRunStatus(headline, initialDetail);
  await postJsonStream("/api/session/round/stream", {
    config,
    personas: state.personas,
    topics: state.topics,
    topic,
    roundNumber,
    priorMessages,
    moderatorGuide: state.moderatorGuide,
    participantStates: state.participantStates,
    contextState: state.contextState,
  }, {
    signal: state.abortController?.signal,
    onEvent: (event) => {
      if (!isCurrentRun(runToken)) return;
      if (event.type === "status") {
        const nextSpeakers = Array.isArray(event.nextSpeakers) && event.nextSpeakers.length
          ? `下一波：${event.nextSpeakers.join("、")}`
          : "主持人正在判断本轮是否收束";
        setRunStatus(
          headline,
          event.action === "summarize" ? "主持人判断本轮信息已经足够，正在收束总结…" : nextSpeakers,
        );
        return;
      }
      if (event.type === "messages") {
        const incoming = (event.messages || []).map((message) => ({ ...message, round: roundNumber }));
        if (!incoming.length) return;
        streamedMessages.push(...incoming);
        state.messages = [...priorMessages, ...streamedMessages];
        renderChatLog($("previewChat"), state.messages);
        scrollChatPreviewToBottom();
        const latest = incoming[incoming.length - 1];
        setRunStatus(headline, `${latest.speaker} 正在发言，内容会逐步出现在下方。`);
        return;
      }
      if (event.type === "done") {
        finalRoundResult = event;
      }
    },
  });

  if (!isCurrentRun(runToken)) return false;
  const newMessages = (finalRoundResult?.messages || streamedMessages).map((message) => ({ ...message, round: roundNumber }));
  state.messages = [...priorMessages, ...newMessages];
  state.moderatorGuide = finalRoundResult?.moderatorGuide || state.moderatorGuide;
  state.participantStates = Array.isArray(finalRoundResult?.participantStates)
    ? finalRoundResult.participantStates
    : state.participantStates;
  state.contextState = finalRoundResult?.contextState || state.contextState;
  state.currentRound = roundNumber;
  renderChatLog($("previewChat"), state.messages);
  scrollChatPreviewToBottom();
  updateRoundBadge();
  persistCurrent("draft");
  return true;
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
    const payload = {
      config,
      personas: state.personas,
      messages: state.messages,
      moderatorGuide: state.moderatorGuide,
      participantStates: state.participantStates,
      contextState: state.contextState,
      evidencePack: state.evidencePack,
    };
    let lastRenderAt = 0;
    const renderPartialReport = (force = false) => {
      if (!isCurrentRun(runToken)) return;
      const now = Date.now();
      if (!force && now - lastRenderAt < 300) return;
      lastRenderAt = now;
      renderRunReport();
    };

    state.reportMarkdown = "";
    state.reportStreaming = true;
    renderRunReport();
    await postJsonStream("/api/report/stream", payload, {
      signal: state.abortController?.signal,
      onEvent: (event) => {
        if (!isCurrentRun(runToken)) return;
        if (event.type === "start") {
          $("reportPendingText").textContent = "正在生成报告，内容会逐步显示…";
          return;
        }
        if (event.type === "chunk") {
          const text = event.text || "";
          if (!text) return;
          state.reportMarkdown += text;
          $("reportPendingText").textContent = "正在生成报告，可先预览已返回内容…";
          renderPartialReport();
          return;
        }
        if (event.type === "done") {
          state.reportMarkdown = event.markdown || state.reportMarkdown;
          renderPartialReport(true);
        }
      },
    });
    if (!isCurrentRun(runToken)) return;
    state.reportStreaming = false;
    setStage("report", "done");
    persistCurrent("completed");
    state.runSubStage = "done";
    stopRunTimer();
    renderRunReport();
    setActiveRunPanel("report");
    setRunStatusVisible(false);
    showToast("访谈和报告已完成");
  } catch (error) {
    state.reportStreaming = false;
    renderRunReport();
    handleRunError(error, runToken);
  } finally {
    if (isCurrentRun(runToken)) {
      state.reportStreaming = false;
      state.isRunning = false;
      state.abortController = null;
    }
  }
}

function handleRunError(error, runToken = state.runToken) {
  if (!isCurrentRun(runToken)) return;
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
  const failedStage = mapSubStageToStage(state.lastFailedSubStage);
  setStage(failedStage, "error");
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

function mapSubStageToStage(subStage) {
  if (subStage === "report-running") return "report";
  if (subStage === "session-running" || subStage === "session-step-running" || subStage === "moderator-guide-running" || subStage === "evidence-pack-running") return "session";
  if (subStage === "personas-running") return "personas";
  if (state.personas.length === 0) return "personas";
  if (state.messages.length === 0) return "session";
  return "report";
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
  hideAllControlPanels();
  setSpinnerVisible(true);
  startRunTimer("准备重试");

  try {
    if (failedSubStage === "personas-running" || !state.personas.length) {
      await runPersonasStage(getConfig(), runToken);
    } else if (failedSubStage === "session-running") {
      await runSessionAllAtOnce();
    } else if (failedSubStage === "moderator-guide-running") {
      if (state.runMode === "all") await runSessionAllAtOnce();
      else await runOneRound();
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

  bindRecentProjectsDelegation();
  renderRecentProjects();

  setView("home");
}

init();
