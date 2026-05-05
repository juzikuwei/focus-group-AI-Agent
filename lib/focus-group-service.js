const { readJson } = require("./http");
const {
  badRequest,
  requireProjectConfig,
  requireArray,
  requireStringArray,
  requireNonEmptyString,
  requirePositiveInteger,
} = require("./validators");
const {
  buildDirectSessionContext,
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
  estimateParticipantWaveTokens,
  estimatePersonaTokens,
  estimateSingleParticipantTokens,
  getParticipantParallelLimit,
} = require("./token-estimator");

function createFocusGroupService({ promptStore, llm, searchClient }) {
  const { renderPrompt } = promptStore;
  const reportBuilder = createReportBuilder({ llm });

  async function handlePersonas(req, res, sendJson) {
    const { config } = await readJson(req);
    const signal = getRequestSignal(req);
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
      signal,
    });
    return sendJson(res, 200, { personas: normalizePersonas(data.personas, config.participantCount) });
  }

  async function handleModeratorGuide(req, res, sendJson) {
    const { config, personas, topics } = await readJson(req);
    const signal = getRequestSignal(req);
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
      signal,
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
    const signal = getRequestSignal(req);
    requireProjectConfig(config);
    requireArray(personas, "personas", { minLength: 1 });
    requireStringArray(topics, "topics", { minLength: 1 });
    if (participantStates !== undefined) requireArray(participantStates, "participantStates");
    llm.assertProviderReady();

    const activePersonas = limitPersonas(personas);
    assertDirectSessionCapacity(config, activePersonas.length, topics.length);
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
      signal,
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
    const directSessionContext = buildDirectSessionContext({
      config,
      topics,
      moderatorGuide,
      personas: activePersonas,
      participantStates: normalizedParticipantStates,
      contextState: sessionContextWithEvidence,
      evidencePack,
    });
    const prompt = renderPrompt("focus-group-session.md", {
      ...config,
      ...controls,
      roundCount: topics.length,
      expectedMessageCount: topics.length * (activePersonas.length + 1),
      topicsJson: compactJson(topics.map((topic, index) => ({ round: index + 1, topic }))),
      personasJson: compactJson(activePersonas.map(toPromptPersona)),
      directSessionContextJson: compactJson(directSessionContext),
    });
    const data = await llm.callJson(prompt, 0.78, {
      label: "session.full",
      maxTokens: estimateFullSessionTokens(activePersonas.length, topics.length, config.outputDepth),
      signal,
    });
    const messages = await completeDirectSessionMessagesIfNeeded({
      config,
      controls,
      topics,
      personas: activePersonas,
      directSessionContext,
      messages: normalizeSessionMessages(data, activePersonas, topics),
      signal,
    });
    assertCompleteDirectSessionMessages(messages, activePersonas, topics);
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
    const signal = getRequestSignal(req);
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
      signal,
    });

    return sendJson(res, 200, {
      messages: roundResult.messages,
      participantStates: roundResult.participantStates,
      contextState: roundResult.contextState,
    });
  }

  async function handleReport(req, res, sendJson) {
    const { config, personas, messages, moderatorGuide, participantStates, contextState, evidencePack } = await readJson(req);
    const signal = getRequestSignal(req);
    const prompt = buildReportPrompt({
      config,
      personas,
      messages,
      moderatorGuide,
      participantStates,
      contextState,
      evidencePack,
    });

    const markdown = await reportBuilder.generateReportMarkdown(prompt, config.outputDepth, { signal });
    return sendJson(res, 200, { markdown: markdown.trim() });
  }

  async function handleReportStream(req, res) {
    const { config, personas, messages, moderatorGuide, participantStates, contextState, evidencePack } = await readJson(req);
    const signal = getRequestSignal(req);
    const prompt = buildReportPrompt({
      config,
      personas,
      messages,
      moderatorGuide,
      participantStates,
      contextState,
      evidencePack,
    });

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson;charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    writeStreamEvent(res, { type: "start" });

    try {
      const markdown = await reportBuilder.generateReportMarkdown(prompt, config.outputDepth, {
        signal,
        onToken: (text) => {
          if (!text || res.destroyed || res.writableEnded) return;
          writeStreamEvent(res, { type: "chunk", text });
        },
      });
      writeStreamEvent(res, { type: "done", markdown: markdown.trim() });
    } catch (error) {
      if (error.name === "AbortError") return;
      if (!res.destroyed && !res.writableEnded) {
        writeStreamEvent(res, { type: "error", error: String(error.message || error).slice(0, 300) });
      }
    } finally {
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }

  function buildReportPrompt({ config, personas, messages, moderatorGuide, participantStates, contextState, evidencePack }) {
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

    return renderPrompt("report-analyst.md", {
      ...config,
      ...buildInterviewControls(config),
      personasText: reportContext.personasText,
      messagesText: reportContext.messagesText,
      moderatorGuideText: formatModeratorGuide(moderatorGuide),
      participantStatesJson: compactJson(reportContext.participantStates),
      contextStateJson: compactJson(reportContext.contextState),
      evidencePackJson: compactJson(normalizeEvidencePack(evidencePack)),
    });
  }

  async function handleQuickFill(req, res, sendJson) {
    const { seed } = await readJson(req);
    const signal = getRequestSignal(req);
    if (!seed || typeof seed !== "string") {
      return sendJson(res, 400, { error: "seed is required" });
    }
    llm.assertProviderReady();

    const seedText = seed.slice(0, 400);
    const searchResearch = await buildQuickFillResearch(seedText, signal);
    const prompt = renderPrompt("quick-fill.md", {
      seed: seedText,
      searchResearchJson: compactJson(searchResearch),
    });
    const data = await llm.callJson(prompt, 0.7, {
      label: searchResearch.status === "used" ? "quick-fill.search" : "quick-fill",
      maxTokens: 1600,
      repairMaxTokens: 2400,
      signal,
    });
    const config = normalizeQuickFill(data.config || data);
    return sendJson(res, 200, { config, search: summarizeQuickFillResearch(searchResearch) });
  }

  async function generateDeepSessionRound({ config, personas, topic, roundNumber, priorMessages, moderatorGuide, participantStates, contextState, signal }) {
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
      signal,
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
      signal,
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
      signal: values.signal,
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
    if (!selectedPersonas.length) return [];
    if (selectedPersonas.length === 1) {
      return generateSingleParticipantTurn(values, allPersonas, selectedPersonas[0], 0);
    }

    try {
      return await generateParticipantGroupTurn(values, allPersonas, selectedPersonas);
    } catch (error) {
      console.warn(`[participant wave] ${values.label} fell back to single-speaker calls: ${error.message}`);
    }

    const participantGroups = await mapWithConcurrency(
      selectedPersonas,
      getParticipantParallelLimit(),
      (persona, index) => generateSingleParticipantTurn(values, allPersonas, persona, index),
    );
    return participantGroups.flat();
  }

  async function generateParticipantGroupTurn(values, allPersonas, selectedPersonas) {
    const selectedNames = selectedPersonas.map((persona) => persona.name).filter(Boolean);
    const prompt = renderPrompt("participant-turn.md", {
      ...values,
      participantNames: selectedNames.join("、"),
      selectedPersonasJson: compactJson(selectedPersonas.map(toPromptPersona)),
      selectedParticipantContextJson: compactJson(selectedPersonas.map((persona) => buildParticipantPromptContext({
        contextState: values.contextState,
        participantStates: values.participantStatesForPrompt,
        personas: allPersonas,
        persona,
        topic: values.topic,
        roundNumber: values.roundNumber,
      }))),
    });
    const data = await llm.callJson(prompt, 0.8, {
      label: values.label,
      maxTokens: estimateParticipantWaveTokens(selectedPersonas.length, values.outputDepth),
      repairMaxTokens: Math.min(8000, estimateParticipantWaveTokens(selectedPersonas.length, values.outputDepth) + 1400),
      signal: values.signal,
    });
    const messages = normalizeSessionMessages(data, allPersonas, [values.topic], {
      fixedRound: Number(values.roundNumber),
    });
    const bySpeaker = new Map();
    messages
      .filter((message) => message.type === "participant" && selectedNames.includes(message.speaker))
      .forEach((message) => {
        if (!bySpeaker.has(message.speaker)) bySpeaker.set(message.speaker, message);
      });
    const missing = selectedNames.filter((name) => !bySpeaker.has(name));
    if (missing.length) {
      throw new Error(`${values.label} missing participant message(s): ${missing.join("、")}`);
    }
    return selectedPersonas.map((persona) => bySpeaker.get(persona.name));
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
      signal: values.signal,
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

  async function updateParticipantStates({ config, personas, moderatorGuide, participantStates, roundNumber, topic, roundMessages, signal }) {
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
      signal,
    });
    return normalizeParticipantStates(data.participantStates || data.states || data, personas);
  }

  async function completeDirectSessionMessagesIfNeeded({
    config,
    controls,
    topics,
    personas,
    directSessionContext,
    messages,
    signal,
  }) {
    let mergedMessages = sortSessionMessages(messages, personas);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const missing = getDirectSessionMissingMessages(mergedMessages, personas, topics);
      if (!missing.length) return mergedMessages;

      console.warn(`[session completion] direct session missing ${missing.length} slot group(s); requesting completion attempt ${attempt}.`);
      const completionPrompt = buildDirectSessionCompletionPrompt({
        config,
        controls,
        topics,
        personas,
        directSessionContext,
        existingMessages: mergedMessages,
        missing,
      });
      const data = await llm.callJson(completionPrompt, 0.72, {
        label: `session.full.complete.${attempt}`,
        maxTokens: estimateFullSessionTokens(personas.length, missing.length, config.outputDepth),
        repairMaxTokens: 8000,
        signal,
      });
      const completionMessages = normalizeSessionMessages(data, personas, topics);
      mergedMessages = sortSessionMessages(
        mergeSessionMessageSlots(mergedMessages, completionMessages),
        personas,
      );
    }
    return mergedMessages;
  }

  async function buildEvidencePackForDirectSession({ config, topics, personas, moderatorGuide, signal }) {
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
        signal,
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
      const searchResults = await searchClient.searchMany(queries, { signal });
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
        signal,
      });
      const evidencePack = normalizeEvidencePack(data.evidencePack || data, { status: searchResults.status, queries });
      console.log(`[search] evidence pack ${evidencePack.status}; sources=${evidencePack.sourceCards.length}`);
      return evidencePack;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      console.warn(`[search evidence] skipped because evidence build failed: ${error.message}`);
      return normalizeEvidencePack({
        status: "failed",
        generatedAt: todayIsoDate(),
        topic: config.productConcept || config.projectName || "未命名研究",
        error: error.message,
      });
    }
  }

  async function buildQuickFillResearch(seed, signal) {
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
          signal,
        });
        queries = normalizeSearchQueries(plan.queries || plan.searchQueries || []).slice(0, maxQueries);
      } catch (error) {
        if (error.name === "AbortError") throw error;
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
      const searchResults = await searchClient.searchMany(queries, { signal });
      const research = normalizeQuickFillResearchFromSearch(seed, searchResults);
      console.log(`[search] quick-fill research ${research.status}; sources=${research.sourceCards.length}`);
      return research;
    } catch (error) {
      if (error.name === "AbortError") throw error;
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
    handleReportStream,
    handleQuickFill,
  };
}

