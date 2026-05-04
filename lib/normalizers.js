const { cleanGeneratedText, truncateText } = require("./text-utils");

function normalizePersonas(personas, expectedCount) {
  if (!Array.isArray(personas)) {
    throw new Error("personas must be an array");
  }

  return personas.slice(0, expectedCount).map((persona, index) => ({
    id: persona.id || `p${index + 1}`,
    name: persona.name || `受访者${index + 1}`,
    segment: persona.segment || "目标用户",
    age: Number(persona.age) || 30,
    job: persona.job || "未说明职业",
    income: persona.income || "中等",
    motivation: persona.motivation || "关注产品是否能解决实际问题",
    concerns: Array.isArray(persona.concerns) ? persona.concerns.slice(0, 4) : ["价格", "稳定性", "必要性"],
    speakingStyle: persona.speakingStyle || "自然、真实",
    usageScenario: persona.usageScenario || persona.scenario || "在真实使用场景中评估产品是否有必要",
    decisionCriteria: persona.decisionCriteria || "能否明确解决当前痛点且成本合理",
    dealBreaker: persona.dealBreaker || "实际效果无法证明或使用成本过高",
    priceSensitivity: clampMetric(persona.priceSensitivity),
    adoption: clampMetric(persona.adoption),
    skepticism: clampMetric(persona.skepticism),
  }));
}

function normalizeModeratorGuide(data) {
  const guide = data?.moderatorGuide || data?.guide || data;
  const safeArray = (value) => (Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : []);
  const roundPlan = Array.isArray(guide?.roundPlan)
    ? guide.roundPlan.map((round, index) => ({
        round: Number(round.round) || index + 1,
        objective: cleanGeneratedText(round.objective || round.goal || ""),
        keyQuestion: cleanGeneratedText(round.keyQuestion || round.question || ""),
        mustProbe: safeArray(round.mustProbe || round.probes),
        shallowAnswerSignals: safeArray(round.shallowAnswerSignals || round.risks),
      }))
    : [];

  return {
    researchObjectives: safeArray(guide?.researchObjectives || guide?.objectives),
    coreHypotheses: safeArray(guide?.coreHypotheses || guide?.hypotheses),
    roundPlan,
    probeStrategies: safeArray(guide?.probeStrategies),
    redFlags: safeArray(guide?.redFlags),
  };
}

function formatModeratorGuide(guide) {
  if (!guide || typeof guide !== "object") return "（尚未生成主持指南）";
  return JSON.stringify(normalizeModeratorGuide(guide));
}

function createInitialParticipantStates(personas) {
  return personas.map((persona) => ({
    name: persona.name,
    currentAttitude: "尚未发言，初始立场未知",
    mentionedConcerns: persona.concerns || [],
    conditionsToBuy: [],
    objections: [],
    evidenceNeeded: [],
    contradictions: [persona.dealBreaker].filter(Boolean),
    concreteExamples: [],
    alternativeComparisons: [],
    quoteCandidates: [],
    followUpQuestions: [],
    lastRoundTakeaway: "",
  }));
}

function inferParticipantStatesAfterFullSession({ personas, participantStates, messages }) {
  const states = normalizeParticipantStates(participantStates, personas);
  const bySpeaker = new Map();
  (messages || []).forEach((message) => {
    if (message.type !== "participant") return;
    if (!bySpeaker.has(message.speaker)) bySpeaker.set(message.speaker, []);
    bySpeaker.get(message.speaker).push(message);
  });

  return states.map((state) => {
    const speakerMessages = bySpeaker.get(state.name) || [];
    const lastMessage = speakerMessages[speakerMessages.length - 1];
    return {
      ...state,
      currentAttitude: lastMessage ? "已完成完整访谈，详见最终发言和报告分析" : state.currentAttitude,
      lastRoundTakeaway: lastMessage ? truncateText(lastMessage.text, 120) : state.lastRoundTakeaway,
    };
  });
}

function normalizeParticipantStates(states, personas) {
  const stateMap = new Map(
    (Array.isArray(states) ? states : []).map((state) => [state?.name, state]),
  );
  const safeList = (value) => {
    if (Array.isArray(value)) return value.map((item) => cleanGeneratedText(item)).filter(Boolean).slice(0, 5);
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  };

  return personas.map((persona) => {
    const existing = stateMap.get(persona.name) || {};
    return {
      name: persona.name,
      currentAttitude: cleanGeneratedText(existing.currentAttitude) || "尚未形成明确立场",
      mentionedConcerns: safeList(existing.mentionedConcerns).length
        ? safeList(existing.mentionedConcerns)
        : (persona.concerns || []).slice(0, 4),
      conditionsToBuy: safeList(existing.conditionsToBuy),
      objections: safeList(existing.objections),
      evidenceNeeded: safeList(existing.evidenceNeeded),
      contradictions: safeList(existing.contradictions).length
        ? safeList(existing.contradictions)
        : [persona.dealBreaker].filter(Boolean),
      concreteExamples: safeList(existing.concreteExamples),
      alternativeComparisons: safeList(existing.alternativeComparisons),
      quoteCandidates: safeList(existing.quoteCandidates),
      followUpQuestions: safeList(existing.followUpQuestions),
      lastRoundTakeaway: cleanGeneratedText(existing.lastRoundTakeaway || ""),
    };
  });
}

