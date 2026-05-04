/* ============================================================
   Report copy + print
   ============================================================ */

import { state } from "./app-state.js";
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

  document.body.classList.add("printing-report");
  // 等一帧确保 print CSS 应用到 DOM
  await new Promise((resolve) => requestAnimationFrame(resolve));

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    document.body.classList.remove("printing-report");
    window.removeEventListener("afterprint", cleanup);
  };

  window.addEventListener("afterprint", cleanup);
  try {
    window.print();
  } finally {
    // 兜底：部分浏览器不触发 afterprint，500ms 后强制清理
    setTimeout(cleanup, 800);
  }
}
