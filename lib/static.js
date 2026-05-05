const fs = require("fs");
const path = require("path");
const { sendJson } = require("./http");

const mimeTypes = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "application/javascript;charset=utf-8",
};

const allowedStaticFiles = new Set([
  "index.html",
  "styles.css",
  "app.js",
  "app-api.js",
  "app-export.js",
  "app-markdown.js",
  "app-render.js",
  "app-state.js",
  "app-storage.js",
]);

function serveStatic(root, req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    return sendJson(res, 400, { error: "Invalid URL" });
  }

  const requestedPath = urlPath === "/" ? "index.html" : urlPath.replace(/^[/\\]+/, "");
  const filePath = path.resolve(root, requestedPath);
  const relativePath = path.relative(root, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  if (isBlockedStaticPath(relativePath)) {
    return sendJson(res, 404, { error: "Not found" });
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      return sendJson(res, 404, { error: "Not found" });
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function isBlockedStaticPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) return true;
  if (segments.length !== 1) return true;
  return !allowedStaticFiles.has(normalized);
}

module.exports = {
  serveStatic,
};
