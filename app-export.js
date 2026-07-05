/* ============================================================
   Report copy + PDF download
   ============================================================ */

import { getConfig, state } from "./app-state.js";
import { showToast } from "./app-api.js";

export async function copyReport() {
  if (!state.reportMarkdown) {
    showToast("还没有可复制的报告");
    return;
  }
  try {
    await navigator.clipboard.writeText(state.reportMarkdown);
    showToast("报告已复制");
  } catch {
    showToast("浏览器未允许复制");
  }
}

export async function downloadReport() {
  if (!state.reportMarkdown) {
    showToast("还没有可导出的报告");
    return;
  }

  const el = document.getElementById("reportContent");
  if (!el) {
    showToast("找不到报告内容");
    return;
  }

  if (typeof window.html2pdf === "undefined") {
    showToast("PDF 组件未加载，请刷新页面后重试");
    return;
  }

  showToast("正在生成 PDF...");

  const projectName = sanitizeFilename(getConfig().projectName || "洞察报告");
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${projectName}_${dateStr}.pdf`;

  const opt = {
    margin: [15, 15, 15, 15],
    filename,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, logging: false },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak: { mode: ["avoid-all", "css", "legacy"] },
  };

  try {
    await window.html2pdf().set(opt).from(el).save();
    showToast("PDF 已下载");
  } catch (err) {
    console.error("PDF export error:", err);
    showToast("PDF 导出失败，请重试");
  }
}

function sanitizeFilename(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim()
    .slice(0, 80) || "洞察报告";
}
