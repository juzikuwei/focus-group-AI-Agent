/* ============================================================
   Focus Group Simulator — App entry
   ============================================================ */

import {
  $,
  state,
  defaultData,
  EXAMPLE_DATA,
  fields,
  getConfig,
  setConfig,
  buildTopics,
  getCompletedRoundCount,
  formatDate,
} from "./app-state.js";
import {
  saveDraft,
  loadDraft,
  deleteProjectById,
  getProjectById,
  newProjectId,
  persistCurrent,
  persistCurrentAsync,
  loadProjectIntoState,
  loadProjects,
} from "./app-storage.js";
import { clientSettingsHeaders, getLocalSettings, postJson, postJsonStream, saveLocalSettings, showToast } from "./app-api.js";
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
   View & Navigation switching
   ============================================================ */

const navTitles = { dashboard: "首页", projects: "项目目录", interview: "生成访谈" };

function setNavPanel(name) {
  state.navPanel = name;
  document.querySelectorAll(".nav-panel").forEach((p) => p.classList.remove("active"));
  const target = $("panel" + name.charAt(0).toUpperCase() + name.slice(1));
  if (target) target.classList.add("active");

  // Update top-level nav items
  document.querySelectorAll(".nav-item[data-nav]").forEach((item) => {
    if (!item.classList.contains("nav-sub")) {
      item.classList.toggle("active", item.dataset.nav === name);
    }
  });

  // Open the active nav group
  document.querySelectorAll(".nav-group").forEach((group) => {
    const parent = group.querySelector(".nav-parent");
    if (parent && parent.dataset.nav === name) {
      group.classList.add("open");
    } else {
      group.classList.remove("open");
    }
  });

  // Update topbar title
  const topbarTitle = $("topbarTitle");
  if (topbarTitle) topbarTitle.textContent = navTitles[name] || "首页";
}

function setProjectFilter(filter) {
  state.projectFilter = filter;
  document.querySelectorAll(".nav-sub[data-filter]").forEach((sub) => {
    sub.classList.toggle("active", sub.dataset.filter === filter);
  });
  renderRecentProjects();
}

