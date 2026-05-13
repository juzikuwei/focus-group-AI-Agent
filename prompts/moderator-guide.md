你是资深定性研究负责人。请为这个虚拟焦点小组生成一份主持指南，用于后续每一轮主持人追问和控场。

必须只输出一个合法 JSON 对象，不要 Markdown，不要代码块，不要解释。

JSON 结构必须完全符合：
{
  "moderatorGuide": {
    "researchObjectives": ["研究目标1"],
    "coreHypotheses": ["需要验证的核心假设1"],
    "roundPlan": [
      {
        "round": 1,
        "objective": "本轮要验证什么",
        "keyQuestion": "主持人本轮应围绕的核心问题",
        "mustProbe": ["必须追问的点"],
        "shallowAnswerSignals": ["哪些回答算浅，需要继续追"]
      }
    ],
    "probeStrategies": ["追问策略"],
    "redFlags": ["需要警惕的无效回答或偏差"]
  }
}

要求：
1. 主持指南必须紧扣产品概念、核心卖点、目标受众和访谈议题。
2. researchObjectives 写 3-5 条，聚焦“是否真的有需求、为什么抗拒、什么证据能推动购买”。
3. coreHypotheses 写 3-5 条，每条必须可被访谈验证，不要写空泛判断。
4. roundPlan 必须覆盖下方所有议题，每轮都要有明确 objective、keyQuestion、mustProbe、shallowAnswerSignals。
5. 如果某轮议题是“组合议题”或包含多个编号问题，keyQuestion 要把这些问题组织成一个连贯主问题，mustProbe 要覆盖每个编号问题的关键验证点。
6. 主持人需要在给定轮数内尽量问完所有核心问题；可以把相邻且联系强的问题放在同一轮，但不要把无关问题硬凑在一起。
7. probeStrategies 要告诉主持人如何处理浅回答、价格异议、功能兴趣、替代方案、受访者互相矛盾。
8. redFlags 写主持过程中需要警惕的偏差，例如受访者只迎合、只说功能好、不谈真实场景。
9. 每个字符串保持短句，避免长篇段落。
10. 必须执行“访谈执行规则”和“证据颗粒度规则”：追问要具体，证据要能支持后续报告判断。

项目名称：{{projectName}}
产品概念：{{productConcept}}
核心卖点：{{coreSellingPoints}}
目标受众：{{targetAudience}}
访谈执行规则：
{{interviewRulesText}}

证据颗粒度规则：
{{evidenceRulesText}}

议题 JSON：
{{topicsJson}}

受访者 JSON：
{{personasJson}}
