/* ============================================================
   App state, config, DOM helper
   ============================================================ */

export const $ = (id) => document.getElementById(id);

export const defaultData = {
  projectName: "智能随行咖啡杯上市前访谈",
  productConcept:
    "一款可通过手机 App 控温、记录饮水和咖啡因摄入、支持无线充电的智能随行咖啡杯，目标是帮助通勤人群保持合适饮用温度并管理咖啡摄入。",
  coreSellingPoints:
    "45-65 摄氏度精确控温；App 记录咖啡因摄入；杯身轻量防漏；无线充电底座；售价 399 元。",
  targetAudience: "一二线城市 22-40 岁通勤白领、咖啡爱好者、注重效率和生活品质的人群。",
  discussionTopics:
    "第一眼是否觉得这个产品有用？\n399 元是否能接受？\n哪些功能最有吸引力？\n最大的购买顾虑是什么？\n如果只能改一个地方，应该改什么？",
  participantCount: "5",
  roundCount: "5",
  tone: "犀利",
  outputDepth: "标准",
};

export const fields = [
  "projectName",
  "productConcept",
  "coreSellingPoints",
  "targetAudience",
  "discussionTopics",
  "participantCount",
  "roundCount",
  "tone",
  "outputDepth",
];

export const state = {
  view: "home",
  projectId: null,
  personas: [],
  messages: [],
  reportMarkdown: "",
  moderatorGuide: null,
  participantStates: [],
  contextState: null,
  evidencePack: null,
  topics: [],
  currentRound: 0,
  runMode: null,
  runSubStage: null,
  isQuickFilling: false,
  isRunning: false,
  runStage: null,
  abortController: null,
  runToken: 0,
  timerId: null,
  directProgressTimerId: null,
  runStartedAt: 0,
  stageStartedAt: 0,
  currentStageLabel: "",
  lastFailedSubStage: null,
  activeRunPanel: "personas",
};

export function getConfig() {
  const config = fields.reduce((result, key) => {
    result[key] = $(key).value.trim();
    return result;
  }, {});
  config.participantCount = clampNumber(config.participantCount, 5, 10);
  config.roundCount = clampNumber(config.roundCount, 3, 10);
  $("participantCount").value = config.participantCount;
  $("roundCount").value = config.roundCount;
  return config;
}

export function getRawConfig() {
  return fields.reduce((config, key) => {
    config[key] = $(key).value.trim();
    return config;
  }, {});
}

export function setConfig(data) {
  fields.forEach((key) => {
    if (data[key] !== undefined) $(key).value = data[key];
  });
}

export function clampNumber(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

export function buildTopics(config) {
  const userTopics = config.discussionTopics
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fallbackTopics = [
    "第一眼是否觉得这个产品有用？",
    "这个产品最可能在哪些真实场景中被使用？",
    "和现有替代方案比，会怎么选？",
    "最大的购买顾虑是什么？",
    "如果上线，你会怎么用？",
    "什么样的功能/价格能让你愿意尝试？",
    "想到什么相关的产品或服务？",
    "这个产品最值得保留的一个点是什么？",
    "最值得改的一个点是什么？",
    "整体上，你的态度是什么？",
  ];
  const merged = [...userTopics];
  for (let i = 0; merged.length < config.roundCount && i < fallbackTopics.length; i += 1) {
    if (!merged.includes(fallbackTopics[i])) merged.push(fallbackTopics[i]);
  }
  return merged.slice(0, config.roundCount);
}

export function getCompletedRoundCount(messages) {
  const rounds = (messages || [])
    .map((message) => Number(message.round))
    .filter((round) => Number.isInteger(round) && round > 0);
  return rounds.length ? Math.max(...rounds) : 0;
}

export function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