function scrollToSection(sectionId) {
  const el = document.getElementById(sectionId);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setView(name) {
  state.view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const target = $("view" + name.charAt(0).toUpperCase() + name.slice(1));
  if (target) target.classList.add("active");
  const sidebar = $("sidebar");
  if (sidebar) sidebar.style.display = name === "running" ? "none" : "";
  const topbarTitle = $("topbarTitle");
  if (name === "running") {
    if (topbarTitle) topbarTitle.textContent = state.runSubStage === "done" ? "项目详情" : "访谈进行中";
  } else {
    if (topbarTitle) topbarTitle.textContent = navTitles[state.navPanel] || "首页";
  }
  window.scrollTo(0, 0);
}

/* ============================================================
   Recent projects rendering
   ============================================================ */

function projectCardHtml(project) {
  const date = formatDate(project.updatedAt || project.createdAt);
  const isDone = project.status === "completed";
  const statusBadge = isDone
    ? `<span class="badge badge-success">已完成</span>`
    : `<span class="badge badge-muted">草稿</span>`;
  const concept = (project.config?.productConcept || "").slice(0, 64);
  const personasCount = (project.personas || []).length;
  const messageCount = (project.messages || []).length;
  const hasData = personasCount > 0 || messageCount > 0;
  const id = escapeHtml(project.id);

  let actions = "";
  if (!isDone && hasData) {
    actions = `
      <div class="card-actions">
        <button class="card-action-btn" type="button" data-action="view" data-id="${id}">查看</button>
        <button class="card-action-btn primary" type="button" data-action="resume" data-id="${id}">继续生成</button>
      </div>`;
  } else if (isDone) {
    actions = `
      <div class="card-actions">
        <button class="card-action-btn" type="button" data-action="view" data-id="${id}">查看报告</button>
        <button class="card-action-btn" type="button" data-action="edit-config" data-id="${id}">重新编辑</button>
        <button class="card-action-btn primary" type="button" data-action="rerun" data-id="${id}">重新访谈</button>
      </div>`;
  }

  return `
    <article class="recent-card${!isDone && hasData ? " recent-card-draft" : ""}" data-id="${id}">
      <header class="recent-card-head">
        ${statusBadge}
        <button class="recent-delete" type="button" data-action="delete" data-id="${id}" aria-label="删除项目">×</button>
      </header>
      <h3 class="recent-name">${escapeHtml(project.name || "未命名项目")}</h3>
      <p class="recent-concept">${escapeHtml(concept)}${concept.length >= 64 ? "…" : ""}</p>
      <footer class="recent-meta">
        <span>${date}</span>
        <span>${personasCount} 人 · ${messageCount} 条记录</span>
      </footer>
      ${actions}
    </article>
  `;
}

let cachedProjects = [];

async function renderRecentProjects() {
  cachedProjects = loadProjects();

  const allProjects = cachedProjects;

  // Dashboard stats
  const total = allProjects.length;
  const done = allProjects.filter((p) => p.status === "completed").length;
  const draft = total - done;
  const statTotal = $("statTotal");
  const statDone = $("statDone");
  const statDraft = $("statDraft");
  if (statTotal) statTotal.textContent = total;
  if (statDone) statDone.textContent = done;
  if (statDraft) statDraft.textContent = draft;

  // Projects panel grid (with filter)
  const filter = state.projectFilter || "all";
  const filtered = filter === "all"
    ? allProjects
    : allProjects.filter((p) => filter === "completed" ? p.status === "completed" : p.status !== "completed");

  const gridFull = $("recentGridFull");
  if (gridFull) {
    if (!filtered.length) {
      const emptyMsg = filter === "completed" ? "没有已完成的项目。" : filter === "draft" ? "没有草稿项目。" : "还没有保存的项目。完成一次访谈后会出现在这里。";
      gridFull.className = "recent-grid empty-state-soft";
      gridFull.innerHTML = `<p>${emptyMsg}</p>`;
    } else {
      gridFull.className = "recent-grid";
      gridFull.innerHTML = filtered.map(projectCardHtml).join("");
    }
  }
}

function bindRecentProjectsDelegation() {
  const grid = $("recentGridFull");
  if (!grid || grid.dataset.delegated === "true") return;
  grid.dataset.delegated = "true";
  grid.addEventListener("click", (event) => {
    const deleteBtn = event.target.closest("[data-action='delete']");
    if (deleteBtn) {
      event.stopPropagation();
      const id = deleteBtn.dataset.id;
      if (window.confirm("确定删除该项目？此操作不可撤销。")) {
        deleteProjectById(id);
        renderRecentProjects();
        showToast("项目已删除");
      }
      return;
    }

    const actionBtn = event.target.closest("[data-action='resume']");
    if (actionBtn) {
      event.stopPropagation();
      handleResumeDraft(actionBtn.dataset.id);
      return;
    }

    const editConfigBtn = event.target.closest("[data-action='edit-config']");
    if (editConfigBtn) {
      event.stopPropagation();
      handleEditConfig(editConfigBtn.dataset.id);
      return;
    }

    const rerunBtn = event.target.closest("[data-action='rerun']");
    if (rerunBtn) {
      event.stopPropagation();
      handleRerun(rerunBtn.dataset.id);
      return;
    }

    const viewBtn = event.target.closest("[data-action='view']");
    if (viewBtn) {
      event.stopPropagation();
      handleRecentClick(viewBtn.dataset.id);
      return;
    }

    const card = event.target.closest(".recent-card");
    if (card) handleRecentClick(card.dataset.id);
  });
}

function handleResumeDraft(id) {
  const project = getProjectById(id);
  if (!project) {
    showToast("项目不存在或已被删除");
    renderRecentProjects();
    return;
  }
  loadProjectIntoState(project);
  restoreDraftRunView(project);
}

function handleEditConfig(id) {
  const project = getProjectById(id);
  if (!project) {
    showToast("项目不存在或已被删除");
    renderRecentProjects();
    return;
  }

  // Load config and keep existing data
  setConfig({ ...defaultData, ...(project.config || {}) });
  state.projectId = project.id;
  state.editMode = true;
  state.personas = project.personas || [];
  state.messages = project.messages || [];
  state.reportMarkdown = project.reportMarkdown || "";
  state.reportComplete = project.reportComplete || false;
  state.currentRound = project.currentRound || 0;
  state.runMode = project.runMode || null;

  // Editing a completed project reverts to draft; report generation will upgrade it back
  persistCurrent("draft");

  setView("home");
  setNavPanel("interview");
  updateConfigPageForEditMode();
  showToast("已加载项目配置，修改后点击确认按钮即可继续");
}

function handleRerun(id) {
  const project = getProjectById(id);
  if (!project) {
    showToast("项目不存在或已被删除");
    renderRecentProjects();
    return;
  }
  if (!window.confirm("重新访谈会清除该项目已有的受访者和访谈记录，保留原始配置重新开始。确定继续？")) return;
  loadProjectIntoState(project);
  state.personas = [];
  state.messages = [];
  state.reportMarkdown = "";
  state.reportComplete = false;
  state.moderatorGuide = null;
  state.participantStates = [];
  state.contextState = null;
  state.evidencePack = null;
  state.currentRound = 0;
  state.runMode = null;
  state.runSubStage = null;
  state.isRunning = false;
  state.abortController = null;
  state.runToken += 1;
  state.projectId = null;
  state.isViewOnly = false;
  persistCurrent("draft");
  startRun();
}

function updateConfigPageForEditMode() {
  const startBtn = $("startBtn");
  if (state.editMode) {
    startBtn.hidden = true;
    let skipBtn = $("skipConfigBtn");
    if (!skipBtn) {
      skipBtn = document.createElement("button");
      skipBtn.id = "skipConfigBtn";
      skipBtn.className = "primary";
      skipBtn.type = "button";
      skipBtn.textContent = state.personas.length ? "确认修改，进入受访者" : "确认配置，开始访谈";
      startBtn.parentNode.insertBefore(skipBtn, startBtn);
      skipBtn.addEventListener("click", handleSkipConfig);
    }
    skipBtn.hidden = false;
  } else {
    startBtn.hidden = false;
    startBtn.textContent = "开始访谈";
    const skipBtn = $("skipConfigBtn");
    if (skipBtn) skipBtn.hidden = true;
  }
}

function handleSkipConfig() {
  if (state.personas.length) {
    showPersonasForEdit();
  } else {
    startRun();
  }
}

function showPersonasForEdit() {
  state.isRunning = false;
  state.abortController = null;
  state.lastFailedSubStage = null;
  state.runToken += 1;
  stopRunTimer();

  const config = getConfig();
  $("runProjectName").textContent = config.projectName || "编辑项目";
  resetStages();
  hideAllControlPanels();
  setSpinnerVisible(false);
  $("runMeta").hidden = true;

  state.isViewOnly = false;
  showSection("personas", true);
  showSection("session", false);
  showSection("report", false);
  renderPersonaGrid($("previewPersonas"), state.personas);

  setStage("personas", "done");
  setRunStatus("受访者已加载", "可点击卡片上的「编辑」修改，或点击「完成修改」保存。");

  showEditPersonasControl();

  setActiveRunPanel("personas");
  setView("running");
}

function showEditPersonasControl() {
  hideAllControlPanels();

  let editControl = $("ctrlEditPersonas");
  if (!editControl) {
    editControl = document.createElement("div");
    editControl.id = "ctrlEditPersonas";
    editControl.className = "persona-confirm-bar";
    editControl.innerHTML = `
      <span>可点击卡片上的「编辑」修改受访者，或重新生成。</span>
      <button id="regenPersonasBtn" class="ghost" type="button">AI重新生成</button>
      <button id="finishEditBtn" class="ghost" type="button">保存退出</button>
      <button id="startInterviewBtn" class="primary" type="button">下一步：开始访谈</button>
    `;
    $("sectionPersonas").appendChild(editControl);

    $("regenPersonasBtn").addEventListener("click", () => {
      startRun();
    });
    $("finishEditBtn").addEventListener("click", handleFinishEdit);
    $("startInterviewBtn").addEventListener("click", handleStartInterviewFromEdit);
  }
  editControl.hidden = false;
}

function handleFinishEdit() {
  persistCurrent("completed");
  state.editMode = false;
  state.isViewOnly = true;
  renderPersonaGrid($("previewPersonas"), state.personas);
  const topbarTitle = $("topbarTitle");
  if (topbarTitle) topbarTitle.textContent = "项目详情";
  setRunStatusVisible(false);
  hideAllControlPanels();
  showToast("修改已保存");
}

async function handleStartInterviewFromEdit() {
  const config = getConfig();
  state.editMode = false;
  state.isViewOnly = false;
  state.isRunning = true;
  state.abortController = new window.AbortController();
  state.runToken += 1;
  state.topics = buildTopics(config);
  state.currentRound = 0;
  state.activeRunPanel = "session";
  persistCurrent("draft");

  hideAllControlPanels();
  setStage("personas", "done");
  showSection("personas", true);
  showSection("session", true);
  showSection("report", false);
  renderPersonaGrid($("previewPersonas"), state.personas);
  startRunTimer("准备访谈");
  setView("running");

  // Use configured mode directly
  const mode = config.runModePreference === "step" ? "step" : "all";
  state.runMode = mode;

  if (mode === "all") {
    await runSessionAllAtOnce();
  } else {
    await runOneRound();
  }
}

function handleRecentClick(id) {
  const project = getProjectById(id);
  if (!project) {
    showToast("项目不存在或已被删除");
    renderRecentProjects();
    return;
  }
  // Reset edit mode when viewing a project
  state.editMode = false;
  loadProjectIntoState(project);
  if (project.status === "completed") {
    state.isViewOnly = true;
    restoreDraftRunView(project);
  } else if ((project.personas || []).length || (project.messages || []).length) {
    restoreDraftRunView(project);
  } else {
    showToast("草稿已恢复，可在下方继续编辑");
    setView("home");
    setNavPanel("interview");
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

  // Determine isViewOnly BEFORE rendering personas
  state.currentRound = Math.min(getCompletedRoundCount(state.messages), state.topics.length);
  const isCompleted = state.currentRound >= state.topics.length && state.messages.length && state.reportComplete;
  state.isViewOnly = isCompleted;

  showSection("personas", state.personas.length > 0);
  showSection("session", state.personas.length > 0);
  showSection("report", false);
  renderPersonaGrid($("previewPersonas"), state.personas);
  renderChatLog($("previewChat"), state.messages);
  updateEvidencePackButton();
  renderRunReport();
  scrollChatPreviewToBottom();

  updateRoundBadge();

  if (!state.personas.length) {
    setStage("personas", "pending");
    setRunStatus("草稿已恢复", "可返回主界面继续编辑，或重新开始访谈。");
    setActiveRunPanel("personas", { force: true });
  } else if (isCompleted) {
    setStage("personas", "done");
    setStage("session", "done");
    setStage("report", "done");
    showSection("report", true);
    state.runSubStage = "done";
    setRunStatusVisible(false);
    setActiveRunPanel("report");
    const topbarTitle = $("topbarTitle");
    if (topbarTitle) topbarTitle.textContent = "项目详情";
  } else if (state.currentRound >= state.topics.length && state.messages.length) {
    state.isViewOnly = false;
    setStage("personas", "done");
    setStage("session", "done");
    setStage("report", "active");
    showSection("report", true);
    state.runSubStage = "report-ready";
    if (state.reportMarkdown) {
      setRunStatus("报告已部分生成，可点击下方按钮重新生成完整报告", "已有部分报告内容，重新生成将覆盖。");
    } else {
      setRunStatus("访谈已完成，尚未生成报告", "点击下方按钮继续生成洞察报告。");
    }
    showReportReadyControl();
    setActiveRunPanel("session");
  } else if (state.messages.length) {
    state.isViewOnly = false;
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
    state.isViewOnly = false;
    setStage("personas", "done");
    setStage("session", "active");
    state.runSubStage = "personas-confirm";
    setRunStatus("受访者已恢复", "请查看受访者画像，确认后开始访谈。");
    showPersonasConfirmControl();
    setActiveRunPanel("personas");
  }

  setView("running");
  showToast("草稿已恢复");
}

function showReportReadyControl() {
  showControlPanel("ctrlContinueRound");
  $("continueRoundBtn").innerHTML = "生成洞察报告 →";
  $("continueRoundBtn").dataset.action = "report";
  const pending = $("reportPendingText");
  if (pending) {
    pending.textContent = state.reportMarkdown
      ? "报告已部分生成，点击重新生成完成全部报告，已有内容将被覆盖。"
      : "访谈已完成，尚未生成报告。请在访谈阶段点击生成洞察报告。";
  }
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

function resetProjectState() {
  state.projectId = null;
  state.personas = [];
  state.messages = [];
  state.reportMarkdown = "";
  state.reportComplete = false;
  state.moderatorGuide = null;
  state.participantStates = [];
  state.contextState = null;
  state.evidencePack = null;
  state.currentRound = 0;
  state.runMode = null;
  state.runSubStage = null;
  state.isRunning = false;
  state.runToken = 0;
  state.editMode = false;
  state.isViewOnly = false;
  renderRunReport();
  updateEvidencePackButton();
}

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
  const progressWrapper = $("quickFillProgress");
  const progressFill = $("quickFillProgressFill");
  const progressLabel = $("quickFillProgressLabel");

  const quickFillLabels = ["理解想法中…", "搜索资料中…", "生成项目中…"];
  let currentProgress = 0;
  let targetProgress = 0;
  let labelIndex = 0;
  let progressTimerId = null;
  let labelTimerId = null;
  let isApiComplete = false;

  btn.disabled = true;
  btnLabel.textContent = quickFillLabels[labelIndex];
  input.disabled = true;

  // 显示进度条
  progressWrapper.hidden = false;
  progressFill.style.width = "0%";
  progressLabel.textContent = quickFillLabels[labelIndex];

  // 平滑增长进度条：目标值逐步增长，实际值追赶目标值
  const updateProgress = () => {
    // 如果API已完成，目标值设为100
    if (isApiComplete) {
      targetProgress = 100;
    } else {
      // 未完成时，目标值缓慢增长，最多到85
      if (targetProgress < 85) {
        targetProgress += Math.random() * 1.5;
        targetProgress = Math.min(targetProgress, 85);
      } else {
        // 到85后极慢增长
        targetProgress += Math.random() * 0.3;
        targetProgress = Math.min(targetProgress, 90);
      }
    }

    // 实际值平滑追赶目标值
    if (currentProgress < targetProgress) {
      const diff = targetProgress - currentProgress;
      currentProgress += diff * 0.3; // 30%的追赶速度
      progressFill.style.width = currentProgress + "%";
    }

    // 如果已经到达100%，停止定时器
    if (currentProgress >= 99.5) {
      progressFill.style.width = "100%";
      if (progressTimerId) {
        window.clearInterval(progressTimerId);
        progressTimerId = null;
      }
    }
  };

  progressTimerId = window.setInterval(updateProgress, 100);

  // 文字分三个阶段切换
  labelTimerId = window.setInterval(() => {
    labelIndex = Math.min(labelIndex + 1, quickFillLabels.length - 1);
    btnLabel.textContent = quickFillLabels[labelIndex];
    progressLabel.textContent = quickFillLabels[labelIndex];
  }, 5000);

  try {
    const data = await postJson("/api/quick-fill", { seed: value });

    // API返回后标记完成，让进度条平滑到100%
    isApiComplete = true;

    // 等待进度条动画完成（最多1秒）
    await new Promise(resolve => {
      const checkComplete = setInterval(() => {
        if (currentProgress >= 99.5 || Date.now() - startTime > 1000) {
          clearInterval(checkComplete);
          resolve();
        }
      }, 50);
      const startTime = Date.now();
    });

    resetProjectState();
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
    if (progressTimerId) window.clearInterval(progressTimerId);
    if (labelTimerId) window.clearInterval(labelTimerId);
    state.isQuickFilling = false;
    btn.disabled = false;
    btnLabel.textContent = "生成项目";
    input.disabled = false;
    progressWrapper.hidden = true;
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
  ["ctrlPersonaConfirm", "ctrlModeChoice", "ctrlContinueRound", "ctrlRetry"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = id !== name;
  });
}

function hideAllControlPanels() {
  ["ctrlPersonaConfirm", "ctrlModeChoice", "ctrlContinueRound", "ctrlRetry"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = true;
  });
}

function showPersonasConfirmControl() {
  showControlPanel("ctrlPersonaConfirm");
}

async function confirmPersonasAndStart() {
  hideAllControlPanels();
  setSpinnerVisible(true);

  const config = getConfig();
  setStage("session", "active");
  showSection("session", true);
  setActiveRunPanel("session");

  if (config.runModePreference === "step") {
    state.runSubStage = "moderator-guide-running";
    setStageTimerLabel("启动逐轮深访");
    setRunStatus("逐轮深访启动中…", "受访者已确认，系统会先补充主持指南，然后进入第 1 轮访谈。");
    await runOneRound();
    return;
  }

  state.runSubStage = "session-running";
  setStageTimerLabel("启动完整访谈");
  setRunStatus("极速完整访谈启动中…", "受访者已确认，系统会自动连续生成各轮访谈并继续产出报告。");
  await runSessionAllAtOnce();
}

async function regeneratePersonas() {
  if (!window.confirm("确定重新生成受访者画像？已生成的内容将被替换。")) return;

  const config = getConfig();
  state.runToken += 1;
  state.personas = [];
  state.messages = [];
  state.reportMarkdown = "";
  state.reportComplete = false;
  state.moderatorGuide = null;
  state.participantStates = [];
  state.contextState = null;
  state.evidencePack = null;
  $("previewPersonas").innerHTML = "";
  showSection("session", false);
  showSection("report", false);
  hideAllControlPanels();
  setStage("personas", "active");
  renderRunReport();
  updateEvidencePackButton();

  await runPersonasStage(config, state.runToken);
}

/* ============================================================
   Persona edit modal
   ============================================================ */

let editingPersonaIndex = -1;

function buildRadarMetricsForEdit(persona) {
  if (persona.radarMetrics && persona.radarMetrics.length === 6) {
    return persona.radarMetrics.map((v) => Math.max(1, Math.min(10, Number(v) || 5)));
  }
  const sensitivity = Number(persona.priceSensitivity);
  const priceScore = Number.isNaN(sensitivity) ? 5 : Math.round(sensitivity / 10);
  const text = String(persona.segment || "") + " " + String(persona.snapshot || persona.bio || "");
  const innovation = /创新|尝鲜|新潮|科技|极客/.test(text) ? 8 : /保守|传统|稳健/.test(text) ? 3 : 5;
  const loyalty = /品牌|忠诚|固定|习惯/.test(text) ? 7 : /随意|无所谓|换着用/.test(text) ? 3 : 5;
  const rational = /理性|分析|数据|对比|研究/.test(text) ? 8 : /感性|冲动|直觉|跟风/.test(text) ? 3 : 6;
  const social = /社交|分享|推荐|影响|kol|意见领袖/.test(text) ? 8 : /独来独往|不太分享/.test(text) ? 3 : 5;
  const frequency = /每天|高频|日常|经常/.test(text) ? 8 : /偶尔|很少|几乎不/.test(text) ? 3 : 6;
  return [priceScore, innovation, loyalty, rational, social, frequency];
}

function openPersonaEditModal(index) {
  const persona = state.personas[index];
  if (!persona) return;
  editingPersonaIndex = index;

  $("editPersonaName").value = persona.name || "";
  $("editPersonaSegment").value = persona.segment || "";
  $("editPersonaSnapshot").value = persona.snapshot || "";
  $("editPersonaCurrent").value = persona.currentAlternative || persona.usageScenario || "";
  $("editPersonaTrigger").value = persona.switchTrigger || persona.decisionCriteria || "";
  $("editPersonaBudget").value = persona.budgetAnchor || "";
  $("editPersonaEvidence").value = persona.evidenceNeeded || persona.dealBreaker || "";
  $("editPersonaStyle").value = persona.speakingStyle || "";
  $("editPersonaConcerns").value = (persona.concerns || []).join("\n");

  const metrics = buildRadarMetricsForEdit(persona);
  for (let i = 0; i < 6; i++) {
    const slider = $("editRadar" + i);
    const output = $("outRadar" + i);
    if (slider) slider.value = metrics[i];
    if (output) output.textContent = metrics[i];
  }

  $("personaEditModal").hidden = false;
  document.body.classList.add("modal-open");
}

function closePersonaEditModal() {
  $("personaEditModal").hidden = true;
  document.body.classList.remove("modal-open");
  editingPersonaIndex = -1;
}

function savePersonaEdit() {
  if (editingPersonaIndex < 0 || editingPersonaIndex >= state.personas.length) return;
  const persona = state.personas[editingPersonaIndex];

  persona.name = $("editPersonaName").value.trim() || persona.name;
  persona.segment = $("editPersonaSegment").value.trim() || persona.segment;
  persona.snapshot = $("editPersonaSnapshot").value.trim();
  persona.currentAlternative = $("editPersonaCurrent").value.trim();
  persona.switchTrigger = $("editPersonaTrigger").value.trim();
  persona.budgetAnchor = $("editPersonaBudget").value.trim();
  persona.evidenceNeeded = $("editPersonaEvidence").value.trim();
  persona.speakingStyle = $("editPersonaStyle").value.trim();
  persona.concerns = $("editPersonaConcerns").value
    .split(/[\n,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const radarMetrics = [];
  for (let i = 0; i < 6; i++) {
    const val = Number($("editRadar" + i)?.value);
    radarMetrics.push(Math.max(1, Math.min(10, Number.isNaN(val) ? 5 : val)));
  }
  persona.radarMetrics = radarMetrics;

  renderPersonaGrid($("previewPersonas"), state.personas);
  // Preserve completed status — don't downgrade to draft
  const existing = state.projectId ? getProjectById(state.projectId) : null;
  const status = existing?.status === "completed" ? "completed" : "draft";
  persistCurrent(status);
  closePersonaEditModal();
  showToast("受访者信息已更新");
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

  // If there's existing data and NOT in edit mode, ask user what to do
  if (!state.editMode && (state.personas.length || state.messages.length)) {
    const choice = window.confirm(
      "检测到已有访谈数据。\n\n点击「确定」继续上次进度\n点击「取消」重新开始（会清除已有数据）"
    );
    if (choice) {
      // Continue from where we left off
      restoreDraftRunView({ config, personas: state.personas, messages: state.messages });
      return;
    }
    // User chose to start fresh — continue with the rest of the function
  }

  state.isRunning = true;
  state.abortController = new window.AbortController();
  state.runToken += 1;
  state.lastFailedSubStage = null;
  state.personas = [];
  state.messages = [];
  state.reportMarkdown = "";
  state.reportComplete = false;
  state.moderatorGuide = null;
  state.participantStates = [];
  state.contextState = null;
  state.evidencePack = null;
  state.topics = buildTopics(config);
  state.currentRound = 0;
  state.runMode = null;
  state.activeRunPanel = "personas";
  // Don't clear project ID if in edit mode
  if (!state.editMode) {
    state.projectId = null;
  }
  state.isViewOnly = false;

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

    // Show confirmation step instead of auto-proceeding
    state.runSubStage = "personas-confirm";
    setSpinnerVisible(false);

    if (state.editMode) {
      setRunStatus("受访者已重新生成", "可点击卡片上的「编辑」修改，或点击「完成修改」保存。");
      showEditPersonasControl();
    } else {
      setRunStatus("受访者已生成", "请查看上方受访者画像，可点击「编辑」修改内容，确认后开始访谈。");
      showPersonasConfirmControl();
    }
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
    state.runSubStage = "session-done";
    setSpinnerVisible(false);
    hideAllControlPanels();
    setRunStatus("访谈已全部完成", "点击下方按钮生成洞察报告。");
    showReportReadyControl();
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
      state.runSubStage = "session-done";
      setSpinnerVisible(false);
      hideAllControlPanels();
      setRunStatus("访谈已全部完成", "点击下方按钮生成洞察报告。");
      showReportReadyControl();
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
    state.reportComplete = false;
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
    state.reportComplete = true;
    state.reportStreaming = false;
    setStage("report", "done");
    await persistCurrentAsync("completed");
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
    state.abortController = new window.AbortController();
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
  state.abortController = new window.AbortController();
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
   Search status check
   ============================================================ */

async function checkSearchStatus() {
  const checkbox = $("useSearchEnhancement");
  const hint = $("searchUnavailableHint");
  if (!checkbox) return;
  try {
    const res = await fetch("/api/config", { headers: clientSettingsHeaders() });
    if (!res.ok) throw new Error("not ok");
    const data = await res.json();
    const s = data?.search;
    const available = s?.enabled && (!s?.requiresKey || s?.hasKey);
    if (available) {
      checkbox.disabled = false;
      checkbox.title = "";
      hint?.setAttribute("hidden", "");
    } else {
      checkbox.disabled = true;
      checkbox.checked = false;
      checkbox.title = "搜索未配置，不可用";
      hint?.removeAttribute("hidden");
    }
  } catch {
    // If we can't check, leave checkbox alone
  }
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

  checkSearchStatus();

  $("searchHintSettingsLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    setView("home");
    setNavPanel("profile");
  });

  $("startBtn").addEventListener("click", startRun);
  $("resetFormBtn").addEventListener("click", () => {
    if (!window.confirm("确定恢复示例数据？当前编辑的内容将丢失。")) return;
    resetProjectState();
    setConfig(EXAMPLE_DATA);
    saveDraft();
    showToast("已恢复示例数据");
  });

  $("cancelRunBtn").addEventListener("click", () => {
    if (state.isRunning) {
      if (!window.confirm("访谈仍在进行，确定返回？已经生成的内容将保存为草稿。")) return;
      cancelActiveRun();
    }
    resetProjectState();
    state.editMode = false;
    state.isViewOnly = false;
    updateConfigPageForEditMode();
    setView("home");
    setNavPanel("dashboard");
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
    if (event.key === "Escape") {
      if (!$("evidencePackModal").hidden) closeEvidencePackModal();
      if (!$("personaEditModal").hidden) closePersonaEditModal();
    }
  });

  // Persona confirm / regenerate buttons
  $("confirmPersonasBtn").addEventListener("click", confirmPersonasAndStart);
  $("regeneratePersonasBtn").addEventListener("click", regeneratePersonas);

  // Persona edit modal
  $("closePersonaEditBtn").addEventListener("click", closePersonaEditModal);
  $("cancelPersonaEditBtn").addEventListener("click", closePersonaEditModal);
  $("savePersonaEditBtn").addEventListener("click", savePersonaEdit);
  $("personaEditModal").addEventListener("click", (event) => {
    if (event.target.id === "personaEditModal") closePersonaEditModal();
  });

  // Radar slider live output
  for (let i = 0; i < 6; i++) {
    const slider = $("editRadar" + i);
    const output = $("outRadar" + i);
    if (slider && output) {
      slider.addEventListener("input", () => { output.textContent = slider.value; });
    }
  }

  // Sync radar from text fields
  $("syncRadarBtn")?.addEventListener("click", () => {
    const text = [
      $("editPersonaSegment")?.value || "",
      $("editPersonaSnapshot")?.value || "",
      $("editPersonaTrigger")?.value || "",
      $("editPersonaEvidence")?.value || "",
    ].join(" ");
    const inferred = [
      /贵|贵了|太贵|便宜|性价比|价格|399|预算/.test(text) ? 8 : /不差钱|无所谓价格|愿意付/.test(text) ? 3 : 5,
      /创新|尝鲜|新潮|科技|极客|智能|AI/.test(text) ? 8 : /保守|传统|稳健|不感冒/.test(text) ? 3 : 5,
      /品牌|忠诚|固定|习惯|一直用|老用户/.test(text) ? 7 : /随意|无所谓|换着用|不挑/.test(text) ? 3 : 5,
      /理性|分析|数据|对比|研究|参数|评测/.test(text) ? 8 : /感性|冲动|直觉|跟风|朋友推荐/.test(text) ? 3 : 6,
      /社交|分享|推荐|影响|kol|意见领袖|朋友圈/.test(text) ? 8 : /独来独往|不太分享|自己用/.test(text) ? 3 : 5,
      /每天|高频|日常|经常|重度/.test(text) ? 8 : /偶尔|很少|几乎不|轻度/.test(text) ? 3 : 6,
    ];
    for (let i = 0; i < 6; i++) {
      const slider = $("editRadar" + i);
      const output = $("outRadar" + i);
      if (slider) slider.value = inferred[i];
      if (output) output.textContent = inferred[i];
    }
    showToast("已根据文字内容推算画像维度");
  });

  // Persona edit delegation on persona grid
  const personaGrid = $("previewPersonas");
  if (personaGrid) {
    personaGrid.addEventListener("click", (event) => {
      const editBtn = event.target.closest("[data-action='edit-persona']");
      if (editBtn) {
        openPersonaEditModal(Number(editBtn.dataset.index));
      }
    });
  }

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

  $("regenInterviewBtn").addEventListener("click", () => {
    if (!window.confirm("重新生成访谈会清除现有对话记录，受访者保持不变。确定继续？")) return;
    state.messages = [];
    state.reportMarkdown = "";
    state.reportComplete = false;
    state.currentRound = 0;
    state.runMode = null;
    persistCurrent("draft");
    startRun();
  });

  $("copyReportBtn").addEventListener("click", copyReport);
  $("downloadReportBtn").addEventListener("click", downloadReport);

  bindRecentProjectsDelegation();
  renderRecentProjects();

  // Sidebar navigation
  document.querySelectorAll(".nav-item[data-nav]").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nav = item.dataset.nav;
      if (nav === "profile") {
        showProfilePage();
        return;
      }
      if (item.classList.contains("nav-parent")) {
        // Toggle group open/close
        const group = item.closest(".nav-group");
        if (group) group.classList.toggle("open");
      }
      if (state.view === "profile") setView("home");
      setNavPanel(nav);
    });
  });

  // Sub-items: project filters
  document.querySelectorAll(".nav-sub[data-filter]").forEach((sub) => {
    sub.addEventListener("click", (e) => {
      e.preventDefault();
      if (state.view !== "home") setView("home");
      setNavPanel("projects");
      setProjectFilter(sub.dataset.filter);
    });
  });

  // Sub-items: interview sections
  document.querySelectorAll(".nav-sub[data-section]").forEach((sub) => {
    sub.addEventListener("click", (e) => {
      e.preventDefault();
      if (state.view !== "home") setView("home");
      setNavPanel("interview");
      const sectionId = sub.dataset.section === "quickfill" ? "quickFillInput" : "projectName";
      setTimeout(() => scrollToSection(sectionId), 100);
    });
  });

  // Dashboard action cards
  document.querySelectorAll(".dash-action-card[data-goto]").forEach((card) => {
    card.addEventListener("click", () => {
      setNavPanel(card.dataset.goto);
    });
  });

  setNavPanel("dashboard");
  setProjectFilter("all");
  setView("home");
}

