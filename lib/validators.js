class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
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

module.exports = {
  HttpError,
  badRequest,
  requireProjectConfig,
  requireArray,
  requireStringArray,
  requireNonEmptyString,
  requirePositiveInteger,
};
