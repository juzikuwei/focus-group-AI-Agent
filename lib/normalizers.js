const { cleanGeneratedText, truncateText } = require("./text-utils");

function normalizePersonas(personas, expectedCount) {
  if (!Array.isArray(personas)) {
    throw new Error("personas must be an array");
  }

  return personas.slice(0, expectedCount).map((persona, index) => ({
    id: persona.id || `p${index + 1}`,
    name: persona.name || `受访者${index + 1}`,
    segment: persona.segment || "目标用户",
    snapshot: getPersonaSnapshot(persona),
    currentAlternative: getCurrentAlternative(persona),
    switchTrigger: getSwitchTrigger(persona),
    budgetAnchor: getBudgetAnchor(persona),
    evidenceNeeded: getEvidenceNeeded(persona),
    discussionRole: getDiscussionRole(persona),
    concerns: normalizePersonaConcerns(persona),
    speakingStyle: persona.speakingStyle || "自然表达，会说明取舍理由",
    dealBreaker: getDealBreaker(persona),
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
    evidenceNeeded: [persona.evidenceNeeded].filter(Boolean),
    contradictions: [persona.dealBreaker].filter(Boolean),
    concreteExamples: [],
    alternativeComparisons: [persona.currentAlternative].filter(Boolean),
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
    const signals = inferParticipantStateSignals(speakerMessages);
    return {
      ...state,
      currentAttitude: lastMessage ? inferFinalAttitude(lastMessage.text) : state.currentAttitude,
      conditionsToBuy: mergeLimited(state.conditionsToBuy, signals.conditionsToBuy, 5),
      objections: mergeLimited(state.objections, signals.objections, 5),
      evidenceNeeded: mergeLimited(state.evidenceNeeded, signals.evidenceNeeded, 5),
      concreteExamples: mergeLimited(state.concreteExamples, signals.concreteExamples, 5),
      alternativeComparisons: mergeLimited(state.alternativeComparisons, signals.alternativeComparisons, 5),
      quoteCandidates: mergeLimited(state.quoteCandidates, signals.quoteCandidates, 5),
      followUpQuestions: mergeLimited(state.followUpQuestions, signals.followUpQuestions, 5),
      lastRoundTakeaway: lastMessage ? truncateText(lastMessage.text, 120) : state.lastRoundTakeaway,
    };
  });
}

function inferParticipantStateSignals(messages) {
  const sentences = (messages || []).flatMap((message) => splitSentences(message.text));
  const recentFirst = [...sentences].reverse();
  return {
    conditionsToBuy: pickMatchingSentences(recentFirst, /如果|除非|前提|条件|必须|保证|证明|看到|低于|控制在|才会|能.*才/, 5, /验证|调研/),
    objections: pickMatchingSentences(recentFirst, /担心|顾虑|拒绝|不买|不会买|肯定不买|太贵|麻烦|风险|故障|隐私|漏|重|复杂|用不上|闲置/, 5),
    evidenceNeeded: pickMatchingSentences(recentFirst, /验证|证明|测试|数据|试用|保修|兼容|隐私政策|可靠性|故障率|防漏|续航|重量/, 5),
    concreteExamples: pickMatchingSentences(recentFirst, /我现在|我每天|我之前|上次|通勤|地铁|办公室|上课|开会|租房|早高峰|放包里/, 5),
    alternativeComparisons: pickMatchingSentences(recentFirst, /普通保温杯|普通杯|替代|相比|不如|现在用|宁愿|买.*杯|两百|一百|几十块/, 5),
    quoteCandidates: pickQuoteCandidates(recentFirst, 5),
    followUpQuestions: inferFollowUpQuestions(recentFirst),
  };
}

function inferFinalAttitude(text) {
  const value = cleanGeneratedText(text);
  if (/肯定不买|绝对拒绝|不会买|不考虑|就不买/.test(value)) {
    return `最终倾向拒绝：${truncateText(value, 90)}`;
  }
  if (/会买|愿意买|可以接受|能接受|考虑|可能会/.test(value)) {
    return `最终有条件接受：${truncateText(value, 90)}`;
  }
  return `最终保持观望：${truncateText(value, 90)}`;
}

function splitSentences(text) {
  return cleanGeneratedText(text)
    .split(/[。！？!?；;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 12);
}

function pickMatchingSentences(sentences, pattern, limit, rejectPattern = null) {
  return dedupeTextList(sentences
    .filter((sentence) => pattern.test(sentence))
    .filter((sentence) => !rejectPattern || !rejectPattern.test(sentence))
    .map((sentence) => truncateText(sentence, 120))).slice(0, limit);
}

function pickQuoteCandidates(sentences, limit) {
  const scored = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreQuoteSentence(sentence),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => truncateText(item.sentence, 140));
  return dedupeTextList(scored).slice(0, limit);
}

function scoreQuoteSentence(sentence) {
  let score = Math.min(3, Math.floor(cleanGeneratedText(sentence).length / 35));
  [
    /如果|除非|前提|条件|才会/,
    /拒绝|不买|不会买|肯定不买/,
    /担心|风险|隐私|故障|漏|太贵/,
    /相比|不如|宁愿|普通保温杯/,
    /我每天|我现在|我之前|通勤|办公室|地铁/,
  ].forEach((pattern) => {
    if (pattern.test(sentence)) score += 1;
  });
  return score;
}

function inferFollowUpQuestions(sentences) {
  const questions = [];
  if (sentences.some((sentence) => /价格|太贵|低于|控制在/.test(sentence))) {
    questions.push("真实调研需量化可接受价格区间和价格锚点");
  }
  if (sentences.some((sentence) => /防漏|漏|故障|可靠|保修|寿命/.test(sentence))) {
    questions.push("真实调研需验证防漏、故障率、保修承诺对购买意愿的影响");
  }
  if (sentences.some((sentence) => /App|隐私|数据|连接|耗电/.test(sentence))) {
    questions.push("真实调研需验证 App 依赖、隐私说明和连接稳定性是否阻碍转化");
  }
  if (sentences.some((sentence) => /重量|重|清洁|洗|麻烦/.test(sentence))) {
    questions.push("真实调研需测试重量、清洁难度和维护成本的接受阈值");
  }
  return questions.slice(0, 5);
}

function mergeLimited(existing, inferred, limit) {
  return dedupeTextList([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(inferred) ? inferred : [])]).slice(0, limit);
}

