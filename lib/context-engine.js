function createInitialContextState({ config = {}, topics = [], moderatorGuide = null, personas = [], participantStates = [] } = {}) {
  const guide = moderatorGuide || {};
  const unresolvedQuestions = [];

  (Array.isArray(guide.roundPlan) ? guide.roundPlan : []).forEach((round, index) => {
    const topic = topics[index] || round?.topic || `第 ${index + 1} 轮`;
    if (round?.keyQuestion) unresolvedQuestions.push(`第 ${index + 1} 轮 ${topic}：${round.keyQuestion}`);
    normalizeStringList(round?.mustProbe).forEach((probe) => unresolvedQuestions.push(`第 ${index + 1} 轮追问：${probe}`));
  });

  normalizeParticipantMemory(participantStates, personas).forEach((memory) => {
    normalizeStringList(memory.contradictions).forEach((item) => unresolvedQuestions.push(`${memory.name} 的矛盾点：${item}`));
  });

  return normalizeContextState(
    {
      schemaVersion: 2,
      project: buildProjectBrief(config),
      researchGoals: normalizeStringList(guide.researchObjectives),
      coreHypotheses: normalizeStringList(guide.coreHypotheses),
      roundMemory: [],
      unresolvedQuestions,
      evidenceLedger: [],
      externalFindings: [],
    },
    { config, topics, moderatorGuide, personas, participantStates },
  );
}

function normalizeContextState(input, { config = {}, topics = [], moderatorGuide = null, personas = [], participantStates = [] } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const guide = moderatorGuide || {};
  const memorySource = Array.isArray(participantStates) && participantStates.length
    ? participantStates
    : source.participantMemory;
  const project = {
    ...buildProjectBrief(config),
    ...(source.project && typeof source.project === "object" ? source.project : {}),
  };

  return {
    schemaVersion: 2,
    project,
    researchGoals: capList(
      normalizeStringList(source.researchGoals).length ? source.researchGoals : guide.researchObjectives,
      8,
    ),
    coreHypotheses: capList(
      normalizeStringList(source.coreHypotheses).length ? source.coreHypotheses : guide.coreHypotheses,
      8,
    ),
    roundMemory: normalizeRoundMemory(source.roundMemory).slice(-10),
    unresolvedQuestions: capList(source.unresolvedQuestions, 14),
    evidenceLedger: normalizeEvidenceLedger(source.evidenceLedger).slice(-40),
    externalFindings: normalizeExternalFindings(source.externalFindings).slice(-12),
    participantMemory: normalizeParticipantMemory(memorySource, personas),
    topics: normalizeStringList(source.topics).length ? capList(source.topics, 12) : capList(topics, 12),
  };
}

function buildRoundPromptContext({ config, personas, topic, roundNumber, priorMessages = [], moderatorGuide, participantStates, contextState }) {
  const state = normalizeContextState(contextState, { config, topics: [], moderatorGuide, personas, participantStates });
  const guideRound = findGuideRound(moderatorGuide, roundNumber);
  const participantMemory = normalizeParticipantMemory(participantStates, personas);
  const previousRounds = state.roundMemory.filter((round) => Number(round.round) < Number(roundNumber)).slice(-3);
  const currentTopicQuestions = state.unresolvedQuestions.filter((item) => isRelatedToTopic(item, topic)).slice(0, 5);
  const fallbackQuestions = state.unresolvedQuestions.filter((item) => !currentTopicQuestions.includes(item)).slice(0, 5);

  return {
    schemaVersion: 2,
    projectBrief: buildProjectBrief(config),
    currentRound: {
      round: Number(roundNumber),
      topic,
      objective: guideRound?.objective || "",
      keyQuestion: guideRound?.keyQuestion || "",
      mustProbe: normalizeStringList(guideRound?.mustProbe).slice(0, 5),
      shallowAnswerSignals: normalizeStringList(guideRound?.shallowAnswerSignals).slice(0, 5),
    },
    researchGoals: normalizeStringList(state.researchGoals).slice(0, 6),
    coreHypotheses: normalizeStringList(state.coreHypotheses).slice(0, 6),
    previousRounds,
    unresolvedQuestions: [...currentTopicQuestions, ...fallbackQuestions].slice(0, 8),
    participantMemory,
    recentEvidence: state.evidenceLedger.slice(-12),
    externalFindings: state.externalFindings.slice(0, 5),
    recentTranscript: summarizeRecentTranscript(priorMessages, 18, 140),
  };
}

