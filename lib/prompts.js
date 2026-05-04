const fs = require("fs");
const path = require("path");

function createPromptStore(root) {
  function readPrompt(name) {
    return fs.readFileSync(path.join(root, "prompts", name), "utf8");
  }

  function renderPrompt(name, values) {
    const template = readPrompt(name);
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const value = values[key];
      if (Array.isArray(value)) return value.join("、");
      if (value === undefined || value === null) return "";
      return String(value);
    });
  }

  function listPromptFiles() {
    return fs
      .readdirSync(path.join(root, "prompts"))
      .filter((file) => file.endsWith(".md"))
      .sort();
  }

  return {
    readPrompt,
    renderPrompt,
    listPromptFiles,
  };
}

module.exports = {
  createPromptStore,
};
