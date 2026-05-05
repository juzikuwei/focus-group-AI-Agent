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

function buildParticipantPromptContext({ contextState, participantStates, personas, persona, topic, roundNumber }) {
  const state = normalizeContextState(contextState, { personas, participantStates });
  const participantMemory = normalizeParticipantMemory(participantStates, personas);
  const ownMemory = participantMemory.find((memory) => memory.name === persona.name) || {};
  const relatedEvidence = state.evidenceLedger
    .filter((item) => item.speaker === persona.name || isRelatedToTopic(item.text, topic))
    .slice(-8);

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

function buildDirectSessionContext({
  config = {},
  topics = [],
  moderatorGuide = null,
  personas = [],
  participantStates = [],
  contextState = null,
  evidencePack = null,
} = {}) {
  const state = normalizeContextState(contextState, { config, topics, moderatorGuide, personas, participantStates });
  const evidence = normalizeDirectEvidence(evidencePack, state);
  const participantArcs = buildParticipantArcs(personas, participantStates);
  const totalRounds = topics.length;

  return {
    schemaVersion: 1,
    projectBrief: buildProjectBrief(config),
    operatingRules: [
      "把直接到位当成同一场连续访谈来写，不要把每轮写成彼此独立的问卷回答。",
      "每一轮都必须推进受访者判断：第一反应 -> 具体使用 -> 替代/价格/证据 -> 改进条件 -> 最终取舍。",
      "主持人只引用本轮 blueprint.evidenceToIntroduce 中列出的外部资料；资料不足时只追问个人经验和假设，不补造市场事实。",
      "受访者可以被公开资料、他人观点和自身阻力影响，但态度变化必须有条件和原因，不能突然反转。",
      "每轮至少制造一个明确分歧，并让后发言者点名回应前面至少一个观点。",
    ],
    evidenceUse: evidence,
    participantArcs,
    roundBlueprints: topics.map((topic, index) => buildDirectRoundBlueprint({
      config,
      topic,
      roundNumber: index + 1,
      totalRounds,
      moderatorGuide,
      personas,
      participantArcs,
      contextState: state,
      evidence,
    })),
  };
}

function normalizeDirectEvidence(evidencePack, contextState) {
  const pack = evidencePack && typeof evidencePack === "object" ? evidencePack : {};
  const sourceCards = Array.isArray(pack.sourceCards) && pack.sourceCards.length
    ? pack.sourceCards
    : normalizeExternalFindings(contextState?.externalFindings).map((finding, index) => ({
        id: finding.source || `E${index + 1}`,
        type: "external_finding",
        title: finding.title,
        reliability: "medium",
        keyFacts: [finding.summary].filter(Boolean),
        userSignals: [],
        quoteSnippets: [],
        relevantFor: [finding.usedFor].filter(Boolean),
      }));

  const cards = sourceCards.slice(0, 10).map((card, index) => ({
    id: cleanText(card.id || `S${index + 1}`),
    type: cleanText(card.type || "other"),
    title: truncateText(card.title, 110),
    reliability: cleanText(card.reliability || "medium"),
    keyFacts: capList(card.keyFacts, 3),
    userSignals: capList(card.userSignals, 3),
    quoteSnippets: capList(card.quoteSnippets, 2),
    relevantFor: capList(card.relevantFor, 4),
  })).filter((card) => card.title || card.keyFacts.length || card.userSignals.length);

  return {
    status: cleanText(pack.status || (cards.length ? "used" : "skipped")),
    stimulusScript: truncateText(pack.stimulusScript, 180),
    allowedSources: cards,
    marketPatterns: capList(pack.marketPatterns, 6),
    purchaseBarriers: capList(pack.purchaseBarriers, 6),
    commonComplaints: capList(pack.commonComplaints, 6),
    openQuestions: capList(pack.openQuestions, 8),
  };
}

function buildParticipantArcs(personas, participantStates) {
  const memoryByName = new Map(
    normalizeParticipantMemory(participantStates, personas).map((memory) => [memory.name, memory]),
  );

  return (personas || []).map((persona) => {
    const memory = memoryByName.get(persona.name) || {};
    const pressurePoints = mergeDedupe([
      ...(persona.concerns || []),
      persona.dealBreaker,
      ...(memory.mentionedConcerns || []),
      ...(memory.objections || []),
      ...(memory.evidenceNeeded || []),
    ]).slice(0, 7);

    return {
      name: cleanText(persona.name),
      segment: cleanText(persona.segment || "目标用户"),
      baseline: truncateText(`${persona.job || "未说明职业"}；${persona.usageScenario || persona.motivation || ""}`, 160),
      openingStance: inferOpeningStance(persona, memory),
      decisionCriteria: truncateText(persona.decisionCriteria || "", 130),
      dealBreaker: truncateText(persona.dealBreaker || "", 130),
      pressurePoints,
      switchConditions: mergeDedupe([
        ...(memory.conditionsToBuy || []),
        ...(memory.evidenceNeeded || []),
        persona.decisionCriteria,
      ]).slice(0, 5),
      continuityRule: "每次发言都要承接上一轮自己的立场，只能在看到证据、被他人观点触发或条件改变时推进判断。",
    };
  });
}

function inferOpeningStance(persona, memory) {
  if (memory.currentAttitude && !/尚未|未知/.test(memory.currentAttitude)) {
    return truncateText(memory.currentAttitude, 120);
  }
  const adoption = Number(persona.adoption) || 50;
  const skepticism = Number(persona.skepticism) || 50;
  const price = Number(persona.priceSensitivity) || 50;
  if (adoption >= 70 && skepticism < 55) return "初始兴趣较高，但仍需要确认真实使用价值和成本。";
  if (skepticism >= 70 || price >= 75) return "初始偏谨慎，容易先提出价格、必要性或可靠性阻力。";
  if (adoption <= 40) return "初始兴趣有限，需要被具体场景或强证据触发才会继续考虑。";
  return "初始态度中性，会在场景适配、替代方案和购买门槛之间权衡。";
}

function buildDirectRoundBlueprint({
  topic,
  roundNumber,
  totalRounds,
  moderatorGuide,
  personas,
  participantArcs,
  contextState,
  evidence,
}) {
  const guideRound = findGuideRound(moderatorGuide, roundNumber);
  const progression = inferRoundProgression(roundNumber, totalRounds);
  const evidenceToIntroduce = selectDirectEvidenceForRound(evidence, topic, roundNumber);
  const unresolvedQuestions = selectDirectQuestions(contextState, evidence, topic, roundNumber);
  const conflictTargets = selectConflictTargets(personas, roundNumber);

  return {
    round: Number(roundNumber),
    topic: cleanText(topic),
    progression,
    objective: truncateText(guideRound?.objective || progression, 180),
    keyQuestion: truncateText(guideRound?.keyQuestion || topic, 180),
    facilitatorMove: buildFacilitatorMove(topic, progression, guideRound, evidenceToIntroduce, roundNumber, totalRounds),
    mustProbe: capList(guideRound?.mustProbe, 4),
    shallowAnswerSignals: capList(guideRound?.shallowAnswerSignals, 4),
    evidenceToIntroduce,
    unresolvedQuestions,
    speakerOrder: rotateList((participantArcs || []).map((arc) => arc.name), roundNumber - 1),
    requiredCrossTalk: conflictTargets,
    successCriteria: [
      "本轮至少出现一个具体场景或真实替代方案。",
      "至少两位受访者点名回应或反驳其他人。",
      "至少一位受访者给出购买/拒绝条件或证据门槛。",
    ],
  };
}

function inferRoundProgression(roundNumber, totalRounds) {
  if (roundNumber <= 1) return "第一反应与核心价值判断";
  if (roundNumber >= totalRounds) return "最终取舍、购买/拒绝条件和后续验证";
  const ratio = roundNumber / Math.max(1, totalRounds);
  if (ratio <= 0.4) return "具体使用场景和替代行为";
  if (ratio <= 0.7) return "价格、成本、信任证据和竞品比较";
  return "产品改进优先级和转化条件";
}

function buildFacilitatorMove(topic, progression, guideRound, evidenceToIntroduce, roundNumber, totalRounds) {
  const question = guideRound?.keyQuestion || topic;
  if (roundNumber >= totalRounds) {
    return `围绕“${truncateText(topic, 80)}”收束整场讨论，要求每个人给出最终购买/拒绝条件和最需要真实验证的一点，不再提出新议题。`;
  }
  if (evidenceToIntroduce.length) {
    const sourceIds = evidenceToIntroduce.map((item) => item.id).join("、");
    return `先用 ${sourceIds} 作为公开材料刺激，再追问“${truncateText(question, 90)}”，把讨论压到${progression}。`;
  }
  return `围绕“${truncateText(question, 100)}”追问，把讨论压到${progression}，避免泛泛表态。`;
}

function selectDirectEvidenceForRound(evidence, topic, roundNumber) {
  const cards = Array.isArray(evidence?.allowedSources) ? evidence.allowedSources : [];
  if (!cards.length || evidence.status !== "used") return [];

  const related = cards.filter((card) => isCardRelatedToTopic(card, topic));
  const source = related.length ? related : rotateList(cards, (roundNumber - 1) * 2);
  return source.slice(0, 2).map((card) => ({
    id: card.id,
    title: card.title,
    useFor: card.relevantFor.join("、") || card.type,
    signals: [
      ...card.keyFacts.slice(0, 2),
      ...card.userSignals.slice(0, 2),
      ...card.quoteSnippets.slice(0, 1),
    ].filter(Boolean).slice(0, 4),
  }));
}

function isCardRelatedToTopic(card, topic) {
  const text = [
    card.title,
    card.type,
    ...(card.relevantFor || []),
    ...(card.keyFacts || []),
    ...(card.userSignals || []),
    ...(card.quoteSnippets || []),
  ].join(" ");
  return isRelatedToTopic(text, topic);
}

function selectDirectQuestions(contextState, evidence, topic, roundNumber) {
  const stateQuestions = normalizeStringList(contextState?.unresolvedQuestions)
    .filter((item) => isRelatedToTopic(item, topic));
  const fallbackStateQuestions = normalizeStringList(contextState?.unresolvedQuestions);
  const evidenceQuestions = normalizeStringList(evidence?.openQuestions)
    .filter((item) => isRelatedToTopic(item, topic));
  const fallbackEvidenceQuestions = normalizeStringList(evidence?.openQuestions);

  return mergeDedupe([
    ...evidenceQuestions,
    ...stateQuestions,
    ...rotateList(fallbackEvidenceQuestions, roundNumber - 1),
    ...rotateList(fallbackStateQuestions, roundNumber - 1),
  ]).slice(0, 5);
}

function selectConflictTargets(personas, roundNumber) {
  const safePersonas = Array.isArray(personas) ? personas : [];
  if (!safePersonas.length) return [];
  const skeptical = [...safePersonas]
    .sort((a, b) => conflictScore(b) - conflictScore(a))[(roundNumber - 1) % safePersonas.length];
  const adopter = [...safePersonas]
    .sort((a, b) => (Number(b.adoption) || 0) - (Number(a.adoption) || 0))
    .find((persona) => persona.name !== skeptical.name) || safePersonas.find((persona) => persona.name !== skeptical.name);

  const targets = [
    {
      speaker: skeptical.name,
      move: "先把主要阻力说具体，给出价格、必要性、信任或替代方案中的一个硬门槛。",
    },
  ];
  if (adopter) {
    targets.push({
      speaker: adopter.name,
      move: `回应或反驳 ${skeptical.name}，说明什么条件下这个阻力成立或可以被克服。`,
    });
  }
  return targets;
}

function conflictScore(persona) {
  return (Number(persona.skepticism) || 50) + (Number(persona.priceSensitivity) || 50) - (Number(persona.adoption) || 50) / 2;
}

function rotateList(list, offset) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!items.length) return [];
  const start = ((Number(offset) || 0) % items.length + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function buildProjectBrief(config = {}) {
  return {
    projectName: cleanText(config.projectName),
    productConcept: cleanText(config.productConcept),
    coreSellingPoints: cleanText(config.coreSellingPoints),
    targetAudience: cleanText(config.targetAudience),
    tone: cleanText(config.tone),
    outputDepth: cleanText(config.outputDepth),
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
  buildDirectSessionContext,
  buildParticipantPromptContext,
  buildReportContextState,
  buildRoundPromptContext,
  createInitialContextState,
  normalizeContextState,
  updateContextStateAfterRound,
};