function buildParticipantPromptContext({
  contextState,
  participantStates,
  personas,
  persona,
  topic,
  roundNumber,
  crossRoundContext = true,
} = {}) {
  const state = normalizeContextState(contextState, { personas, participantStates });
  const participantMemory = normalizeParticipantMemory(participantStates, personas);
  const personaName = persona?.name || "";
  const ownMemory = participantMemory.find((memory) => memory.name === personaName) || {};
  const relatedEvidence = state.evidenceLedger
    .filter((item) => item.speaker === personaName || isRelatedToTopic(item.text, topic))
    .slice(-8);

  if (!crossRoundContext) {
    return {
      schemaVersion: 2,
      round: Number(roundNumber),
      topic,
      contextPolicy: "current_round_only",
      instruction: "受访者只知道自己的人设、主持人本轮公开提出的问题和本轮当前实录；不要声称知道上一轮完整讨论或外部资料。",
      ownMemory: buildPersonaOnlyParticipantMemory(persona, ownMemory),
      relevantGroupMemory: [],
      unresolvedQuestions: [],
      recentEvidence: [],
      externalFindings: [],
    };
  }

  return {
    schemaVersion: 2,
    round: Number(roundNumber),
    topic,
    ownMemory,
    relevantGroupMemory: participantMemory
      .filter((memory) => memory.name !== persona.name)
      .map((memory) => ({
        name: memory.name,
        currentAttitude: memory.currentAttitude,
        lastRoundTakeaway: memory.lastRoundTakeaway,
        objections: normalizeStringList(memory.objections).slice(0, 3),
        contradictions: normalizeStringList(memory.contradictions).slice(0, 3),
      })),
    unresolvedQuestions: state.unresolvedQuestions.slice(0, 8),
    recentEvidence: relatedEvidence,
    externalFindings: state.externalFindings.slice(0, 5),
  };
}

function buildPersonaOnlyParticipantMemory(persona = {}, fallback = {}) {
  const concerns = capList(persona.concerns || fallback.mentionedConcerns, 5);
  const dealBreaker = persona.dealBreaker || persona.evidenceNeeded || concerns[0];
  return {
    name: cleanText(persona.name || fallback.name),
    segment: cleanText(persona.segment || fallback.segment || "目标用户"),
    currentAttitude: "本轮根据人设、主持人问题和本轮其他受访者发言自然形成态度。",
    mentionedConcerns: concerns,
    conditionsToBuy: [],
    objections: capList([dealBreaker, ...concerns], 5),
    evidenceNeeded: capList([persona.evidenceNeeded], 3),
    contradictions: capList([dealBreaker], 3),
    concreteExamples: [],
    alternativeComparisons: capList([persona.currentAlternative], 3),
    quoteCandidates: [],
    followUpQuestions: [],
    lastRoundTakeaway: "",
  };
}

function updateContextStateAfterRound({
  config,
  personas = [],
  topic,
  roundNumber,
  contextState,
  participantStates = [],
  roundMessages = [],
  summaryMessage = null,
  moderatorGuide = null,
  isFinalRound = false,
}) {
  const state = normalizeContextState(contextState, { config, moderatorGuide, personas, participantStates });
  const participantMemory = normalizeParticipantMemory(participantStates, personas);
  const participantMessages = (roundMessages || []).filter((message) => message?.type === "participant");
  const evidence = selectEvidenceMessages(participantMessages, personas, roundNumber);
  const roundSummary = summaryMessage?.text || buildFallbackRoundSummary(participantMessages, topic);
  const openQuestions = inferOpenQuestions({ participantMemory, roundSummary, topic, roundNumber, moderatorGuide, isFinalRound });

  const nextRoundMemory = [
    ...state.roundMemory.filter((item) => Number(item.round) !== Number(roundNumber)),
    {
      round: Number(roundNumber),
      topic,
      summary: truncateText(roundSummary, 260),
      participantTakeaways: participantMemory
        .map((memory) => `${memory.name}：${memory.lastRoundTakeaway || memory.currentAttitude}`)
        .filter(Boolean)
        .slice(0, 8),
      unresolvedQuestions: openQuestions.slice(0, 8),
      keyEvidence: evidence.map((item) => ({
        speaker: item.speaker,
        segment: item.segment,
        signal: item.signal,
        text: item.text,
      })),
    },
  ].sort((a, b) => Number(a.round) - Number(b.round));

  return normalizeContextState(
    {
      ...state,
      project: buildProjectBrief(config),
      participantMemory,
      roundMemory: nextRoundMemory,
      unresolvedQuestions: mergeDedupe([...openQuestions, ...state.unresolvedQuestions]).slice(0, 14),
      evidenceLedger: [...state.evidenceLedger, ...evidence].slice(-40),
      externalFindings: state.externalFindings,
    },
    { config, moderatorGuide, personas, participantStates },
  );
}

