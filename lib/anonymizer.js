const { cleanGeneratedText, truncateText } = require("./text-utils");
const { normalizeParticipantStates } = require("./normalizers");

function buildAnonymizedReportContext({ config, personas, messages, moderatorGuide, participantStates, contextState, buildReportContextState }) {
  const aliasByName = new Map(personas.map((persona, index) => [persona.name, `R${index + 1}`]));
  const segmentByName = new Map(personas.map((persona) => [persona.name, persona.segment || "目标用户"]));
  const anonymousPersonas = personas.map((persona, index) => {
    const alias = `R${index + 1}`;
    return [
      `${alias}`,
      persona.segment || "目标用户",
      persona.age ? `${persona.age}岁` : "",
      persona.job || "",
      persona.motivation ? `动机：${anonymizeText(persona.motivation, aliasByName)}` : "",
      persona.dealBreaker ? `硬阻力：${anonymizeText(persona.dealBreaker, aliasByName)}` : "",
      `价格敏感度${persona.priceSensitivity || "-"}`,
      `采纳意愿${persona.adoption || "-"}`,
      `怀疑度${persona.skepticism || "-"}`,
    ]
      .filter(Boolean)
      .join("，");
  });

  const reportMessages = selectReportMessages(messages);
  const messagesText = reportMessages
    .map((message) => {
      const isModerator = message.type === "moderator" || String(message.speaker || "").includes("主持");
      const speaker = isModerator ? "主持人" : aliasByName.get(message.speaker) || "受访者";
      const segment = isModerator ? "" : `（${segmentByName.get(message.speaker) || "目标用户"}）`;
      const text = truncateText(anonymizeText(message.text, aliasByName), 220);
      return `第${message.round || "-"}轮｜${speaker}${segment}：${text}`;
    })
    .join("\n");

  const anonymousStates = normalizeParticipantStates(participantStates, personas).map((state) => ({
    participant: aliasByName.get(state.name) || "R?",
    segment: segmentByName.get(state.name) || "目标用户",
    currentAttitude: anonymizeText(state.currentAttitude, aliasByName),
    mentionedConcerns: anonymizeTextList(state.mentionedConcerns, aliasByName),
    conditionsToBuy: anonymizeTextList(state.conditionsToBuy, aliasByName),
    objections: anonymizeTextList(state.objections, aliasByName),
    evidenceNeeded: anonymizeTextList(state.evidenceNeeded, aliasByName),
    contradictions: anonymizeTextList(state.contradictions, aliasByName),
    concreteExamples: anonymizeTextList(state.concreteExamples, aliasByName),
    alternativeComparisons: anonymizeTextList(state.alternativeComparisons, aliasByName),
    quoteCandidates: anonymizeTextList(state.quoteCandidates, aliasByName),
    followUpQuestions: anonymizeTextList(state.followUpQuestions, aliasByName),
    lastRoundTakeaway: anonymizeText(state.lastRoundTakeaway, aliasByName),
  }));
  const reportContextState = buildReportContextState({
    config,
    personas,
    messages,
    moderatorGuide,
    participantStates,
    contextState,
  });

  return {
    personasText: anonymousPersonas.join("\n"),
    messagesText,
    participantStates: anonymousStates,
    contextState: anonymizeStructuredValue(reportContextState, aliasByName),
  };
}

function selectReportMessages(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const maxMessages = 90;
  if (safeMessages.length <= maxMessages) return safeMessages;
  const headCount = 24;
  const tailCount = maxMessages - headCount;
  return [
    ...safeMessages.slice(0, headCount),
    {
      round: "...",
      speaker: "AI 主持人",
      type: "moderator",
      text: `中间省略 ${safeMessages.length - maxMessages} 条发言，报告应优先依据已提供的匿名访谈记录和最终立场记忆做归纳。`,
    },
    ...safeMessages.slice(-tailCount),
  ];
}

function anonymizeTextList(value, aliasByName) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => anonymizeText(item, aliasByName)).filter(Boolean).slice(0, 5);
}

function anonymizeStructuredValue(value, aliasByName) {
  if (Array.isArray(value)) {
    return value.map((item) => anonymizeStructuredValue(item, aliasByName));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, anonymizeStructuredValue(item, aliasByName)]),
    );
  }
  if (typeof value === "string") {
    return anonymizeText(value, aliasByName);
  }
  return value;
}

function anonymizeText(text, aliasByName) {
  let result = cleanGeneratedText(text);
  const names = [...aliasByName.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  names.forEach((name) => {
    result = result.replace(new RegExp(escapeRegExp(name), "g"), aliasByName.get(name));
  });
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  buildAnonymizedReportContext,
  selectReportMessages,
  anonymizeText,
  anonymizeTextList,
  anonymizeStructuredValue,
  escapeRegExp,
};
