function estimatePersonaTokens(participantCount) {
  const count = Number(participantCount) || 5;
  return Math.min(5200, Math.max(2400, 650 + count * 420));
}

function estimateModeratorTurnTokens() {
  return 950;
}

function estimateSingleParticipantTokens() {
  return 1100;
}

function estimateParticipantWaveTokens(participantCount) {
  const count = Math.max(1, Number(participantCount) || 1);
  const perParticipant = estimateSingleParticipantTokens();
  return Math.min(7600, Math.max(perParticipant, 300 + count * Math.ceil(perParticipant * 0.9)));
}

function getReportMaxTokens() {
  const parsed = Number.parseInt(process.env.FOCUS_GROUP_REPORT_MAX_TOKENS || "", 10);
  const base = Number.isNaN(parsed) ? 5600 : parsed;
  return Math.min(10000, Math.max(3200, base));
}

function getParticipantParallelLimit() {
  const parsed = Number.parseInt(process.env.FOCUS_GROUP_PARTICIPANT_PARALLELISM || "3", 10);
  if (Number.isNaN(parsed)) return 3;
  return Math.min(4, Math.max(1, parsed));
}

function estimateFullSessionTokens(personaCount, topicCount) {
  const perMessage = 240;
  const overhead = 1000;
  return Math.min(14000, Math.max(3600, overhead + personaCount * topicCount * perMessage));
}

module.exports = {
  estimatePersonaTokens,
  estimateModeratorTurnTokens,
  estimateSingleParticipantTokens,
  estimateParticipantWaveTokens,
  getReportMaxTokens,
  getParticipantParallelLimit,
  estimateFullSessionTokens,
};