function buildReportContextState({ config, personas, messages, moderatorGuide, participantStates, contextState }) {
  let state = normalizeContextState(contextState, { config, moderatorGuide, personas, participantStates });
  if (!state.roundMemory.length && Array.isArray(messages) && messages.length) {
    const byRound = groupByRound(messages);
    Object.entries(byRound).forEach(([round, roundMessages]) => {
      state = updateContextStateAfterRound({
        config,
        personas,
        topic: `第 ${round} 轮`,
        roundNumber: Number(round),
        contextState: state,
        participantStates,
        roundMessages,
        summaryMessage: roundMessages.filter((message) => message.type === "moderator").slice(-1)[0],
        moderatorGuide,
      });
    });
  }
  return state;
}

function buildProjectBrief(config = {}) {
  return {
    projectName: cleanText(config.projectName),
    productConcept: cleanText(config.productConcept),
    coreSellingPoints: cleanText(config.coreSellingPoints),
    targetAudience: cleanText(config.targetAudience),
  };
}

function normalizeParticipantMemory(states, personas = []) {
  const stateMap = new Map(
    (Array.isArray(states) ? states : []).map((state) => [state?.name, state]),
  );
  return (Array.isArray(personas) ? personas : []).map((persona) => {
    const state = stateMap.get(persona.name) || {};
    return {
      name: persona.name,
      segment: cleanText(persona.segment || state.segment || "目标用户"),
      currentAttitude: cleanText(state.currentAttitude) || "尚未形成明确立场",
      mentionedConcerns: capList(state.mentionedConcerns || persona.concerns, 5),
      conditionsToBuy: capList(state.conditionsToBuy, 5),
      objections: capList(state.objections, 5),
      evidenceNeeded: capList(state.evidenceNeeded, 5),
      contradictions: capList(state.contradictions || [persona.dealBreaker], 5),
      concreteExamples: capList(state.concreteExamples, 5),
      alternativeComparisons: capList(state.alternativeComparisons, 5),
      quoteCandidates: capList(state.quoteCandidates, 5),
      followUpQuestions: capList(state.followUpQuestions, 5),
      lastRoundTakeaway: cleanText(state.lastRoundTakeaway),
    };
  });
}

function normalizeRoundMemory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      round: Number(item?.round) || 0,
      topic: cleanText(item?.topic),
      summary: truncateText(item?.summary, 280),
      participantTakeaways: capList(item?.participantTakeaways, 8),
      unresolvedQuestions: capList(item?.unresolvedQuestions, 8),
      keyEvidence: normalizeEvidenceLedger(item?.keyEvidence).slice(0, 8),
    }))
    .filter((item) => item.round > 0);
}

function normalizeEvidenceLedger(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      round: item?.round === "..." ? "..." : Number(item?.round) || 0,
      speaker: cleanText(item?.speaker),
      segment: cleanText(item?.segment || "受访者"),
      signal: cleanText(item?.signal || "观点证据"),
      text: truncateText(item?.text, 220),
    }))
    .filter((item) => item.text);
}

function normalizeExternalFindings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      source: cleanText(item?.source || "external"),
      title: truncateText(item?.title, 120),
      summary: truncateText(item?.summary, 260),
      url: cleanText(item?.url),
      usedFor: truncateText(item?.usedFor, 160),
    }))
    .filter((item) => item.summary || item.title);
}

function selectEvidenceMessages(messages, personas, roundNumber) {
  const segmentByName = new Map((personas || []).map((persona) => [persona.name, persona.segment || "目标用户"]));
  const scored = (messages || []).map((message, index) => ({
    message,
    index,
    score: scoreEvidenceText(message?.text),
  }));
  const selected = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8);
  const fallback = selected.length ? selected : scored.slice(0, 6);
  return fallback.map(({ message }) => ({
    round: Number(roundNumber),
    speaker: cleanText(message.speaker),
    segment: segmentByName.get(message.speaker) || "受访者",
    signal: inferSignal(message.text),
    text: truncateText(message.text, 220),
  }));
}

