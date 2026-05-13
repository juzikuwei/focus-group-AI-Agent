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
  limitPersonas,
  normalizeModeratorGuide,
  normalizeParticipantStates,
  normalizePersonas,
  normalizeSessionMessages,
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
      repairMaxTokens: estimatePersonaTokens(config.participantCount) + 700,
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

  async function handleEvidencePack(req, res, sendJson) {
    const { config, personas, topics, moderatorGuide, participantStates, contextState } = await readJson(req);
    const signal = getRequestSignal(req);
    requireProjectConfig(config);
    requireArray(personas, "personas", { minLength: 1 });
    requireStringArray(topics, "topics", { minLength: 1 });
    if (participantStates !== undefined) requireArray(participantStates, "participantStates");

    const activePersonas = limitPersonas(personas);
    const normalizedParticipantStates = normalizeParticipantStates(participantStates, activePersonas);
    const baseContextState = prepareContextState(contextState, {
      config,
      topics,
      moderatorGuide,
      personas: activePersonas,
      participantStates: normalizedParticipantStates,
    });

    if (!isSearchEnhancementRequested(config)) {
      return sendJson(res, 200, {
        evidencePack: normalizeEvidencePack({
          status: "skipped",
          generatedAt: todayIsoDate(),
          topic: config.productConcept || config.projectName || "未命名研究",
          skipReason: "search enhancement not requested",
        }),
        contextState: baseContextState,
      });
    }

    const evidencePack = await buildEvidencePackForSession({
      config,
      topics,
      personas: activePersonas,
      moderatorGuide,
      signal,
    });
    const contextStateWithEvidence = attachEvidencePackToContextState(
      baseContextState,
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

    return sendJson(res, 200, {
      evidencePack,
      contextState: contextStateWithEvidence,
    });
  }

  async function handleSessionRoundStream(req, res) {
    const { config, personas, topics, topic, roundNumber, priorMessages, moderatorGuide, participantStates, contextState } = await readJson(req);
    const signal = getRequestSignal(req);
    requireProjectConfig(config);
    requireArray(personas, "personas", { minLength: 1 });
    llm.assertProviderReady();
    requireNonEmptyString(topic, "topic");
    requirePositiveInteger(roundNumber, "roundNumber");
    if (topics !== undefined) requireStringArray(topics, "topics", { minLength: 1 });
    if (priorMessages !== undefined) requireArray(priorMessages, "priorMessages");
    if (participantStates !== undefined) requireArray(participantStates, "participantStates");

    const activePersonas = limitPersonas(personas);
    const roundTopics = Array.isArray(topics) && topics.length
      ? topics
      : (Array.isArray(contextState?.topics) && contextState.topics.length ? contextState.topics : [topic]);
    const roundModeratorGuide = ensureModeratorGuide(moderatorGuide, config, roundTopics);
    const normalizedParticipantStates = normalizeParticipantStates(participantStates, activePersonas);

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson;charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    writeStreamEvent(res, { type: "start", roundNumber: Number(roundNumber) });

    try {
      const roundResult = await generateDeepSessionRound({
        config,
        personas: activePersonas,
        topic,
        roundNumber: Number(roundNumber),
        priorMessages: priorMessages || [],
        moderatorGuide: roundModeratorGuide,
        participantStates: normalizedParticipantStates,
        contextState,
        signal,
        onEvent: (event) => {
          if (!res.destroyed && !res.writableEnded) writeStreamEvent(res, event);
        },
      });

      writeStreamEvent(res, {
        type: "done",
        roundNumber: Number(roundNumber),
        messages: roundResult.messages,
        participantStates: roundResult.participantStates,
        contextState: roundResult.contextState,
        moderatorGuide: roundModeratorGuide,
      });
    } catch (error) {
      if (error.name === "AbortError") return;
      if (!res.destroyed && !res.writableEnded) {
        writeStreamEvent(res, { type: "error", error: String(error.message || error).slice(0, 300) });
      }
    } finally {
      if (!res.destroyed && !res.writableEnded) res.end();
    }
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
      const markdown = await reportBuilder.generateReportMarkdown(prompt, {
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

  async function generateDeepSessionRound({ config, personas, topic, roundNumber, priorMessages, moderatorGuide, participantStates, contextState, signal, onEvent }) {
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
    const participantRoundContext = buildParticipantRoundOnlyContext(roundPromptContext);
    const participantVisibleContext =
      "（受访者只知道主持人本轮公开提出的问题和本轮当前实录；如果主持人提到前面结论，就把它当作主持人现场提供的信息。）";
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
      participantStatesForParticipantsJson: compactJson(buildParticipantVisibleStates(personas)),
      participantContextStateJson: compactJson(participantRoundContext),
      participantPriorContext: participantVisibleContext,
      participantModeratorGuideText: formatParticipantVisibleModeratorGuide(roundPromptContext),
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
    emitRoundMessages(onEvent, {
      stage: "opening",
      roundNumber,
      messages: [opening],
    });

    const initialResponses = await generateParticipantWave({
      ...shared,
      selectedPersonas: personas,
      interactionMode: "主持问答",
      currentTranscript: formatPromptTranscript(messages, 180),
      latestModeratorQuestion: opening.text,
      responseGoal:
        "所有受访者先给出本轮初始立场。每个人都要给出明确观点、具体场景或经验、购买/拒绝条件，并尽量留下可被其他受访者回应的矛盾点或证据缺口。",
      label: "session.round.participants.initial",
    }, personas);
    messages.push(...initialResponses);
    emitRoundMessages(onEvent, {
      stage: "initial",
      roundNumber,
      messages: initialResponses,
    });

    await runDynamicFreeDiscussion({
      shared,
      personas,
      messages,
      roundNumber,
      topic,
      priorContext,
      signal,
      onEvent,
    });

    const preSummaryMessages = messages.map((message) => ({ ...message, round: roundNumber }));
    const summaryPromise = generateModeratorTurn({
      ...shared,
      turnStage: "本轮小结",
      turnGoal: isFinalRound
        ? `用 ${controls.summaryWordRange} 字做最后一轮收束：总结整场访谈中最稳定的共识、受访者自由讨论里最关键的相互反驳、最关键的分歧和后续真实调研需要验证的事项。不要再向受访者提问，不要写“下一轮”“下一步需验证：”这类继续访谈式表达。`
        : `用 ${controls.summaryWordRange} 字总结本轮核心共识、受访者自由讨论里出现的相互反驳、主要分歧和下一轮需要继续验证的问题。必须承接本轮真实发言，不要新增独立大问题。`,
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
    emitRoundMessages(onEvent, {
      stage: "summary",
      roundNumber,
      messages: [summary],
    });
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

  async function runDynamicFreeDiscussion({ shared, personas, messages, roundNumber, topic, priorContext, signal, onEvent }) {
    const maxWaves = 2;
    const minWaves = Math.min(1, maxWaves);
    let completedWaves = 0;

    while (completedWaves < maxWaves) {
      const decision = await decideRoundContinuation({
        shared,
        personas,
        messages,
        roundNumber,
        topic,
        priorContext,
        completedWaves,
        maxWaves,
        signal,
      });
      emitRoundStatus(onEvent, {
        stage: "facilitator",
        roundNumber,
        waveNumber: completedWaves + 1,
        action: decision.action,
        reason: decision.reason,
        nextSpeakers: decision.nextSpeakers,
      });

      if (completedWaves >= minWaves && decision.action === "summarize") {
        break;
      }

      const waveNumber = completedWaves + 1;
      const selectedPersonas = selectDiscussionPersonas({
        decision,
        personas,
        roundNumber,
        waveNumber,
      });
      const freeDiscussion = await generateParticipantWave({
        ...shared,
        selectedPersonas,
        interactionMode: "受访者自由讨论",
        currentTranscript: formatPromptTranscript(messages, 260),
        latestModeratorQuestion:
          decision.discussionPrompt ||
          "主持人暂时不提出新问题。请受访者围绕本轮已经出现的产品观点继续自由讨论，直接回应、反驳或追问其他受访者。",
        responseGoal:
          `继续第 ${waveNumber} 波受访者自由讨论。主持人只在后台判断是否收束，不新增追问。` +
          "本波必须围绕主持人本轮公开提出的问题，以及已有发言中的分歧、证据缺口、购买条件或拒绝条件展开，点名回应至少一位受访者；可以反驳、要求对方补充条件，或说明自己被对方影响后立场如何变化。",
        label: `session.round.participants.free.${waveNumber}`,
      }, personas);
      messages.push(...freeDiscussion);
      completedWaves += 1;
      emitRoundMessages(onEvent, {
        stage: "free",
        roundNumber,
        waveNumber,
        messages: freeDiscussion,
      });
    }
  }

  function emitRoundMessages(onEvent, event) {
    if (typeof onEvent !== "function") return;
    onEvent({
      type: "messages",
      stage: event.stage,
      roundNumber: Number(event.roundNumber),
      waveNumber: event.waveNumber,
      messages: (event.messages || []).map((message) => ({ ...message, round: Number(event.roundNumber) })),
    });
  }

  function emitRoundStatus(onEvent, event) {
    if (typeof onEvent !== "function") return;
    onEvent({
      type: "status",
      stage: event.stage,
      roundNumber: Number(event.roundNumber),
      waveNumber: event.waveNumber,
      action: event.action,
      reason: event.reason || "",
      nextSpeakers: event.nextSpeakers || [],
    });
  }

  async function decideRoundContinuation({ shared, personas, messages, roundNumber, topic, priorContext, completedWaves, maxWaves, signal }) {
    if (completedWaves >= maxWaves) {
      return {
        action: "summarize",
        reason: "已达到本轮自由讨论波次上限",
        nextSpeakers: [],
        discussionPrompt: "",
      };
    }

    const prompt = renderPrompt("round-facilitator-decision.md", {
      ...shared,
      topic,
      roundNumber,
      participantNames: personas.map((persona) => persona.name).join("、"),
      completedWaves,
      maxWaves,
      priorContext,
      currentTranscript: formatPromptTranscript(messages, 260),
    });
    const data = await llm.callJson(prompt, 0.35, {
      label: `session.round.facilitator.${completedWaves + 1}`,
      maxTokens: 900,
      repairMaxTokens: 1400,
      signal,
    });
    return normalizeRoundDecision(data, personas);
  }

  function normalizeRoundDecision(data, personas) {
    const source = data?.roundDecision || data?.decision || data || {};
    const rawAction = cleanGeneratedText(source.action || source.nextAction || source.status || "");
    const action = /summarize|summary|end|finish|收束|总结|结束/.test(rawAction.toLowerCase())
      ? "summarize"
      : "continue";
    const nextSpeakers = normalizeNextSpeakers(source.nextSpeakers || source.speakers || source.participants, personas);
    return {
      action,
      reason: truncateText(source.reason || source.rationale || "", 220),
      nextSpeakers,
      discussionPrompt: truncateText(source.discussionPrompt || source.prompt || source.focus || "", 260),
    };
  }

  function normalizeNextSpeakers(value, personas) {
    const raw = Array.isArray(value)
      ? value
      : String(value || "").split(/[、,，\s]+/);
    const personaNames = personas.map((persona) => persona.name);
    const selected = [];
    raw.forEach((item) => {
      const text = cleanGeneratedText(item);
      if (!text) return;
      const exact = personaNames.find((name) => name === text);
      const fuzzy = exact || personaNames.find((name) => text.includes(name) || name.includes(text));
      if (fuzzy && !selected.includes(fuzzy)) selected.push(fuzzy);
    });
    return selected.slice(0, 3);
  }

  function selectDiscussionPersonas({ decision, personas, roundNumber, waveNumber }) {
    const byName = new Map(personas.map((persona) => [persona.name, persona]));
    const selected = (decision.nextSpeakers || [])
      .map((name) => byName.get(name))
      .filter(Boolean);
    const minCount = Math.min(2, personas.length);
    if (selected.length >= minCount) return selected.slice(0, 3);

    const fallbackCount = personas.length <= 3 ? personas.length : (waveNumber % 2 === 0 ? 2 : 3);
    return selectRotatingPersonas(personas, roundNumber, waveNumber, fallbackCount);
  }

  function selectRotatingPersonas(personas, roundNumber, waveNumber, limit = 3) {
    if (!Array.isArray(personas) || personas.length <= limit) return personas || [];
    const start = (((Number(roundNumber) || 1) - 1) * 2 + ((Number(waveNumber) || 1) - 1) * limit) % personas.length;
    return Array.from({ length: limit }, (_, index) => personas[(start + index) % personas.length]);
  }

  async function generateModeratorTurn(values, personas) {
    const prompt = renderPrompt("moderator-turn.md", values);
    const data = await llm.callJson(prompt, 0.62, {
      label: values.label,
      maxTokens: estimateModeratorTurnTokens(),
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
      if (error.name === "AbortError" || error.name === "TimeoutError") throw error;
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
      participantStatesJson: values.participantStatesForParticipantsJson || values.participantStatesJson,
      contextStateJson: values.participantContextStateJson || values.contextStateJson,
      priorContext: values.participantPriorContext || values.priorContext,
      moderatorGuideText: values.participantModeratorGuideText || values.moderatorGuideText,
      participantNames: selectedNames.join("、"),
      selectedPersonasJson: compactJson(selectedPersonas.map(toPromptPersona)),
      selectedParticipantContextJson: compactJson(selectedPersonas.map((persona) => buildParticipantPromptContext({
        contextState: values.contextState,
        participantStates: values.participantStatesForPrompt,
        personas: allPersonas,
        persona,
        topic: values.topic,
        roundNumber: values.roundNumber,
        crossRoundContext: false,
      }))),
    });
    const data = await llm.callJson(prompt, 0.8, {
      label: values.label,
      maxTokens: estimateParticipantWaveTokens(selectedPersonas.length),
      repairMaxTokens: Math.min(8000, estimateParticipantWaveTokens(selectedPersonas.length) + 1400),
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
      participantStatesJson: values.participantStatesForParticipantsJson || values.participantStatesJson,
      contextStateJson: values.participantContextStateJson || values.contextStateJson,
      priorContext: values.participantPriorContext || values.priorContext,
      moderatorGuideText: values.participantModeratorGuideText || values.moderatorGuideText,
      participantNames: persona.name,
      selectedPersonasJson: compactJson([toPromptPersona(persona)]),
      selectedParticipantContextJson: compactJson(buildParticipantPromptContext({
        contextState: values.contextState,
        participantStates: values.participantStatesForPrompt,
        personas: allPersonas,
        persona,
        topic: values.topic,
        roundNumber: values.roundNumber,
        crossRoundContext: false,
      })),
    });
    const data = await llm.callJson(prompt, 0.8, {
      label: `${values.label}.${index + 1}`,
      maxTokens: estimateSingleParticipantTokens(),
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

  async function buildEvidencePackForSession({ config, topics, personas, moderatorGuide, signal }) {
    if (!searchClient?.canSearch?.()) {
      return normalizeEvidencePack({
        status: "skipped",
        generatedAt: todayIsoDate(),
        topic: config.productConcept || config.projectName || "未命名研究",
        skipReason: "search disabled or missing API key",
      });
    }

    llm.assertProviderReady();
    try {
      const maxQueries = searchClient.getStatus().maxQueries || 4;
      let queries = [];
      try {
        const planPrompt = renderPrompt("search-plan.md", {
          ...config,
          maxQueries,
          topicsJson: compactJson(topics.map((topic, index) => ({ round: index + 1, topic }))),
        });
        const plan = await llm.callJson(planPrompt, 0.35, {
          label: "search.plan",
          maxTokens: 1400,
          repairMaxTokens: 2200,
          signal,
        });
        queries = normalizeSearchQueries(plan.queries || plan.searchQueries || []).slice(0, maxQueries);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        console.warn(`[search evidence] planner failed; using fallback queries: ${error.message}`);
        queries = buildFallbackEvidenceQueries(config, topics, maxQueries);
      }

      if (!queries.length) queries = buildFallbackEvidenceQueries(config, topics, maxQueries);
      if (!queries.length) {
        return normalizeEvidencePack({
          status: "skipped",
          generatedAt: todayIsoDate(),
          topic: config.productConcept || config.projectName || "未命名研究",
          skipReason: "no searchable query",
        });
      }

      console.log(`[search] session evidence search: ${queries.map((item) => item.query).join(" | ")}`);
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
    handleEvidencePack,
    handleSessionRoundStream,
    handleReportStream,
    handleQuickFill,
  };
}

function buildParticipantRoundOnlyContext(roundPromptContext = {}) {
  return {
    schemaVersion: 2,
    currentRoundOnly: true,
    projectBrief: roundPromptContext.projectBrief || {},
    currentRound: buildParticipantVisibleRound(roundPromptContext.currentRound),
    previousRounds: [],
    unresolvedQuestions: [],
    participantMemory: [],
    recentEvidence: [],
    externalFindings: [],
    instruction: "受访者只回应主持人本轮公开提出的问题和本轮已出现的发言；跨轮总结、外部资料和未公开研究目标只供主持人使用。",
  };
}

function formatParticipantVisibleModeratorGuide(roundPromptContext = {}) {
  return JSON.stringify({
    currentRound: buildParticipantVisibleRound(roundPromptContext.currentRound),
    instruction: "这是受访者可见的本轮信息，不是完整主持提纲。请像真实用户一样回应主持人公开问题，不要主动覆盖研究计划。",
  });
}

function buildParticipantVisibleRound(currentRound = {}) {
  return {
    round: currentRound.round || "",
    totalRounds: currentRound.totalRounds || "",
    isFinalRound: Boolean(currentRound.isFinalRound),
    topic: currentRound.topic || "",
  };
}

function buildParticipantVisibleStates(personas = []) {
  return (personas || []).map((persona) => {
    const promptPersona = toPromptPersona(persona);
    return {
      name: promptPersona.name,
      segment: promptPersona.segment,
      snapshot: promptPersona.snapshot,
      currentAlternative: promptPersona.currentAlternative,
      switchTrigger: promptPersona.switchTrigger,
      budgetAnchor: promptPersona.budgetAnchor,
      evidenceNeeded: promptPersona.evidenceNeeded,
      discussionRole: promptPersona.discussionRole,
      concerns: promptPersona.concerns,
      dealBreaker: promptPersona.dealBreaker,
      speakingStyle: promptPersona.speakingStyle,
    };
  });
}

function writeStreamEvent(res, event) {
  res.write(`${JSON.stringify(event)}\n`);
}

function getRequestSignal(req) {
  return req.requestSignal;
}

function ensureModeratorGuide(moderatorGuide, config, topics) {
  const guide = normalizeModeratorGuide(moderatorGuide);
  if (
    guide.researchObjectives.length ||
    guide.coreHypotheses.length ||
    guide.roundPlan.length ||
    guide.probeStrategies.length ||
    guide.redFlags.length
  ) {
    return guide;
  }
  return buildFastModeratorGuide(config, topics);
}

function buildFastModeratorGuide(config = {}, topics = []) {
  const product = config.productConcept || config.projectName || "这个产品";
  const sellingPoints = config.coreSellingPoints || "核心卖点";
  const audience = config.targetAudience || "目标用户";
  const safeTopics = Array.isArray(topics) && topics.length
    ? topics
    : ["第一反应与核心价值", "使用场景与替代方案", "价格阻力与购买条件"];

  return normalizeModeratorGuide({
    moderatorGuide: {
      researchObjectives: [
        `判断${audience}对${product}的真实兴趣、抗性和购买条件。`,
        "识别最影响转化的硬阻力、证据缺口和功能优先级。",
        "把模拟访谈沉淀为后续真实调研可验证的假设。",
      ],
      coreHypotheses: [
        `${sellingPoints}中至少有一项能形成明确吸引点，但需要被具体场景证明。`,
        "价格、必要性、学习成本或可靠性会成为主要购买阻力。",
        "用户是否接受，取决于产品能否优于当前替代方案并降低试错风险。",
      ],
      roundPlan: safeTopics.map((topic, index) => ({
        round: index + 1,
        objective: inferFastGuideObjective(index + 1, safeTopics.length),
        keyQuestion: topic,
        mustProbe: [
          "具体使用场景是什么",
          "当前替代方案是什么",
          "购买或拒绝的关键条件是什么",
          "还需要什么证据才会改变判断",
        ],
        shallowAnswerSignals: [
          "只说有用或没用但没有场景",
          "只说贵但没有价格锚点",
          "没有和替代方案比较",
          "没有给出明确购买条件",
        ],
      })),
      probeStrategies: [
        "追问具体发生过的场景、参照物和决策阈值。",
        "让观点相反的受访者互相回应，暴露真实分歧。",
        "把模糊好感压到购买条件、证据需求和替代方案比较上。",
      ],
      redFlags: [
        "不要把受访者发言写成产品宣传语。",
        "不要用外部市场事实替代模拟访谈证据。",
        "不要只复述功能，要追问用户为什么会信或不信。",
      ],
    },
  });
}

function inferFastGuideObjective(roundNumber, totalRounds) {
  if (roundNumber <= 1) return "建立第一反应、核心价值判断和初始阻力。";
  if (roundNumber >= totalRounds) return "收束最终取舍、购买/拒绝条件和真实调研验证点。";
  const ratio = roundNumber / Math.max(1, totalRounds);
  if (ratio <= 0.4) return "追问具体使用场景、现有替代行为和功能必要性。";
  if (ratio <= 0.7) return "验证价格、成本、信任证据和竞品/替代方案比较。";
  return "明确产品改进优先级、转化条件和未解决顾虑。";
}

function isSearchEnhancementRequested(config = {}) {
  return parseBoolean(config.useSearchEnhancement || config.searchEnhancement || config.enableSearch);
}

function buildFallbackEvidenceQueries(config = {}, topics = [], maxQueries = 4) {
  const product = truncateText(config.productConcept || config.projectName || "", 80);
  if (!product) return [];
  const topicText = Array.isArray(topics) && topics.length ? ` ${topics.slice(0, 2).join(" ")}` : "";
  return [
    { query: `${product} 用户痛点 评价`, purpose: "了解真实用户痛点和评价语言", type: "pain_points", priority: 1 },
    { query: `${product} 竞品 替代方案`, purpose: "了解竞品、替代方案和比较参照", type: "competitor", priority: 2 },
    { query: `${product} 价格 购买门槛`, purpose: "了解价格锚点和购买阻力", type: "pricing", priority: 3 },
    { query: `${product}${topicText} 使用场景 顾虑`, purpose: "了解具体使用场景和决策顾虑", type: "reviews", priority: 4 },
  ].slice(0, maxQueries);
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value || "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "on";
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
