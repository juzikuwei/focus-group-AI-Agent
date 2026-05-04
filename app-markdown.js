/* ============================================================
   Markdown → HTML (lightweight) + escape helpers
   ============================================================ */

export function markdownToHtml(markdown) {
  const lines = markdown.split("\n");
  const html = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      return;
    }
    if (trimmed.startsWith("# ")) {
      closeList();
      html.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`);
      return;
    }
    if (trimmed.startsWith("## ")) {
      closeList();
      html.push(`<h3>${escapeHtml(trimmed.slice(3))}</h3>`);
      return;
    }
    if (trimmed.startsWith("### ")) {
      closeList();
      html.push(`<h4>${escapeHtml(trimmed.slice(4))}</h4>`);
      return;
    }
    if (trimmed.startsWith("- ")) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${escapeHtml(trimmed.slice(2))}</li>`);
      return;
    }
    if (trimmed.startsWith("> ")) {
      closeList();
      html.push(`<div class="quote">${escapeHtml(trimmed.slice(2))}</div>`);
      return;
    }
    closeList();
    html.push(`<p>${escapeHtml(trimmed)}</p>`);
  });

  closeList();
  return html.join("");
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttr(value) {
  return escapeHtml(value);
}
