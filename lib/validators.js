class HttpError extends Error {
  constructor(statusCode, message, code = "bad_request") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function badRequest(message) {
  throw new HttpError(400, message);
}

function requireProjectConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    badRequest("config is required");
  }
  requireNonEmptyString(config.productConcept, "config.productConcept");
  requireNonEmptyString(config.targetAudience, "config.targetAudience");
  requirePositiveInteger(config.participantCount, "config.participantCount");
  requirePositiveInteger(config.roundCount, "config.roundCount");
}

function requireArray(value, name, options = {}) {
  if (!Array.isArray(value)) {
    badRequest(`${name} must be an array`);
  }
  if (options.minLength && value.length < options.minLength) {
    badRequest(`${name} must contain at least ${options.minLength} item(s)`);
  }
}

function requireStringArray(value, name, options = {}) {
  requireArray(value, name, options);
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    badRequest(`${name} must contain only non-empty strings`);
  }
}

function requirePlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badRequest(`${name} must be an object`);
  }
}

function requireOptionalPlainObject(value, name) {
  if (value === undefined || value === null) return;
  requirePlainObject(value, name);
}

function requireObjectArray(value, name, options = {}) {
  requireArray(value, name, options);
  value.forEach((item, index) => {
    requirePlainObject(item, `${name}[${index}]`);
    (options.requiredStringFields || []).forEach((field) => {
      requireNonEmptyString(item[field], `${name}[${index}].${field}`);
    });
  });
}

function requireMessageArray(value, name, options = {}) {
  requireObjectArray(value, name, options);
  value.forEach((message, index) => {
    if (!hasAnyString(message, ["text", "content", "message"])) {
      badRequest(`${name}[${index}] must include text, content, or message`);
    }
    if (message.type !== "moderator" && !hasAnyString(message, ["speaker", "name"])) {
      badRequest(`${name}[${index}] must include speaker or name`);
    }
    if (message.round !== undefined) {
      requirePositiveInteger(message.round, `${name}[${index}].round`);
    }
  });
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    badRequest(`${name} is required`);
  }
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    badRequest(`${name} must be a positive integer`);
  }
}

function hasAnyString(value, fields) {
  return fields.some((field) => typeof value?.[field] === "string" && value[field].trim());
}

module.exports = {
  HttpError,
  badRequest,
  requireProjectConfig,
  requireArray,
  requireStringArray,
  requirePlainObject,
  requireOptionalPlainObject,
  requireObjectArray,
  requireMessageArray,
  requireNonEmptyString,
  requirePositiveInteger,
};
