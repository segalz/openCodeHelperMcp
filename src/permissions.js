// OpenCode 1.19.x permission names, not legacy tool-toggle names.
const deniedPaths = ["**/.*", "**/.*/**", ".*", ".*/**", ...["node_modules", "dist", "build", "coverage", "out", "vendor"].flatMap(p => [`${p}/**`, `**/${p}/**`]), "**/id_rsa*", "**/credentials*", "**/secrets*", "**/auth.json", "**/*.pem", "**/*.key", "id_rsa*", "credentials*", "secrets*", "auth.json", "*.pem", "*.key"];
const reads = Object.freeze({ "*": "allow", ...Object.fromEntries(deniedPaths.map(p => [p, "deny"])) });
export const PERMISSION_PROFILES = Object.freeze({
  analysis: Object.freeze({ "*": "deny", read: reads, glob: "allow", grep: "allow", list: "allow", edit: "deny", bash: "deny", task: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny" }),
  edits: Object.freeze({ "*": "deny", read: reads, glob: "allow", grep: "allow", list: "allow", edit: reads, bash: "deny", task: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny" }),
});

export function validatePermissionProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("Invalid OpenCode permission profile.");
  if (profile["*"] !== "deny") throw new Error("Permission profiles must default to deny.");
  const keys = new Set(["*", "read", "glob", "grep", "list", "edit", "bash", "task", "webfetch", "websearch", "external_directory"]);
  for (const [key, rule] of Object.entries(profile)) {
    if (!keys.has(key)) throw new Error(`Unknown permission key: ${key}`);
    const rules = typeof rule === "string" ? [rule] : rule && typeof rule === "object" && !Array.isArray(rule) ? Object.values(rule) : [];
    if (!rules.length || rules.some(action => !["allow", "deny", "ask"].includes(action))) throw new Error(`Invalid permission rule: ${key}`);
    if (["webfetch", "websearch"].includes(key) && typeof rule !== "string") throw new Error(`Permission ${key} requires an action string.`);
  }
  return profile;
}

export function permissionEnvironment(env, mode = "analysis") {
  const profile = validatePermissionProfile(PERMISSION_PROFILES[mode]);
  const agent = mode === "analysis" ? "plan" : "build";
  // Inline config is loaded after project agent definitions. Explicitly override
  // the selected agent as well as global permissions. Retain unrelated settings,
  // but replace caller-supplied agent definitions with the explicit profile.
  let config = {};
  if (env.OPENCODE_CONFIG_CONTENT) {
    config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid OPENCODE_CONFIG_CONTENT.");
  }
  return {
    ...env,
    OPENCODE_PERMISSION: JSON.stringify(profile),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, agent: { [agent]: { mode: "primary", disable: false, permission: profile } } }),
  };
}

export function excludedPath(file) {
  const parts = file.replaceAll("\\", "/").split("/");
  return parts.some(p => p.startsWith(".") || ["node_modules", "dist", "build", "coverage", "out", "vendor"].includes(p.toLowerCase())) ||
    /(?:^|\/)(?:id_rsa[^/]*|credentials[^/]*|secrets[^/]*|auth\.json)$|\.(?:pem|key)$/i.test(file);
}
