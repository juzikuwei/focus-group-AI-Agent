const INTERVIEW_RULES = [
  "- 主持人语言像真实访谈现场，短句、自然、少术语。",
  "- 主持人每次优先抓一个最值得追的点，必要时追问参照物、具体阈值或拒绝条件。",
  "- 对“有点贵/挺方便/看体验”这类空话，可以追问一个具体例子或比较对象。",
  "- 可以点名比较不同受访者观点，但不要为了制造冲突而强行点名。",
  "- 保持中立，不替产品辩护，也不把受访者总结成营销话术。",
];

const RESPONSE_RULES = [
  "- 在具体和流畅之间平衡；每轮既要推进议题，也要保留小组讨论感。",
  "- 主持人每次围绕 1 条主线，必要时附带 1-2 个强相关小问或具体参照。",
  "- 受访者可以表达不完整，但本轮整体要留下场景、顾虑、替代方案、成本或购买条件等可分析材料。",
  "- 小结要覆盖共识、分歧和下一步验证方向。",
];

const REPORT_RULES = [
  "- 报告每节 2-4 个要点，结论、证据、影响和动作都要出现。",
  "- 关键原话控制在 4-6 条，优先选择能代表分歧或转化阻力的原话。",
  "- 产品建议要具体，但避免写成过长执行方案。",
];

const DEFAULT_DEPTH_PROFILE = {
  name: "标准",
  moderatorWordRange: "60-140",
  summaryWordRange: "80-140",
  participantWordRange: "120-220",
  directParticipantWordRange: "90-150",
  minEvidenceTypes: 3,
  reportItemsPerSection: "2-4",
  rules: RESPONSE_RULES,
  reportRules: REPORT_RULES,
};

function buildInterviewControls() {
  const style = getStyleProfile();
  const depth = getDepthProfile();
  return {
    interviewRulesText: style.rules.join("\n"),
    evidenceRulesText: depth.rules.join("\n"),
    reportRulesText: depth.reportRules.join("\n"),
    moderatorWordRange: depth.moderatorWordRange,
    summaryWordRange: depth.summaryWordRange,
    participantWordRange: depth.participantWordRange,
    directParticipantWordRange: depth.directParticipantWordRange,
    minEvidenceTypes: depth.minEvidenceTypes,
    reportItemsPerSection: depth.reportItemsPerSection,
    probeIntensity: style.probeIntensity,
  };
}

function getStyleProfile() {
  return {
    name: "默认访谈规则",
    probeIntensity: "high",
    rules: INTERVIEW_RULES,
  };
}

function getDepthProfile() {
  return DEFAULT_DEPTH_PROFILE;
}

module.exports = {
  buildInterviewControls,
  getStyleProfile,
  getDepthProfile,
};