function dedupeTextList(values) {
  const seen = new Set();
  const result = [];
  (values || []).forEach((value) => {
    const text = cleanGeneratedText(value);
    if (!text) return;
    const key = text.replace(/\s+/g, "");
    if (seen.has(key)) return;
    seen.add(key);
    result.push(text);
  });
  return result;
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
      evidenceNeeded: safeList(existing.evidenceNeeded).length
        ? safeList(existing.evidenceNeeded)
        : [persona.evidenceNeeded].filter(Boolean),
      contradictions: safeList(existing.contradictions).length
        ? safeList(existing.contradictions)
        : [persona.dealBreaker].filter(Boolean),
      concreteExamples: safeList(existing.concreteExamples),
      alternativeComparisons: safeList(existing.alternativeComparisons).length
        ? safeList(existing.alternativeComparisons)
        : [persona.currentAlternative].filter(Boolean),
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

function toPromptPersona(persona) {
  return {
    name: persona.name,
    segment: persona.segment,
    snapshot: getPersonaSnapshot(persona),
    currentAlternative: getCurrentAlternative(persona),
    switchTrigger: getSwitchTrigger(persona),
    budgetAnchor: getBudgetAnchor(persona),
    evidenceNeeded: getEvidenceNeeded(persona),
    discussionRole: getDiscussionRole(persona),
    concerns: normalizePersonaConcerns(persona),
    speakingStyle: persona.speakingStyle,
    dealBreaker: getDealBreaker(persona),
  };
}

function getPersonaSnapshot(persona = {}) {
  return cleanGeneratedText(persona.snapshot) || buildLegacySnapshot(persona);
}

function buildLegacySnapshot(persona = {}) {
  return [
    persona.age ? `${persona.age}岁` : "",
    persona.job,
    persona.usageScenario || persona.scenario || persona.motivation,
  ]
    .filter(Boolean)
    .join("，") || "目标用户，关注真实使用价值";
}

function getCurrentAlternative(persona = {}) {
  return cleanGeneratedText(
    persona.currentAlternative ||
    persona.currentBehavior ||
    persona.alternative ||
    persona.alternativeComparisons ||
    persona.usageScenario ||
    "沿用现在的替代方案",
  );
}

function getSwitchTrigger(persona = {}) {
  return cleanGeneratedText(
    persona.switchTrigger ||
    persona.decisionCriteria ||
    persona.conditionsToBuy ||
    "看到明确收益和低试错成本才考虑",
  );
}

function getBudgetAnchor(persona = {}) {
  return cleanGeneratedText(
    persona.budgetAnchor ||
    persona.priceAnchor ||
    inferBudgetAnchor(persona),
  );
}

function inferBudgetAnchor(persona = {}) {
  const sensitivity = Number(persona.priceSensitivity);
  if (!Number.isNaN(sensitivity)) {
    if (sensitivity >= 75) return "必须接近日常替代方案成本";
    if (sensitivity <= 35) return "愿为确定价值支付溢价";
  }
  return "价格要能对照现有替代方案";
}

function getEvidenceNeeded(persona = {}) {
  const raw = Array.isArray(persona.evidenceNeeded) ? persona.evidenceNeeded[0] : persona.evidenceNeeded;
  return cleanGeneratedText(
    raw ||
    persona.trustBarrier ||
    persona.dealBreaker ||
    "需要看到真实效果和稳定性证据",
  );
}

function getDiscussionRole(persona = {}) {
  return cleanGeneratedText(
    persona.discussionRole ||
    persona.roleInGroup ||
    inferDiscussionRole(persona),
  );
}

function inferDiscussionRole(persona = {}) {
  const segment = cleanGeneratedText(persona.segment);
  if (/价格|敏感|保守/.test(segment)) return "会挑战价格和必要性";
  if (/怀疑|谨慎/.test(segment)) return "会追问证据和风险";
  if (/尝鲜|积极|强需求/.test(segment)) return "会补充高需求场景";
  return "会用个人经验补充条件";
}

function normalizePersonaConcerns(persona = {}) {
  const source = Array.isArray(persona.concerns) && persona.concerns.length
    ? persona.concerns
    : [persona.trustBarrier, persona.dealBreaker, persona.evidenceNeeded].filter(Boolean);
  return source.map((item) => cleanGeneratedText(item)).filter(Boolean).slice(0, 2);
}

function getDealBreaker(persona = {}) {
  return cleanGeneratedText(
    persona.dealBreaker ||
    persona.trustBarrier ||
    normalizePersonaConcerns(persona)[0] ||
    persona.evidenceNeeded ||
    "真实效果无法证明",
  );
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
  toPromptPersona,
  limitPersonas,
};