function writeStreamEvent(res, event) {
  res.write(`${JSON.stringify(event)}\n`);
}

function getRequestSignal(req) {
  return req.requestSignal;
}

function assertDirectSessionCapacity(config, personaCount, topicCount) {
  const load = Number(personaCount) * Number(topicCount);
  const limit = getDirectSessionCapacity(config);
  if (load <= limit) return;

  badRequest(
    `直接到位模式会一次性生成完整 JSON，当前规模为 ${personaCount} 人 × ${topicCount} 轮，超过 ${limit} 的稳定上限。请改用一步一轮，或降低人数/轮次后再使用直接到位。`,
  );
}

function getDirectSessionCapacity(config = {}) {
  const depth = String(config.outputDepth || "");
  if (depth.includes("深入")) return 30;
  if (depth.includes("简洁")) return 56;
  return 42;
}

function buildDirectSessionCompletionPrompt({
  config,
  controls,
  topics,
  personas,
  directSessionContext,
  existingMessages,
  missing,
}) {
  const missingRounds = new Set(missing.map((item) => item.round));
  const focusedContext = {
    ...directSessionContext,
    roundBlueprints: (directSessionContext.roundBlueprints || [])
      .filter((round) => missingRounds.has(Number(round.round))),
  };
  const expectedMissingCount = missing.reduce((sum, item) => {
    return sum + (item.missingModerator ? 1 : 0) + item.missingParticipants.length;
  }, 0);

  return `你正在补齐一份焦点小组访谈 JSON。已有实录只完成了一部分，请只补齐缺失的发言。
必须只输出一个合法 JSON 对象，不要 Markdown，不要解释。

JSON 结构必须完全符合：
{"messages":[{"round":2,"speaker":"AI 主持人","type":"moderator","text":"..."},{"round":2,"speaker":"受访者姓名","type":"participant","text":"..."}]}

补齐规则：
1. 只输出下面 missingJson 中缺失的发言，不要重复已有发言。
2. 本次必须输出 ${expectedMissingCount} 条 messages。
3. 每条主持人发言控制在 ${controls.moderatorWordRange} 字；每条受访者发言控制在 ${controls.directParticipantWordRange} 字。
4. 每条受访者发言至少包含 ${controls.minEvidenceTypes} 类信息：具体场景、真实顾虑、价格/时间/学习成本权衡、替代方案比较、对别人观点的同意或反驳、购买条件。
5. 必须承接 existingTranscript 中已有立场，保持同一受访者的态度连续；不要突然反转。
6. 主持人只可引用 focusedDirectSessionContext.roundBlueprints 对应轮次里的 evidenceToIntroduce。
7. speaker 必须使用 personasJson 中的 name，主持人固定为 "AI 主持人"；type 只能是 "moderator" 或 "participant"。
8. 不要输出 missingJson、blueprint、来源卡片或任何额外字段。

产品：${config.productConcept}
卖点：${config.coreSellingPoints}
受众：${config.targetAudience}
主持风格：${config.tone}
输出深度：${config.outputDepth}

missingJson：
${compactJson(missing)}

personasJson：
${compactJson(personas.map(toPromptPersona))}

focusedDirectSessionContext：
${compactJson(focusedContext)}

existingTranscript：
${formatPromptTranscript(existingMessages, 180)}`;
}