function scoreEvidenceText(text) {
  const value = cleanText(text);
  let score = Math.min(3, Math.floor(value.length / 70));
  [
    "因为",
    "如果",
    "但是",
    "除非",
    "比如",
    "之前",
    "价格",
    "成本",
    "替代",
    "不会",
    "愿意",
    "需要",
    "担心",
    "门槛",
    "证据",
    "场景",
  ].forEach((keyword) => {
    if (value.includes(keyword)) score += 1;
  });
  return score;
}

function inferSignal(text) {
  const value = cleanText(text);
  if (/不会|不买|拒绝|放弃|闲置|麻烦|担心|风险/.test(value)) return "阻力/拒绝条件";
  if (/如果|除非|前提|条件|需要|证明|看到/.test(value)) return "转化条件";
  if (/价格|成本|贵|便宜|预算/.test(value)) return "价格敏感";
  if (/替代|相比|不如|换成/.test(value)) return "替代方案比较";
  if (/愿意|会买|期待|有用|方便/.test(value)) return "吸引点";
  return "观点证据";
}

function inferOpenQuestions({ participantMemory, roundSummary, topic, roundNumber, moderatorGuide, isFinalRound }) {
  const questions = [];
  if (!isFinalRound) {
    const guideRound = findGuideRound(moderatorGuide, roundNumber + 1);
    normalizeStringList(guideRound?.mustProbe).forEach((item) => questions.push(`下一轮需追问：${item}`));
  }

  participantMemory.forEach((memory) => {
    const validationPrefix = isFinalRound ? "真实调研需验证" : `${memory.name} 需要验证`;
    const contradictionPrefix = isFinalRound ? "真实调研需澄清的矛盾" : `${memory.name} 的矛盾需澄清`;
    const followUpPrefix = isFinalRound ? "真实调研可补问" : `${memory.name} 可追问`;
    normalizeStringList(memory.evidenceNeeded).forEach((item) => questions.push(`${validationPrefix}：${item}`));
    normalizeStringList(memory.contradictions).forEach((item) => questions.push(`${contradictionPrefix}：${item}`));
    normalizeStringList(memory.followUpQuestions).forEach((item) => questions.push(`${followUpPrefix}：${item}`));
  });

  if (/价格|成本|贵|预算/.test(roundSummary)) questions.push(`${topic} 中价格/成本阻力需要量化到可接受区间`);
  if (/证据|证明|效果|可靠/.test(roundSummary)) questions.push(`${topic} 中效果证明方式需要进一步验证`);
  return mergeDedupe(questions).slice(0, 10);
}

function buildFallbackRoundSummary(messages, topic) {
  const text = (messages || []).map((message) => message.text).join(" ");
  return truncateText(`${topic}：${text}`, 240);
}

function summarizeRecentTranscript(messages, maxCount, maxTextLength) {
  return (messages || [])
    .slice(-maxCount)
    .map((message) => ({
      round: message.round,
      speaker: cleanText(message.speaker),
      type: cleanText(message.type),
      text: truncateText(message.text, maxTextLength),
    }));
}

function findGuideRound(moderatorGuide, roundNumber) {
  const plan = Array.isArray(moderatorGuide?.roundPlan) ? moderatorGuide.roundPlan : [];
  return plan.find((round) => Number(round.round) === Number(roundNumber)) || plan[Number(roundNumber) - 1] || null;
}

function groupByRound(messages) {
  return (messages || []).reduce((result, message) => {
    const round = Number(message.round) || 1;
    if (!result[round]) result[round] = [];
    result[round].push(message);
    return result;
  }, {});
}

function isRelatedToTopic(text, topic) {
  const value = cleanText(text);
  const topicText = cleanText(topic);
  if (!value || !topicText) return false;
  const keywords = topicText.split(/[\s,，、:：;；/|]+/).filter((item) => item.length >= 2);
  return keywords.some((keyword) => value.includes(keyword));
}

function mergeDedupe(values) {
  const seen = new Set();
  const result = [];
  normalizeStringList(values).forEach((item) => {
    const key = item.replace(/\s+/g, "");
    if (seen.has(key)) return;
    seen.add(key);
    result.push(item);
  });
  return result;
}

function capList(value, limit) {
  return normalizeStringList(value).slice(0, limit);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [cleanText(value)];
  return [];
}

function cleanText(text) {
  return String(text || "")
    .trim()
    .replace(/^```[\w-]*\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^["“]|["”]$/g, "")
    .trim();
}

function truncateText(value, maxLength) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

module.exports = {
  buildParticipantPromptContext,
  buildReportContextState,
  buildRoundPromptContext,
  createInitialContextState,
  normalizeContextState,
  updateContextStateAfterRound,
};
