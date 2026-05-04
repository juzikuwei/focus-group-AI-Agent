function cleanGeneratedText(text) {
  return String(text || "")
    .trim()
    .replace(/^```[\w-]*\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^["“]|["”]$/g, "")
    .trim();
}

function compactJson(value) {
  return JSON.stringify(value);
}

function truncateText(value, maxLength) {
  const text = cleanGeneratedText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function formatPromptTranscript(messages, maxTextLength) {
  return (messages || [])
    .map((message) => `${message.speaker}：${truncateText(message.text, maxTextLength)}`)
    .filter(Boolean)
    .join("\n");
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length || 1);
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = {
  cleanGeneratedText,
  compactJson,
  truncateText,
  formatPromptTranscript,
  mapWithConcurrency,
};