function getDirectSessionMissingMessages(messages, personas, topics) {
  const participantNames = (personas || []).map((persona) => persona.name).filter(Boolean);
  return (topics || []).map((topic, index) => {
    const round = index + 1;
    const roundMessages = (messages || []).filter((message) => Number(message.round) === round);
    const speakers = new Set(
      roundMessages
        .filter((message) => message.type === "participant")
        .map((message) => message.speaker),
    );
    return {
      round,
      topic,
      missingModerator: !roundMessages.some((message) => message.type === "moderator"),
      missingParticipants: participantNames.filter((name) => !speakers.has(name)),
    };
  }).filter((item) => item.missingModerator || item.missingParticipants.length);
}

function mergeSessionMessageSlots(baseMessages, incomingMessages) {
  const bySlot = new Map();
  [...(baseMessages || []), ...(incomingMessages || [])].forEach((message) => {
    const key = `${Number(message.round) || 0}|${message.type}|${message.speaker}`;
    if (bySlot.has(key)) return;
    bySlot.set(key, message);
  });
  return Array.from(bySlot.values());
}

function sortSessionMessages(messages, personas) {
  const participantOrder = new Map((personas || []).map((persona, index) => [persona.name, index + 1]));
  return [...(messages || [])].sort((a, b) => {
    const roundDiff = (Number(a.round) || 0) - (Number(b.round) || 0);
    if (roundDiff) return roundDiff;
    return getMessageOrder(a, participantOrder) - getMessageOrder(b, participantOrder);
  });
}

function getMessageOrder(message, participantOrder) {
  if (message.type === "moderator") return 0;
  return participantOrder.get(message.speaker) || 999;
}

function assertCompleteDirectSessionMessages(messages, personas, topics) {
  const missing = getDirectSessionMissingMessages(messages, personas, topics).flatMap((item) => {
    const items = [];
    if (item.missingModerator) items.push(`第 ${item.round} 轮缺少主持人发言`);
    item.missingParticipants.forEach((name) => items.push(`第 ${item.round} 轮缺少 ${name} 的发言`));
    return items;
  });

  if (!missing.length) return;
  const sample = missing.slice(0, 6).join("；");
  throw new Error(`直接到位返回的访谈 JSON 不完整：${sample}。请降低人数/轮次，或改用一步一轮模式。`);
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
