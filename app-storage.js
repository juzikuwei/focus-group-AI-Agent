/* ============================================================
   localStorage: drafts + project history
   ============================================================ */

import {
  state,
  fields,
  defaultData,
  getRawConfig,
  setConfig,
  getConfig,
  buildTopics,
  getCompletedRoundCount,
} from "./app-state.js";

const STORAGE_DRAFT_KEY = "focus-group-mvp:config";
const STORAGE_PROJECTS_KEY = "focus-group-mvp:projects";
export const PROJECTS_CAP = 30;
export const RECENT_DISPLAY = 6;

let saveDraftTimer = null;
const SAVE_DRAFT_DEBOUNCE_MS = 300;

let projectsCache = null;

export function saveDraft() {
  if (saveDraftTimer) window.clearTimeout(saveDraftTimer);
  saveDraftTimer = window.setTimeout(() => {
    saveDraftTimer = null;
    try {
      localStorage.setItem(STORAGE_DRAFT_KEY, JSON.stringify(getRawConfig()));
    } catch (error) {
      console.warn("草稿保存失败：", error);
    }
  }, SAVE_DRAFT_DEBOUNCE_MS);
}

export function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function loadProjects() {
  if (projectsCache !== null) return projectsCache;
  try {
    const raw = localStorage.getItem(STORAGE_PROJECTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    projectsCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    projectsCache = [];
  }
  return projectsCache;
}

export function saveProjects(projects) {
  const trimmed = projects.slice(0, PROJECTS_CAP);
  projectsCache = trimmed;
  try {
    localStorage.setItem(STORAGE_PROJECTS_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.warn("项目保存失败：", error);
  }
}

export function upsertProject(project) {
  const list = loadProjects().filter((p) => p.id !== project.id);
  list.unshift(project);
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  saveProjects(list);
}

export function deleteProjectById(id) {
  const list = loadProjects().filter((p) => p.id !== id);
  saveProjects(list);
}

export function getProjectById(id) {
  return loadProjects().find((p) => p.id === id) || null;
}

export function newProjectId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function buildProjectSnapshot(status) {
  const config = getRawConfig();
  return {
    id: state.projectId || newProjectId(),
    name: config.projectName || "未命名项目",
    createdAt: state.projectId ? getProjectById(state.projectId)?.createdAt || Date.now() : Date.now(),
    updatedAt: Date.now(),
    status,
    config,
    personas: state.personas,
    messages: state.messages,
    reportMarkdown: state.reportMarkdown,
    moderatorGuide: state.moderatorGuide,
    participantStates: state.participantStates,
    contextState: state.contextState,
    evidencePack: state.evidencePack,
    topics: state.topics,
    currentRound: state.currentRound,
    runMode: state.runMode,
  };
}

export function persistCurrent(status) {
  const snapshot = buildProjectSnapshot(status);
  state.projectId = snapshot.id;
  upsertProject(snapshot);
}

export function loadProjectIntoState(project) {
  state.projectId = project.id;
  state.personas = project.personas || [];
  state.messages = project.messages || [];
  state.reportMarkdown = project.reportMarkdown || "";
  state.moderatorGuide = project.moderatorGuide || null;
  state.participantStates = Array.isArray(project.participantStates) ? project.participantStates : [];
  state.contextState = project.contextState || null;
  state.evidencePack = project.evidencePack || null;
  setConfig({ ...defaultData, ...(project.config || {}) });
  state.topics = Array.isArray(project.topics) && project.topics.length
    ? project.topics
    : buildTopics(getConfig());
  state.currentRound = Number(project.currentRound) || getCompletedRoundCount(state.messages);
  state.runMode = project.runMode || (state.messages.length ? "step" : null);
}
