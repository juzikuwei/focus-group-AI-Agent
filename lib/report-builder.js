const { cleanGeneratedText } = require("./text-utils");
const { getReportMaxTokens } = require("./token-estimator");

function createReportBuilder({ llm }) {
  async function generateReportMarkdown(prompt, options = {}) {
    const onToken = typeof options.onToken === "function" ? options.onToken : null;
    const callReportText = onToken && typeof llm.callTextStream === "function"
      ? llm.callTextStream
      : llm.callText;

    let markdown = await callReportText(prompt, 0.55, false, {
      label: "report",
      maxTokens: getReportMaxTokens(),
      signal: options.signal,
      onToken,
    });

    for (let attempt = 1; attempt <= 2 && shouldContinueReport(markdown); attempt += 1) {
      console.warn(`[report continuation] report appears truncated; requesting continuation attempt ${attempt}.`);
      const continuation = await llm.callText(buildReportContinuationPrompt(markdown), 0.35, false, {
        label: `report.continue.${attempt}`,
        maxTokens: 2200,
        signal: options.signal,
      });
      const previousMarkdown = markdown;
      markdown = mergeReportContinuation(markdown, continuation);
      if (onToken && markdown.length > previousMarkdown.length) {
        onToken(markdown.slice(previousMarkdown.length));
      }
    }

    return markdown;
  }

  return { generateReportMarkdown };
}

function shouldContinueReport(markdown) {
  const text = cleanGeneratedText(markdown);
  if (!text) return false;
  const requiredFinalHeading = "## 后续真实调研建议";
  if (!text.includes(requiredFinalHeading)) return true;

  const finalSection = text.slice(text.lastIndexOf(requiredFinalHeading)).trim();
  if (finalSection.length < 180) return true;
  return endsWithIncompleteReportText(text);
}

function endsWithIncompleteReportText(text) {
  const trimmed = cleanGeneratedText(text);
  if (!trimmed) return false;
  const tail = trimmed.slice(-120).trim();
  if (/^#+\s*\S*$/.test(tail)) return true;
  if (/[，,、：:；;（(《“"']$/.test(tail)) return true;
  if (/[A-Za-z0-9]$/.test(tail)) return true;
  if (countChar(trimmed, "（") > countChar(trimmed, "）")) return true;
  if (countChar(trimmed, "(") > countChar(trimmed, ")")) return true;
  return !/[。.!！?？）)\]】》」』”’]$/.test(trimmed);
}

function buildReportContinuationPrompt(markdown) {
  const tail = cleanGeneratedText(markdown).slice(-2600);
  return `下面是一份中文 Markdown 洞察报告的末尾，报告可能因为输出长度限制在最后被截断。
请从截断处继续写完，不要重写已有内容，不要重复已经完整写过的段落，不要输出代码块。
如果末尾停在半句话、半个括号、半个列表项或半个例子中，请直接补全这句话。
必须继续保持匿名化表达，不要使用受访者姓名。
最终必须自然收束，并确保“## 后续真实调研建议”章节完整。

已生成报告末尾：
${tail}`;
}

function mergeReportContinuation(markdown, continuation) {
  const base = cleanGeneratedText(markdown);
  let extra = cleanGeneratedText(continuation);
  if (!extra) return base;

  const overlap = findTextOverlap(base, extra, 360);
  if (overlap > 0) {
    extra = extra.slice(overlap).trimStart();
  }
  const separator = endsWithIncompleteReportText(base) ? "" : "\n\n";
  return `${base}${separator}${extra}`;
}

function findTextOverlap(left, right, maxLength) {
  const max = Math.min(maxLength, left.length, right.length);
  for (let length = max; length >= 24; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return length;
  }
  return 0;
}

function countChar(text, char) {
  return Array.from(text).filter((item) => item === char).length;
}

module.exports = {
  createReportBuilder,
  shouldContinueReport,
  endsWithIncompleteReportText,
  buildReportContinuationPrompt,
  mergeReportContinuation,
};
