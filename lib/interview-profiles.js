const { cleanGeneratedText } = require("./text-utils");

function buildInterviewControls(config = {}) {
  const style = getStyleProfile(config.tone);
  const depth = getDepthProfile(config.outputDepth);
  return {
    interviewStyleName: style.name,
    outputDepthName: depth.name,
    styleRulesText: style.rules.join("\n"),
    depthRulesText: depth.rules.join("\n"),
    reportDepthRulesText: depth.reportRules.join("\n"),
    moderatorWordRange: depth.moderatorWordRange,
    summaryWordRange: depth.summaryWordRange,
    participantWordRange: depth.participantWordRange,
    directParticipantWordRange: depth.directParticipantWordRange,
    minEvidenceTypes: depth.minEvidenceTypes,
    reportItemsPerSection: depth.reportItemsPerSection,
    probeIntensity: style.probeIntensity,
  };
}

function getStyleProfile(tone) {
  const normalized = cleanGeneratedText(tone || "犀利");
  const profiles = {
    温和: {
      name: "温和探索",
      probeIntensity: "medium",
      rules: [
        "- 主持人先复述或承接受访者的具体处境，再追问原因和证据。",
        "- 允许受访者表达犹豫，不用强压结论；重点挖出真实顾虑和使用场景。",
        "- 遇到矛盾观点时用对比式提问，例如“刚才有人担心 X，你这里为什么不同？”",
        "- 避免审问感，少用“为什么不直接买”这类压迫式表达。",
      ],
    },
    真实: {
      name: "真实自然",
      probeIntensity: "medium",
      rules: [
        "- 主持人语言像真实访谈现场，短句、自然、少术语。",
        "- 优先追问生活细节、真实经历和替代做法，不追求漂亮结论。",
        "- 对模糊回答要继续问“具体是哪一次/和什么相比/最后怎么决定”。",
        "- 保持中立，不替产品辩护，也不替受访者总结成营销话术。",
      ],
    },
    犀利: {
      name: "犀利追问",
      probeIntensity: "high",
      rules: [
        "- 主持人要主动抓矛盾、抓空话、抓购买条件，追问到可验证证据。",
        "- 对“有点贵/挺方便/看体验”必须继续追问参照物、具体阈值和拒绝条件。",
        "- 可以点名比较不同受访者观点，推动争议显性化，但不要替受访者下结论。",
        "- 少寒暄，问题要直接压到场景、成本、替代方案和转化阻力。",
      ],
    },
    专家型: {
      name: "专业中立",
      probeIntensity: "high",
      rules: [
        "- 主持人像正式研究主持人，结构清楚、问题中立、证据导向。",
        "- 每轮优先验证假设、抗性、购买触发条件和需要补充的真实调研证据。",
        "- 追问时使用“场景-阻力-证据-动作”的结构，但语言仍要口语化。",
        "- 避免专家说教，不使用广告、咨询报告或产品经理自嗨口吻。",
      ],
    },
    专业中立: {
      name: "专业中立",
      probeIntensity: "high",
      rules: [
        "- 主持人像正式研究主持人，结构清楚、问题中立、证据导向。",
        "- 每轮优先验证假设、抗性、购买触发条件和需要补充的真实调研证据。",
        "- 追问时使用“场景-阻力-证据-动作”的结构，但语言仍要口语化。",
        "- 避免专家说教，不使用广告、咨询报告或产品经理自嗨口吻。",
      ],
    },
  };
  return profiles[normalized] || profiles.犀利;
}

function getDepthProfile(outputDepth) {
  const normalized = cleanGeneratedText(outputDepth || "标准");
  const profiles = {
    简洁: {
      name: "简洁",
      moderatorWordRange: "45-100",
      summaryWordRange: "70-110",
      participantWordRange: "90-150",
      directParticipantWordRange: "70-120",
      minEvidenceTypes: 2,
      reportItemsPerSection: "1-3",
      rules: [
        "- 保持高密度，不铺垫；每条发言只保留最关键的场景、顾虑和购买条件。",
        "- 主持人每次只追一个最重要的问题，不同时展开多个方向。",
        "- 受访者每条至少给出 2 类证据：场景、顾虑、替代方案、价格/时间成本、购买条件。",
        "- 小结只写共识、分歧和最重要的后续验证点。",
      ],
      reportRules: [
        "- 报告每节 1-3 个要点，优先写影响最大的结论。",
        "- 少写背景解释，直接给证据依据和产品动作。",
        "- 关键原话控制在 3-4 条，避免长篇摘录。",
      ],
    },
    标准: {
      name: "标准",
      moderatorWordRange: "60-140",
      summaryWordRange: "80-140",
      participantWordRange: "120-220",
      directParticipantWordRange: "90-150",
      minEvidenceTypes: 3,
      reportItemsPerSection: "2-4",
      rules: [
        "- 在具体和流畅之间平衡；每轮既要推进议题，也要保留小组讨论感。",
        "- 主持人每次追问 1 个主问题，必要时附带 1 个具体参照。",
        "- 受访者每条至少给出 3 类证据：场景、顾虑、替代方案、价格/时间成本、购买或拒绝条件。",
        "- 小结要覆盖共识、分歧和下一步验证方向。",
      ],
      reportRules: [
        "- 报告每节 2-4 个要点，结论、证据、影响和动作都要出现。",
        "- 关键原话控制在 4-6 条，优先选择能代表分歧或转化阻力的原话。",
        "- 产品建议要具体，但避免写成过长执行方案。",
      ],
    },
    深入: {
      name: "深入",
      moderatorWordRange: "80-170",
      summaryWordRange: "110-180",
      participantWordRange: "160-280",
      directParticipantWordRange: "120-210",
      minEvidenceTypes: 4,
      reportItemsPerSection: "3-5",
      rules: [
        "- 主持人要追到二阶原因：表面顾虑背后的风险感、控制感、社交压力或替代方案惯性。",
        "- 每轮允许围绕一个关键矛盾做更深入追问，但不要离开本轮议题。",
        "- 受访者每条至少给出 4 类证据：场景、个人经验、替代方案比较、价格/时间/学习成本、购买条件、拒绝条件、对他人观点回应。",
        "- 小结除了共识和分歧，还要指出尚未验证的心理门槛或证据缺口。",
      ],
      reportRules: [
        "- 报告每节 3-5 个要点，必须展开阻力成因、转化影响和产品动作。",
        "- 关键原话控制在 5-8 条，并覆盖积极、犹豫、拒绝和态度变化。",
        "- 后续真实调研建议要给出具体验证方法、样本或指标方向。",
      ],
    },
  };
  return profiles[normalized] || profiles.标准;
}

module.exports = {
  buildInterviewControls,
  getStyleProfile,
  getDepthProfile,
};
