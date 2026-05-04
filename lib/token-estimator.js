const { getDepthProfile } = require("./interview-profiles");

function estimatePersonaTokens(participantCount) {
  const count = Number(participantCount) || 5;
  return Math.min(7000, Math.max(3600, 900 + count * 650));
}

function estimateModeratorTurnTokens(outputDepth) {
  const depth = getDepthProfile(outputDepth).name;
  if (depth === "深入") return 1300;
  if (depth === "简洁") return 750;
  return 950;
}

function estimateSingleParticipantTokens(outputDepth) {
  const depth = getDepthProfile(outputDepth).name;
  if (depth === "深入") return 1500;
  if (depth === "简洁") return 850;
  return 1100;
}

function getReportMaxTokens(outputDepth) {
  const depthName = getDepthProfile(outputDepth).name;
  const parsed = Number.parseInt(process.env.FOCUS_GROUP_REPORT_MAX_TOKENS || "", 10);
  const defaultByDepth = depthName === "深入" ? 7200 : depthName === "简洁" ? 4200 : 5600;
  const base = Number.isNaN(parsed) ? defaultByDepth : parsed;
  return Math.min(10000, Math.max(3200, base));
}

function getParticipantParallelLimit() {
  const parsed = Number.parseInt(process.env.FOCUS_GROUP_PARTICIPANT_PARALLELISM || "3", 10);
  if (Number.isNaN(parsed)) return 3;
  return Math.min(4, Math.max(1, parsed));
}

function estimateFullSessionTokens(personaCount, topicCount, outputDepth) {
  const depth = getDepthProfile(outputDepth).name;
  const perMessage = depth === "深入" ? 310 : depth === "简洁" ? 190 : 240;
  const overhead = depth === "深入" ? 1400 : 1000;
  return Math.min(14000, Math.max(3600, overhead + personaCount * topicCount * perMessage));
}

module.exports = {
  estimatePersonaTokens,
  estimateModeratorTurnTokens,
  estimateSingleParticipantTokens,
  getReportMaxTokens,
  getParticipantParallelLimit,
  estimateFullSessionTokens,
};
