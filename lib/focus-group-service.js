const { readJson } = require("./http");
const {
  requireProjectConfig,
  requireArray,
  requireStringArray,
  requireNonEmptyString,
  requirePositiveInteger,
} = require("./validators");
const {
  buildParticipantPromptContext,
  buildReportContextState,
  buildRoundPromptContext,
  createInitialContextState,
  normalizeContextState,
  updateContextStateAfterRound,
} = require("./context-engine");
const {
  cleanGeneratedText,
  compactJson,
  formatPromptTranscript,
  mapWithConcurrency,
  truncateText,
} = require("./text-utils");
const { buildInterviewControls } = require("./interview-profiles");
const {
  createInitialParticipantStates,
  formatModeratorGuide,
  inferParticipantStatesAfterFullSession,
  limitPersonas,
  normalizeModeratorGuide,
  normalizeParticipantStates,
  normalizePersonas,
  normalizeSessionMessages,
  splitPersonasForRound,
  toPromptPersona,
} = require("./normalizers");
const { buildAnonymizedReportContext } = require("./anonymizer");
const {
  attachEvidencePackToContextState,
  normalizeEvidencePack,
  normalizeSearchQueries,
  prepareSearchResultsForPrompt,
  todayIsoDate,
} = require("./evidence-pack");
const {
  buildFallbackQuickFillQueries,
  normalizeQuickFill,
  normalizeQuickFillResearch,
  normalizeQuickFillResearchFromSearch,
  summarizeQuickFillResearch,
} = require("./quick-fill");
const { createReportBuilder } = require("./report-builder");
const {
  estimateFullSessionTokens,
  estimateModeratorTurnTokens,
  estimatePersonaTokens,
  estimateSingleParticipantTokens,
  getParticipantParallelLimit,
} = require("./token-estimator");

