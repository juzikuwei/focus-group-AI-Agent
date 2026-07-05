/* ============================================================
   Markdown → HTML (lightweight) + escape helpers
   ============================================================ */

export function markdownToHtml(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];
  let current = { type: "p", content: [] };

  const push = () => {
    if (current.content.length) {
      if (current.type === "ul") {
        blocks.push({ type: "ul", items: [...current.content] });
      } else {
        blocks.push({ type: current.type, text: current.content.join("\n") });
      }
      current = { type: "p", content: [] };
    }
  };

  let tableRows = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Table detection
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      // Check if next line is separator (|---|---|)
      const nextLine = (lines[i + 1] || "").trim();
      if (!inTable && /^\|[\s\-:|]+\|$/.test(nextLine)) {
        // Start of table: this is header row
        inTable = true;
        push();
        const headers = trimmed.split("|").filter((c) => c.trim()).map((c) => c.trim());
        tableRows = [{ type: "header", cells: headers }];
        i++; // skip separator line
        continue;
      }
      if (inTable) {
        const cells = trimmed.split("|").filter((c) => c.trim()).map((c) => c.trim());
        tableRows.push({ type: "row", cells });
        continue;
      }
    }

    // End of table
    if (inTable) {
      blocks.push({ type: "table", rows: tableRows });
      tableRows = [];
      inTable = false;
    }

    if (!trimmed) { push(); continue; }
    if (trimmed === "---") { push(); blocks.push({ type: "hr" }); continue; }
    if (trimmed.startsWith("# ")) { push(); blocks.push({ type: "h1", text: trimmed.slice(2) }); continue; }
    if (trimmed.startsWith("## ")) { push(); blocks.push({ type: "h2", text: trimmed.slice(3) }); continue; }
    if (trimmed.startsWith("### ")) { push(); blocks.push({ type: "h3", text: trimmed.slice(4) }); continue; }
    if (trimmed.startsWith("- ")) {
      if (current.type !== "ul") { push(); current.type = "ul"; }
      current.content.push(trimmed.slice(2));
      continue;
    }
    if (trimmed.startsWith("> ")) { push(); blocks.push({ type: "quote", text: trimmed.slice(2) }); continue; }
    if (current.type !== "p") { push(); current.type = "p"; }
    current.content.push(trimmed);
  }
  // Flush table if file ends with one
  if (inTable && tableRows.length) {
    blocks.push({ type: "table", rows: tableRows });
  }
  push();

  // Post-process: wrap **bold-only lines** followed by paragraphs as key findings
  const processed = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // A paragraph that is entirely bold = key finding title
    if (b.type === "p" && /^\*\*.+\*\*$/.test(b.text.trim())) {
      const next = blocks[i + 1];
      if (next && next.type === "p" && !/^\*\*.+\*\*$/.test(next.text.trim())) {
        processed.push({ type: "finding", title: b.text, body: next.text });
        i++; // skip next block
        continue;
      }
    }
    processed.push(b);
  }

  // Render
  let html = "";
  let inSection = false;
  processed.forEach((block) => {
    if (block.type === "h2") {
      if (inSection) html += "</div>";
      const cls = sectionClass(block.text);
      html += `<div class="report-section ${cls}"><h2>${inline(block.text)}</h2>`;
      inSection = true;
      return;
    }
    html += renderBlock(block);
  });
  if (inSection) html += "</div>";
  return html;
}

function sectionClass(title) {
  const t = title.toLowerCase();
  if (/摘要|概述|概要|背景|简介/.test(t)) return "rs-summary";
  if (/发现|洞察|核心|关键|分析|结果|概览/.test(t)) return "rs-findings";
  if (/原声|引[用言]|反馈|声音|观点/.test(t)) return "rs-quotes";
  if (/建议|行动|方案|策略|推荐|下一步/.test(t)) return "rs-actions";
  if (/结论|总结|小结/.test(t)) return "rs-conclusion";
  if (/数据|统计|数字/.test(t)) return "rs-data";
  if (/抗性|阻力|痛点/.test(t)) return "rs-resistance";
  if (/期待|功能|需求/.test(t)) return "rs-features";
  return "rs-default";
}

function renderBlock(block) {
  switch (block.type) {
    case "h1": return `<h1>${inline(block.text)}</h1>`;
    case "h3": return `<h3>${inline(block.text)}</h3>`;
    case "ul": return `<ul>${(block.items || []).map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`;
    case "quote": return `<blockquote>${inline(block.text)}</blockquote>`;
    case "hr": return `<hr />`;
    case "table": return renderTable(block.rows);
    case "finding": return `<div class="report-finding"><div class="report-finding-title">${inline(block.title)}</div><div class="report-finding-body">${inline(block.body)}</div></div>`;
    default: return `<p>${inline(block.text)}</p>`;
  }
}

function renderTable(rows) {
  if (!rows.length) return "";
  const header = rows[0];
  const body = rows.slice(1);
  let html = '<div class="table-wrap"><table>';
  html += "<thead><tr>";
  header.cells.forEach((c) => { html += `<th>${inline(c)}</th>`; });
  html += "</tr></thead>";
  html += "<tbody>";
  body.forEach((row) => {
    html += "<tr>";
    row.cells.forEach((c) => { html += `<td>${inline(c)}</td>`; });
    html += "</tr>";
  });
  html += "</tbody></table></div>";
  return html;
}

/** Parse inline markdown: **bold**, *italic*, `code` */
function inline(text) {
  let s = escapeHtml(text);
  // Bold: **text** (greedy for nested cases)
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Strip unmatched ** markers
  s = s.replace(/\*\*/g, "");
  // Italic: *text*
  s = s.replace(/(?<![<\/])\*(?!\*)(.+?)(?<!\*)\*(?![>*])/g, "<em>$1</em>");
  // Inline code: `text`
  s = s.replace(/`(.+?)`/g, "<code>$1</code>");
  return s;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
