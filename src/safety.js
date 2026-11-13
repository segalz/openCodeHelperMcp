const SECRET_PATTERNS = [
  [/(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s"',;]+/gi, "$1[REDACTED]"],
  [/\bbearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/("(?:api[_-]?key|apikey|key|token|access(?:_token)?|refresh(?:_token)?|secret|password|client_secret|authorization)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"'],
  [/\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|client[_-]?secret|key)\s*[=:]\s*)[^\s"',;&]+/gi, "$1[REDACTED]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(?:nvapi|gsk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abpr]|hf|cf)[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/g, "[REDACTED]"],
];

export function redactSecrets(text) {
  let out = String(text ?? "");
  // A dumped auth.json (provider -> { type, key|access|refresh }) is dropped entirely.
  out = out.replace(/\{[^{}]*"type"\s*:\s*"(?:api|oauth|wellknown)"[^{}]*\}/gi, "{[REDACTED credentials]}");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