function createFocusGroupService({ promptStore, llm, searchClient }) {
  const { renderPrompt } = promptStore;
  const reportBuilder = createReportBuilder({ llm });

  async function handlePersonas(req, res, sendJson) {
    const { config } = await readJson(req);
    requireProjectConfig(config);
    llm.assertProviderReady();

    const prompt = renderPrompt("persona-generator.md", {
      ...config,
      ...buildInterviewControls(config),
    });
    const data = await llm.callJson(prompt, 0.65, {
      label: "personas",
      maxTokens: estimatePersonaTokens(config.participantCount),
      repairMaxTokens: estimatePersonaTokens(config.participantCount) + 1200,
    });
    return sendJson(res, 200, { personas: normalizePersonas(data.personas, config.participantCount) });
  }

  async function handleModeratorGuide(req, res, sendJson) {
    const { config, personas, topics } = await readJson(req);
    requireProjectConfig(config);
    requireArray(personas, "personas", { minLength: 1 });
    requireStringArray(topics, "topics", { minLength: 1 });
    llm.assertProviderReady();

    const activePersonas = limitPersonas(personas);
    const controls = buildInterviewControls(config);
    const prompt = renderPrompt("moderator-guide.md", {
      ...config,
      ...controls,
      topicsJson: compactJson(topics.map((topic, index) => ({ round: index + 1, topic }))),
      personasJson: compactJson(activePersonas.map(toPromptPersona)),
    });
    const data = await llm.callJson(prompt, 0.45, {
      label: "moderator.guide",
      maxTokens: 2600,
      repairMaxTokens: 3600,
    });

    const moderatorGuide = normalizeModeratorGuide(data);
    const participantStates = createInitialParticipantStates(activePersonas);

    return sendJson(res, 200, {
      moderatorGuide,
      participantStates,
      contextState: createInitialContextState({
        config,
        topics,
        moderatorGuide,
        personas: activePersonas,
        participantStates,
      }),
    });
  }

  async function handleSession(req, res, sendJson) {
    const { config, personas, topics, moderatorGuide, participantStates, contextState } = await readJson(req);
    requireProjectConfig(config);
    requireArray(personas, "personas", { minLength: 1 });
    requireStringArray(topics, "topics", { minLength: 1 });
    if (participantStates !== undefined) requireArray(participantStates, "participantStates");
    llm.assertProviderReady();

    const activePersonas = limitPersonas(personas);
    const controls = buildInterviewControls(config);
    const normalizedParticipantStates = normalizeParticipantStates(participantStates, activePersonas);
    const sessionContextState = prepareContextState(contextState, {
      config,
      topics,
      moderatorGuide,
      personas: activePersonas,
      participantStates: normalizedParticipantStates,
    });
    const evidencePack = await buildEvidencePackForDirectSession({
      config,
      topics,
      personas: activePersonas,
      moderatorGuide,
    });
    const sessionContextWithEvidence = attachEvidencePackToContextState(
      sessionContextState,
      evidencePack,
      {
        config,
        topics,
        moderatorGuide,
        personas: activePersonas,
        participantStates: normalizedParticipantStates,
      },
      normalizeContextState,
    );
    const prompt = renderPrompt("focus-group-session.md", {
      ...config,
      ...controls,
      roundCount: topics.length,
      topicsJson: compactJson(topics.map((topic, index) => ({ round: index + 1, topic }))),
      personasJson: compactJson(activePersonas.map(toPromptPersona)),
      moderatorGuideText: formatModeratorGuide(moderatorGuide),
      participantStatesJson: compactJson(normalizedParticipantStates),
      contextStateJson: compactJson(sessionContextWithEvidence),
      evidencePackJson: compactJson(evidencePack),
    });
    const data = await llm.callJson(prompt, 0.78, {
      label: "session.full",
      maxTokens: estimateFullSessionTokens(activePersonas.length, topics.length, config.outputDepth),
    });
    const messages = normalizeSessionMessages(data, activePersonas, topics);
    const nextParticipantStates = inferParticipantStatesAfterFullSession({
      personas: activePersonas,
      participantStates,
      messages,
    });

    return sendJson(res, 200, {
      messages,
      participantStates: nextParticipantStates,
      contextState: buildReportContextState({
        config,
        personas: activePersonas,
        messages,
        moderatorGuide,
        participantStates: nextParticipantStates,
        contextState: sessionContextWithEvidence,
      }),
      evidencePack,
    });
  }

  async function handleSessionRound(req, res, sendJson) {
    const { config, personas, topic, roundNumber, priorMessages, moderatorGuide, participantStates, contextState } = await readJson(req);
    requireProjectConfig(config);
    requireArray(personas, "personas", { minLength: 1 });
    llm.assertProviderReady();
    requireNonEmptyString(topic, "topic");
    requirePositiveInteger(roundNumber, "roundNumber");
    if (priorMessages !== undefined) requireArray(priorMessages, "priorMessages");
    if (participantStates !== undefined) requireArray(participantStates, "participantStates");

    const activePersonas = limitPersonas(personas);
    const normalizedParticipantStates = normalizeParticipantStates(participantStates, activePersonas);
    const roundResult = await generateDeepSessionRound({
      config,
      personas: activePersonas,
      topic,
      roundNumber: Number(roundNumber),
      priorMessages: priorMessages || [],
      moderatorGuide,
      participantStates: normalizedParticipantStates,
      contextState,
    });

    return sendJson(res, 200, {
      messages: roundResult.messages,
      participantStates: roundResult.participantStates,
      contextState: roundResult.contextState,
    });
  }

  async function handleReport(req, res, sendJson) {
    const { config, personas, messages, moderatorGuide, participantStates, contextState, evidencePack } = await readJson(req);
    requireProjectConfig(config);
    requireArray(personas, "personas", { minLength: 1 });
    requireArray(messages, "messages", { minLength: 1 });
    if (participantStates !== undefined) requireArray(participantStates, "participantStates");
    llm.assertProviderReady();

    const reportContext = buildAnonymizedReportContext({
      config,
      personas,
      messages,
      moderatorGuide,
      participantStates,
      contextState,
      buildReportContextState,
    });

    const prompt = renderPrompt("report-analyst.md", {
      ...config,
      ...buildInterviewControls(config),
      personasText: reportContext.personasText,
      messagesText: reportContext.messagesText,
      moderatorGuideText: formatModeratorGuide(moderatorGuide),
      participantStatesJson: compactJson(reportContext.participantStates),
      contextStateJson: compactJson(reportContext.contextState),
      evidencePackJson: compactJson(normalizeEvidencePack(evidencePack)),
    });

    const markdown = await reportBuilder.generateReportMarkdown(prompt, config.outputDepth);
    return sendJson(res, 200, { markdown: markdown.trim() });
  }

  async function handleQuickFill(req, res, sendJson) {
    const { seed } = await readJson(req);
    if (!seed || typeof seed !== "string") {
      return sendJson(res, 400, { error: "seed is required" });
    }
    llm.assertProviderReady();

    const seedText = seed.slice(0, 400);
    const searchResearch = await buildQuickFillResearch(seedText);
    const prompt = renderPrompt("quick-fill.md", {
      seed: seedText,
      searchResearchJson: compactJson(searchResearch),
    });
    const data = await llm.callJson(prompt, 0.7, {
      label: searchResearch.status === "used" ? "quick-fill.search" : "quick-fill",
      maxTokens: 1600,
      repairMaxTokens: 2400,
    });
    const config = normalizeQuickFill(data.config || data);
    return sendJson(res, 200, { config, search: summarizeQuickFillResearch(searchResearch) });
  }

  async function generateDeepSessionRound({ config, personas, topic, roundNumber, priorMessages, moderatorGuide, participantStates, contextState }) {
    const [firstWave, secondWave] = splitPersonasForRound(personas);
    const normalizedContextState = prepareContextState(contextState, {
      config,
      topics: inferTopicsForContext(moderatorGuide, topic),
      moderatorGuide,
      personas,
      participantStates,
    });
    const totalRounds = getTotalRoundCount(config, moderatorGuide, normalizedContextState);
    const isFinalRound = totalRounds > 0 && Number(roundNumber) >= totalRounds;
    const controls = buildInterviewControls(config);
    const roundPromptContext = buildRoundPromptContext({
      config,
      personas,
      topic,
      roundNumber,
      priorMessages,
      moderatorGuide,
      participantStates,
      contextState: normalizedContextState,
    });
    roundPromptContext.currentRound.totalRounds = totalRounds || "";
    roundPromptContext.currentRound.isFinalRound = isFinalRound;
    const priorContext =
      formatStructuredPriorContext(roundPromptContext, priorMessages) || "（这是第一轮，没有先前内容）";
    const shared = {
      ...config,
      ...controls,
      roundNumber,
      topic,
      roundPositionText: isFinalRound
        ? `第 ${roundNumber} 轮 / 共 ${totalRounds || roundNumber} 轮，这是最后一轮`
        : `第 ${roundNumber} 轮 / 共 ${totalRounds || "未知"} 轮`,
      finalRoundInstruction: isFinalRound
        ? "这是最后一轮。主持人本轮小结必须收束整场讨论，不要再向受访者提出下一轮问题，不要写“下一步需验证：”这类继续访谈式表达。可以用“后续真实调研可验证”指向报告层面的研究事项。"
        : "这不是最后一轮。本轮小结可以指出下一轮应继续验证的问题，但不要展开新议题。",
      personasJson: compactJson(personas.map(toPromptPersona)),
      participantStatesJson: compactJson(normalizeParticipantStates(participantStates, personas)),
      contextState: normalizedContextState,
      contextStateJson: compactJson(roundPromptContext),
      participantStatesForPrompt: normalizeParticipantStates(participantStates, personas),
      moderatorGuideText: formatModeratorGuide(moderatorGuide),
      priorContext,
    };

    const messages = [];

    const opening = await generateModeratorTurn({
      ...shared,
      turnStage: "开场主问题",
      turnGoal:
        "结合项目概念、核心卖点、本轮议题和前几轮上下文，提出一个有针对性的主问题。必须点出产品详情中的一个具体功能、价格、场景或目标人群，不要问泛泛的“你怎么看”。",
      currentTranscript: "（本轮刚开始）",
      label: "session.round.moderator.opening",
    }, personas);
    messages.push(opening);

    const firstResponses = await generateParticipantWave({
      ...shared,
      selectedPersonas: firstWave,
      currentTranscript: formatPromptTranscript(messages, 180),
      latestModeratorQuestion: opening.text,
      responseGoal:
        "第一组受访者先回应主持人的主问题。每个人都要给出明确立场、具体例子、真实权衡，并尽量留下一个可被追问的矛盾或条件。",
      label: "session.round.participants.first",
    }, personas);
    messages.push(...firstResponses);

    const probe = await generateModeratorTurn({
      ...shared,
      turnStage: "针对性追问",
      turnGoal:
        "基于本轮已经出现的受访者发言，抓住一个矛盾点、含糊点或分歧点追问。必须引用或点名至少一位受访者的观点，并把问题压到更具体的场景、证据、替代方案或购买门槛上。",
      currentTranscript: formatPromptTranscript(messages, 180),
      label: "session.round.moderator.probe",
    }, personas);
    messages.push(probe);

    const secondResponses = await generateParticipantWave({
      ...shared,
      selectedPersonas: secondWave,
      currentTranscript: formatPromptTranscript(messages, 180),
      latestModeratorQuestion: probe.text,
      responseGoal:
        "第二组受访者回应主持人的追问，也要回应前面至少一个受访者观点。重点说清楚购买/拒绝条件、替代方案比较、需要什么证据才会改变判断。",
      label: "session.round.participants.second",
    }, personas);
    messages.push(...secondResponses);

    const preSummaryMessages = messages.map((message) => ({ ...message, round: roundNumber }));
    const summaryPromise = generateModeratorTurn({
      ...shared,
      turnStage: "本轮小结",
      turnGoal: isFinalRound
        ? `用 ${controls.summaryWordRange} 字做最后一轮收束：总结整场访谈中最稳定的共识、最关键的分歧和后续真实调研需要验证的事项。不要再向受访者提问，不要写“下一轮”“下一步需验证：”这类继续访谈式表达。`
        : `用 ${controls.summaryWordRange} 字总结本轮核心共识、主要分歧和下一轮需要继续验证的问题。必须承接本轮真实发言，不要新增独立大问题。`,
      currentTranscript: formatPromptTranscript(messages, 180),
      label: "session.round.moderator.summary",
    }, personas);

    const participantStatesPromise = updateParticipantStates({
      config,
      personas,
      moderatorGuide,
      participantStates,
      roundNumber,
      topic,
      roundMessages: preSummaryMessages,
    });

    const [summary, nextParticipantStates] = await Promise.all([summaryPromise, participantStatesPromise]);
    messages.push(summary);
    const nextContextState = updateContextStateAfterRound({
      config,
      personas,
      topic,
      roundNumber,
      contextState: normalizedContextState,
      participantStates: nextParticipantStates,
      roundMessages: preSummaryMessages,
      summaryMessage: summary,
      moderatorGuide,
      isFinalRound,
    });

    return {
      messages: messages.map((message) => ({ ...message, round: roundNumber })),
      participantStates: nextParticipantStates,
      contextState: nextContextState,
    };
  }

  async function generateModeratorTurn(values, personas) {
    const prompt = renderPrompt("moderator-turn.md", values);
    const data = await llm.callJson(prompt, 0.62, {
      label: values.label,
      maxTokens: estimateModeratorTurnTokens(values.outputDepth),
    });
    const messages = normalizeSessionMessages(data, personas, [values.topic], {
      fixedRound: Number(values.roundNumber),
    });
    const moderator = messages.find((message) => message.type === "moderator");
    if (!moderator) {
      throw new Error(`${values.label} did not return a moderator message`);
    }
    return moderator;
  }

  async function generateParticipantWave(values, allPersonas) {
    const selectedPersonas = values.selectedPersonas || [];
    const participantGroups = await mapWithConcurrency(
      selectedPersonas,
      getParticipantParallelLimit(),
      (persona, index) => generateSingleParticipantTurn(values, allPersonas, persona, index),
    );
    return participantGroups.flat();
  }

  async function generateSingleParticipantTurn(values, allPersonas, persona, index) {
    const prompt = renderPrompt("participant-turn.md", {
      ...values,
      participantNames: persona.name,
      selectedPersonasJson: compactJson([toPromptPersona(persona)]),
      selectedParticipantContextJson: compactJson(buildParticipantPromptContext({
        contextState: values.contextState,
        participantStates: values.participantStatesForPrompt,
        personas: allPersonas,
        persona,
        topic: values.topic,
        roundNumber: values.roundNumber,
      })),
    });
    const data = await llm.callJson(prompt, 0.8, {
      label: `${values.label}.${index + 1}`,
      maxTokens: estimateSingleParticipantTokens(values.outputDepth),
    });
    const messages = normalizeSessionMessages(data, allPersonas, [values.topic], {
      fixedRound: Number(values.roundNumber),
    });
    const participant = messages.find((message) => message.type === "participant" && message.speaker === persona.name);
    if (!participant) {
      throw new Error(`${values.label}.${index + 1} did not return ${persona.name}'s participant message`);
    }
    return [participant];
  }

  async function updateParticipantStates({ config, personas, moderatorGuide, participantStates, roundNumber, topic, roundMessages }) {
    const prompt = renderPrompt("participant-state-updater.md", {
      ...config,
      roundNumber,
      topic,
      personasJson: compactJson(personas.map(toPromptPersona)),
      moderatorGuideText: formatModeratorGuide(moderatorGuide),
      priorParticipantStatesJson: compactJson(normalizeParticipantStates(participantStates, personas)),
      roundTranscript: formatPromptTranscript(roundMessages, 220),
    });
    const data = await llm.callJson(prompt, 0.35, {
      label: "participant.states",
      maxTokens: Math.min(6200, Math.max(2800, 1000 + personas.length * 760)),
      repairMaxTokens: 7600,
    });
    return normalizeParticipantStates(data.participantStates || data.states || data, personas);
  }

  async function buildEvidencePackForDirectSession({ config, topics, personas, moderatorGuide }) {
    if (!searchClient?.canSearch?.()) {
      return normalizeEvidencePack({
        status: "skipped",
        generatedAt: todayIsoDate(),
        topic: config.productConcept || config.projectName || "未命名研究",
        skipReason: "search disabled or missing API key",
      });
    }

    try {
      const planPrompt = renderPrompt("search-plan.md", {
        ...config,
        maxQueries: searchClient.getStatus().maxQueries,
        topicsJson: compactJson(topics.map((topic, index) => ({ round: index + 1, topic }))),
      });
      const plan = await llm.callJson(planPrompt, 0.35, {
        label: "search.plan",
        maxTokens: 1400,
        repairMaxTokens: 2200,
      });
      const queries = normalizeSearchQueries(plan.queries || plan.searchQueries || []);
      if (!queries.length) {
        return normalizeEvidencePack({
          status: "skipped",
          generatedAt: todayIsoDate(),
          topic: config.productConcept || config.projectName || "未命名研究",
          skipReason: "search planner returned no queries",
        });
      }

      console.log(`[search] direct session evidence search: ${queries.map((item) => item.query).join(" | ")}`);
      const searchResults = await searchClient.searchMany(queries);
      const packPrompt = renderPrompt("evidence-pack.md", {
        ...config,
        today: todayIsoDate(),
        topicsJson: compactJson(topics.map((topic, index) => ({ round: index + 1, topic }))),
        personasJson: compactJson(personas.map(toPromptPersona)),
        moderatorGuideText: formatModeratorGuide(moderatorGuide),
        searchResultsJson: compactJson(prepareSearchResultsForPrompt(searchResults)),
      });
      const data = await llm.callJson(packPrompt, 0.28, {
        label: "evidence.pack",
        maxTokens: 5200,
        repairMaxTokens: 6800,
      });
      const evidencePack = normalizeEvidencePack(data.evidencePack || data, { status: searchResults.status, queries });
      console.log(`[search] evidence pack ${evidencePack.status}; sources=${evidencePack.sourceCards.length}`);
      return evidencePack;
    } catch (error) {
      console.warn(`[search evidence] skipped because evidence build failed: ${error.message}`);
      return normalizeEvidencePack({
        status: "failed",
        generatedAt: todayIsoDate(),
        topic: config.productConcept || config.projectName || "未命名研究",
        error: error.message,
      });
    }
  }

  async function buildQuickFillResearch(seed) {
    if (!searchClient?.canSearch?.()) {
      return normalizeQuickFillResearch({
        status: "skipped",
        generatedAt: todayIsoDate(),
        seed,
        skipReason: "search disabled or missing API key",
      });
    }

    try {
      const maxQueries = Math.min(4, searchClient.getStatus().maxQueries || 4);
      let queries = [];
      try {
        const planPrompt = renderPrompt("quick-fill-search-plan.md", { seed, maxQueries });
        const plan = await llm.callJson(planPrompt, 0.3, {
          label: "quick-fill.search-plan",
          maxTokens: 900,
          repairMaxTokens: 1400,
        });
        queries = normalizeSearchQueries(plan.queries || plan.searchQueries || []).slice(0, maxQueries);
      } catch (error) {
        console.warn(`[search quick-fill] planner failed; using fallback queries: ${error.message}`);
        queries = buildFallbackQuickFillQueries(seed, maxQueries);
      }

      if (!queries.length) queries = buildFallbackQuickFillQueries(seed, maxQueries);
      if (!queries.length) {
        return normalizeQuickFillResearch({
          status: "skipped",
          generatedAt: todayIsoDate(),
          seed,
          skipReason: "no searchable query",
        });
      }

      console.log(`[search] quick-fill research: ${queries.map((item) => item.query).join(" | ")}`);
      const searchResults = await searchClient.searchMany(queries);
      const research = normalizeQuickFillResearchFromSearch(seed, searchResults);
      console.log(`[search] quick-fill research ${research.status}; sources=${research.sourceCards.length}`);
      return research;
    } catch (error) {
      console.warn(`[search quick-fill] skipped because search failed: ${error.message}`);
      return normalizeQuickFillResearch({
        status: "failed",
        generatedAt: todayIsoDate(),
        seed,
        error: error.message,
      });
    }
  }

  return {
    handlePersonas,
    handleModeratorGuide,
    handleSession,
    handleSessionRound,
    handleReport,
    handleQuickFill,
  };
}