function normalizeSessionMessages(data, personas, topics, options = {}) {
  const rawMessages = extractMessageArray(data);
  const speakerMap = new Map(personas.map((persona) => [persona.name, persona.segment]));
  const personaNames = new Set(personas.map((persona) => persona.name));
  const normalized = [];

  rawMessages.forEach((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error(`messages[${index}] must be an object`);
    }

    const text = cleanGeneratedText(message.text || message.content || message.message || "");
    if (!text) return;

    const rawSpeaker = cleanGeneratedText(message.speaker || message.name || "");
    const isModerator =
      message.type === "moderator" ||
      rawSpeaker.includes("主持") ||
      rawSpeaker.toLowerCase() === "moderator";
    const speaker = isModerator ? "AI 主持人" : resolveParticipantSpeaker(rawSpeaker, personas);

    if (!isModerator && !personaNames.has(speaker)) {
      throw new Error(`messages[${index}].speaker "${speaker || "(empty)"}" is not in personas`);
    }

    const round = options.fixedRound || normalizeRound(message.round, topics.length, index, personas.length + 1);
    normalized.push({
      round,
      speaker,
      segment: isModerator ? "主持" : speakerMap.get(speaker) || "受访者",
      type: isModerator ? "moderator" : "participant",
      text,
    });
  });

  if (!normalized.length) {
    throw new Error("Model returned no valid session messages");
  }

  return normalized;
}

function extractMessageArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.transcript)) return data.transcript;
  if (Array.isArray(data?.rounds)) {
    return data.rounds.flatMap((round) => {
      const roundNumber = Number(round.round || round.roundNumber);
      const messages = Array.isArray(round.messages) ? round.messages : [];
      return messages.map((message) => ({ ...message, round: message.round || roundNumber }));
    });
  }
  throw new Error("Model did not return a messages array");
}

function resolveParticipantSpeaker(rawSpeaker, personas) {
  const speaker = cleanGeneratedText(rawSpeaker);
  if (!speaker) return speaker;
  const exact = personas.find((persona) => persona.name === speaker);
  if (exact) return exact.name;
  const contained = personas.find((persona) => speaker.includes(persona.name) || persona.name.includes(speaker));
  return contained ? contained.name : speaker;
}

function splitPersonasForRound(personas) {
  const midpoint = Math.ceil(personas.length / 2);
  const firstWave = personas.slice(0, midpoint);
  const secondWave = personas.slice(midpoint);
  return [firstWave, secondWave.length ? secondWave : firstWave];
}

function normalizeRound(value, topicCount, index, expectedRoundSize) {
  const round = Number(value);
  if (Number.isInteger(round) && round >= 1 && round <= topicCount) {
    return round;
  }
  return Math.min(topicCount, Math.max(1, Math.floor(index / expectedRoundSize) + 1));
}

function clampMetric(value) {
  const number = Number(value);
  if (Number.isNaN(number)) return 50;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function toPromptPersona(persona) {
  return {
    name: persona.name,
    segment: persona.segment,
    age: persona.age,
    job: persona.job,
    motivation: persona.motivation,
    concerns: (persona.concerns || []).slice(0, 4),
    speakingStyle: persona.speakingStyle,
    usageScenario: persona.usageScenario,
    decisionCriteria: persona.decisionCriteria,
    dealBreaker: persona.dealBreaker,
    priceSensitivity: persona.priceSensitivity,
    adoption: persona.adoption,
    skepticism: persona.skepticism,
  };
}

function limitPersonas(personas) {
  return personas.length > 10 ? personas.slice(0, 10) : personas;
}

module.exports = {
  normalizePersonas,
  normalizeModeratorGuide,
  formatModeratorGuide,
  createInitialParticipantStates,
  inferParticipantStatesAfterFullSession,
  normalizeParticipantStates,
  normalizeSessionMessages,
  extractMessageArray,
  resolveParticipantSpeaker,
  splitPersonasForRound,
  normalizeRound,
  clampMetric,
  toPromptPersona,
  limitPersonas,
};
