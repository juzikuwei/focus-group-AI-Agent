function toClientError(error) {
  if (error?.name === "AbortError") {
    return {
      statusCode: 499,
      payload: { error: "Request cancelled", code: "request_cancelled" },
      shouldLog: false,
    };
  }

  if (error?.statusCode && error.statusCode < 500) {
    return {
      statusCode: error.statusCode,
      payload: {
        error: error.safeMessage || error.message || "Bad request",
        code: error.code || "bad_request",
      },
      shouldLog: false,
    };
  }

  if (isSafeConfigError(error)) {
    return {
      statusCode: 400,
      payload: {
        error: error.message,
        code: error.code || "config_error",
      },
      shouldLog: false,
    };
  }

  if (isKnownAiError(error)) {
    return {
      statusCode: error.statusCode || 502,
      payload: {
        error: error.safeMessage || error.message || "AI 服务调用失败，请稍后重试。",
        code: error.code || "ai_service_error",
      },
      shouldLog: true,
    };
  }

  return {
    statusCode: 502,
    payload: {
      error: "AI 服务调用失败，请检查服务端日志或稍后重试。",
      code: "ai_service_failed",
    },
    shouldLog: true,
  };
}

function toStreamErrorEvent(error) {
  const clientError = toClientError(error);
  return {
    type: "error",
    error: clientError.payload.error,
    code: clientError.payload.code,
    status: clientError.statusCode,
  };
}

function isKnownAiError(error) {
  const code = String(error?.code || "");
  return code.startsWith("ai_") || code.startsWith("search_");
}

function isSafeConfigError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("没有配置 endpoint") ||
    (message.includes("缺少") && message.includes("API Key"))
  );
}

module.exports = {
  toClientError,
  toStreamErrorEvent,
};