function prepareContextState(contextState, values) {
  if (contextState && typeof contextState === "object") {
    return normalizeContextState(contextState, values);
  }
  return createInitialContextState(values);
}

function inferTopicsForContext(moderatorGuide, currentTopic) {
  const guide = normalizeModeratorGuide(moderatorGuide);
  const planTopics = (guide.roundPlan || [])
    .map((round) => round.topic || round.objective || round.keyQuestion)
    .filter(Boolean);
  return planTopics.length ? planTopics : [currentTopic].filter(Boolean);
}

function getTotalRoundCount(config, moderatorGuide, contextState) {
  const configRounds = Number(config?.roundCount);
  if (Number.isInteger(configRounds) && configRounds > 0) return configRounds;

  const guide = normalizeModeratorGuide(moderatorGuide);
  if (Array.isArray(guide.roundPlan) && guide.roundPlan.length) return guide.roundPlan.length;

  if (Array.isArray(contextState?.topics) && contextState.topics.length) return contextState.topics.length;
  return 0;
}

function formatStructuredPriorContext(roundPromptContext, priorMessages) {
  const parts = [];
  if (roundPromptContext.previousRounds?.length) {
    parts.push("结构化轮次记忆：");
    roundPromptContext.previousRounds.forEach((round) => {
      parts.push(`第${round.round}轮 ${round.topic}：${truncateText(round.summary, 180)}`);
      (round.unresolvedQuestions || []).slice(0, 3).forEach((question) => {
        parts.push(`- 待验证：${truncateText(question, 120)}`);
      });
    });
  }

  if (roundPromptContext.unresolvedQuestions?.length) {
    parts.push("当前优先追问清单：");
    roundPromptContext.unresolvedQuestions.slice(0, 6).forEach((question) => {
      parts.push(`- ${truncateText(question, 130)}`);
    });
  }

  const transcript = formatPromptTranscript((priorMessages || []).slice(-18), 150);
  if (transcript) {
    parts.push("最近原始实录：");
    parts.push(transcript);
  }

  return parts.join("\n");
}

module.exports = {
  createFocusGroupService,
};