/* ============================================================
   Local mode shell
   ============================================================ */
const LOCAL_USER = {
  username: "local",
  displayName: "本地模式",
};

function showAppShell() {
  const appShell = $("appShell");
  if (appShell) appShell.hidden = false;
  document.body.classList.remove("on-login");
}

function updateSidebarUser(user = LOCAL_USER) {
  const avatar = $("userAvatar");
  const name = $("sidebarUserName");
  if (avatar) avatar.textContent = (user.displayName || user.username || "?").charAt(0);
  if (name) name.textContent = user.displayName || user.username;
}

function updateWelcomeBanner(user = LOCAL_USER) {
  const greeting = $("welcomeGreeting");
  const timeEl = $("welcomeTime");
  if (greeting) {
    const hour = new Date().getHours();
    let timeWord = "你好";
    if (hour < 6) timeWord = "夜深了";
    else if (hour < 12) timeWord = "早上好";
    else if (hour < 14) timeWord = "中午好";
    else if (hour < 18) timeWord = "下午好";
    else timeWord = "晚上好";
    greeting.textContent = `${timeWord}, ${user.displayName || user.username}!`;
  }
  if (timeEl) {
    const now = new Date();
    timeEl.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${["日", "一", "二", "三", "四", "五", "六"][now.getDay()]}`;
  }
}

/* ============================================================
   Personal center
   ============================================================ */
const PROVIDER_INFO = {
  "":          { models: ["gpt-4o", "gpt-4o-mini", "deepseek-chat", "glm-4-flash", "qwen-turbo"], endpoint: "使用全局配置" },
  openai:      { models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini", "o3-mini", "gpt-4-turbo"], endpoint: "https://api.openai.com/v1" },
  deepseek:    { models: ["deepseek-chat", "deepseek-reasoner", "deepseek-coder", "deepseek-v3", "deepseek-r1"], endpoint: "https://api.deepseek.com/v1" },
  moonshot:    { models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-k2"], endpoint: "https://api.moonshot.cn/v1" },
  groq:        { models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "llama-4-maverick-17b-128e-instruct", "llama-4-scout-17b-16e-instruct", "mixtral-8x7b-32768", "gemma2-9b-it", "qwen/qwen3-32b"], endpoint: "https://api.groq.com/openai/v1" },
  zhipu:       { models: ["glm-4-plus", "glm-4-flash", "glm-4-flashx", "glm-4-air", "glm-4-airx", "glm-4-long", "glm-4", "glm-z1-flash", "glm-z1-air", "glm-z1-airx", "glm-4v-plus"], endpoint: "https://open.bigmodel.cn/api/paas/v4" },
  qwen:        { models: ["qwen3-max", "qwen3-max-thinking", "qwen-plus", "qwen-turbo", "qwen-long", "qwen3-32b", "qwen3-14b", "qwen2.5-72b-instruct"], endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  openrouter:  { models: ["openai/gpt-4o", "openai/gpt-4o-mini", "openai/gpt-4.1", "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7", "google/gemini-2.5-flash", "google/gemini-2.5-pro", "deepseek/deepseek-chat", "deepseek/deepseek-r1", "meta-llama/llama-3.3-70b-instruct"], endpoint: "https://openrouter.ai/api/v1" },
  anthropic:   { models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"], endpoint: "https://api.anthropic.com/v1" },
  gemini:      { models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-1.5-flash", "gemini-1.5-pro"], endpoint: "https://generativelanguage.googleapis.com" },
  mimo:        { models: ["mimo-v2.5", "mimo-v2"], endpoint: "https://token-plan-sgp.xiaomimimo.com/v1" },
};

function getModelSelect() {
  return $("profileModel");
}

function populateModelSelect(provider, savedModel) {
  const select = getModelSelect();
  const info = PROVIDER_INFO[provider];
  const currentValue = select.value; // preserve selection if already set by user

  select.innerHTML = '<option value="">使用默认模型</option>';

  if (info && info.models) {
    info.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      select.appendChild(opt);
    });
  }

  // Restore selection: prefer savedModel, then currentValue, then default
  const target = savedModel || currentValue || "";
  if (target && [...select.options].some((o) => o.value === target)) {
    select.value = target;
  } else if (target) {
    // Saved model not in list — add it
    const opt = document.createElement("option");
    opt.value = target;
    opt.textContent = target + " (自定义)";
    opt.selected = true;
    select.appendChild(opt);
  }
}

function updateProviderHint() {
  const provider = $("profileApiProvider").value;
  const info = PROVIDER_INFO[provider] || PROVIDER_INFO[""];

  // Update endpoint hint
  $("profileBaseUrlHint").textContent = !provider ? "" : (info && info.endpoint ? `默认地址: ${info.endpoint}` : "");

  // Repopulate model dropdown (preserving saved value from the session)
  populateModelSelect(provider);

  // Update model hint
  if (info && info.models && info.models.length) {
    $("profileModelHint").textContent = `可选模型: ${info.models.length} 个 · 选「使用默认模型」则自动用 ${info.models[0]}`;
  } else {
    $("profileModelHint").textContent = "";
  }
}

function validateAndSaveSettings() {
  const provider = $("profileApiProvider").value;
  const apiKey = $("profileApiKey").value;
  const savedKeySet = $("profileApiKey").placeholder.includes("已设置");
  const baseUrl = $("profileApiBaseUrl").value;
  const model = $("profileModel").value;
  const info = PROVIDER_INFO[provider];

  // Check 1: no provider selected
  if (!provider) {
    showToast("请先选择 API 提供商");
    return;
  }
  // Check 2: selected provider but no API key
  if (!apiKey && !savedKeySet) {
    showToast("请填写该供应商的 API Key");
    return;
  }

  // Check 2: model filled but unknown for this provider (just warn)
  if (provider && model && info && info.models && !info.models.includes(model)) {
    if (!window.confirm(`「${model}」不在 ${provider} 的常用模型列表中，确定要使用吗？`)) {
      return;
    }
  }

  // Check 3: base URL doesn't match expected pattern
  if (provider && baseUrl && info && info.endpoint && !info.endpoint.startsWith("使用")) {
    const expectedBase = info.endpoint.replace(/\/v1\/*$/, "").replace(/\/v1beta\/*$/, "");
    if (!baseUrl.includes(expectedBase.replace(/^https?:\/\//, "").split("/")[0])) {
      if (!window.confirm(`Base URL 看起来不是 ${provider} 的地址（应为 ${info.endpoint}），确定要保存吗？`)) {
        return;
      }
    }
  }

  saveUserSettings();
}

function initProfilePage() {
  // Nav item for profile
  const profileNav = document.createElement("a");
  profileNav.className = "nav-item";
  profileNav.dataset.nav = "profile";
  profileNav.href = "#";
  profileNav.innerHTML = `
    <svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/></svg>
    <span>个人中心</span>
  `;
  const sidebarNav = document.querySelector(".sidebar-nav");
  if (sidebarNav) sidebarNav.appendChild(profileNav);

  // Save settings
  $("saveSettingsBtn").addEventListener("click", validateAndSaveSettings);

  // Provider hint
  $("profileApiProvider").addEventListener("change", updateProviderHint);
}

async function showProfilePage() {
  // Switch view FIRST so it's visible even if API call fails
  state.view = "profile";
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("viewProfile").classList.add("active");
  $("topbarTitle").textContent = "个人中心";

  // Highlight profile nav item, remove active from others
  document.querySelectorAll(".nav-item[data-nav]").forEach((item) => {
    if (!item.classList.contains("nav-sub")) {
      item.classList.toggle("active", item.dataset.nav === "profile");
    }
  });

  const user = LOCAL_USER;
  $("profileAvatar").textContent = (user?.displayName || user?.username || "?").charAt(0);
  $("profileName").textContent = user?.displayName || user?.username;
  $("profileUsername").textContent = "本机浏览器存储";

  const s = getLocalSettings();
  $("profileApiProvider").value = s.apiProvider || "";
  $("profileApiKey").value = s.apiKey || "";
  $("profileApiKey").placeholder = "必填：请输入 API Key";
  $("profileApiBaseUrl").value = s.apiBaseUrl || "";
  populateModelSelect(s.apiProvider, s.model || "");
  $("profileSearchProvider").value = s.searchProvider || "";
  $("profileSearchApiKey").value = s.searchApiKey || "";
  $("profileSearchApiKey").placeholder = "选了提供商后填写";
  updateProviderHint();
}

async function saveUserSettings() {
  try {
    saveLocalSettings({
      apiProvider: $("profileApiProvider").value,
      apiKey: $("profileApiKey").value,
      apiBaseUrl: $("profileApiBaseUrl").value,
      model: $("profileModel").value,
      searchProvider: $("profileSearchProvider").value,
      searchApiKey: $("profileSearchApiKey").value,
    });
    showToast("设置已保存");
    checkSearchStatus();
  } catch (err) {
    showToast("保存失败: " + err.message);
  }
}

/* ============================================================
   Clear stale login keys from older builds
   ============================================================ */
function clearLegacyLocalStorage() {
  try {
    localStorage.removeItem("focus-group-auth-token");
    localStorage.removeItem("focus-group-auth-user");
  } catch {}
}

/* ============================================================
   App init
   ============================================================ */
async function initLocalApp() {
  initProfilePage();
  updateSidebarUser();
  updateWelcomeBanner();
  showAppShell();
  clearLegacyLocalStorage();
  init();
}

initLocalApp();
