const TYPE_VALUE = /^(?:string|number|boolean|bigint|symbol|object|unknown|any|never|void|undefined|null|true|false)(?:\[\])?[),;}>\]]*$/;
const GIT_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// Secret names, optionally with a prefix (`DB_PASSWORD`, `db_password`); `…key` names are decided by keyNameIsSecret.
const SECRET_NAME = String.raw`(?:[A-Za-z0-9]+[_-])*(?:api[_-]?(?:key|token)|apikey|token|access(?:[_-]?token)?|refresh(?:[_-]?token)?|auth[_-]?token|secret|password|passwd|client[_-]?secret|session[_-]?id|authorization|key)`;
const SECRET_KEY_PREFIX = /(?:^|[_-])(?:private|secret|access|signing|encryption|master|license|service|client|deploy|ssh|gpg|pgp|openai|anthropic|api)[_-]key$/i;
const credentialLike = (value) => value.length >= 16 && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
/**
 * A name ending in `key` is a secret when it is an environment-style name (`PRIVATE_KEY`, `OPENAI_KEY`) or a known
 * secret kind (`private_key`, `"signing-key"`); other keys (`key`, `sort_key`, `primary_key`, JSX `key="row-1"`)
 * hide only a value that looks like a credential (plan S20, Gate 6).
 */
function keyNameIsSecret(name, value, quoted) {
  if (!/key$/i.test(name)) return true;
  if (/^[A-Z0-9_]+_KEY$/.test(name) || SECRET_KEY_PREFIX.test(name) || /api[_-]?key$/i.test(name)) return true;
  // An unquoted bare `key: <v>` was always hidden and stays so; a quoted one may be a JSX prop or a sort key.
  if (/^key$/i.test(name) && !quoted) return true;
  return credentialLike(value);
}

const SECRET_PATTERNS = [
  // Quoted value after a secret name (also `=>`, `:=`, triple quotes, a scheme, a string prefix such as rb"…"). A
  // quoted type literal (`token: "string"`) is not a secret (plan S20 review).
  [new RegExp(String.raw`((["']?)\b(${SECRET_NAME})\2\s*(?::=|=>|[:=])\s*(?:(?:bearer|basic)[ \t]+)?)([a-z]{1,2})?("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')`, "gi"),
    (match, prefix, _keyQuote, name, stringPrefix, value) => {
      const quote = value.startsWith('"""') || value.startsWith("'''") ? value.slice(0, 3) : value[0];
      const inner = value.slice(quote.length, value.length - quote.length);
      // `token: "string"` is a TypeScript literal type; `password: f"string"` is a Python string that may hold a secret.
      if (!stringPrefix && TYPE_VALUE.test(inner)) return match;
      if (!keyNameIsSecret(name, inner, true)) return match;
      return prefix + quote + "[REDACTED]" + quote;
    }],
  [/(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)[ \t]+)?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',;]+)/gi, "$1[REDACTED]"],
  [/\bbearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "Bearer [REDACTED]"],
  // Unquoted value after a secret name; a scheme word (`token = Basic <v>`) is skipped so the value itself is hidden.
  [new RegExp(String.raw`\b((${SECRET_NAME})\s*(:=|=>|[=:])\s*(?:(?:bearer|basic)[ \t]+)?)([^\s"',;&]+)`, "gi"),
    (match, prefix, name, sep, value) => (sep === ":" && TYPE_VALUE.test(value)) || value === "[REDACTED]" || !keyNameIsSecret(name, value, false)
      ? match : `${prefix}[REDACTED]`],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(?:nvapi|gsk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abpr]|hf|cf)[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/g,
    (match, offset, full) => {
      if (!GIT_SHA.test(match)) return "[REDACTED]";
      // A Git SHA in prose (`commit <sha>`, `(<sha>)`) stays readable. Walk back over spaces and opening wrappers
      // (quotes, backticks, brackets, a string prefix such as r"..."): a value of an assignment, a mapping, a
      // redacted key or a secret-named flag is a credential (plan S18 review).
      let i = offset - 1;
      for (;;) {
        while (i >= 0 && /[\s"'`(\[{\\]/.test(full[i])) i--;
        const prefix = /(?:^|\W)([rbfu]{1,2})$/i.exec(full.slice(Math.max(0, i - 2), i + 1));
        if (prefix) { i -= prefix[1].length; continue; }
        break;
      }
      if (i < 0) return match;
      if (full[i] === "=" || full[i] === ":" || full[i] === ">") return "[REDACTED]";
      const before = full.slice(Math.max(0, i - 80), i + 1);
      return /(?:\[REDACTED\]|(?:token|key|secret|password|passwd|session|auth|credential|cookie)[\w-]*)$/i.test(before) ? "[REDACTED]" : match;
    }],
];

export function redactSecrets(text) {
  let out = String(text ?? "");
  // A dumped auth.json (provider -> { type, key|access|refresh }) is dropped entirely.
  out = out.replace(/\{[^{}]*"type"\s*:\s*"(?:api|oauth|wellknown)"[^{}]*\}/gi, "{[REDACTED credentials]}");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

