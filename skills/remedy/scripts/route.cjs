/* Model routing for the remedy ledger: which agent, model and effort a unit of work should run as.
 * Pure functions, no I/O. remedy.cjs supplies the item, meta.models and (for riskPaths) the plan text.
 * Aliases only (opus, sonnet, haiku, inherit); a dated model id is a validation error. */
"use strict";

const ALIASES = ["opus", "sonnet", "haiku"];
const MODEL_VALUES = [...ALIASES, "inherit"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const RISKS = ["security", "auth", "money", "data-migration", "mechanical", "routine"];
const RISK_OPUS = new Set(["security", "auth", "money", "data-migration"]);
const TIER = { haiku: 0, sonnet: 1, opus: 2 };
const DEFAULT_EFFORT = { opus: "high", sonnet: "medium", haiku: "low" };
const DEFAULT_PREFIXES = ["SEC", "PAY", "DATA"];

// role -> [models key, default model, agent, turns]
const ROLES = {
  coordinator: ["coordinator", "sonnet", "remedy-coordinator", "none"],
  triager: ["triager", "sonnet", "remedy-triager", 30],
  "audit-hunter": ["auditHunter", "sonnet", "audit-hunter", 40],
  "audit-hunter-deep": ["auditHunterDeep", "opus", "audit-hunter", 40],
  "audit-verifier": ["auditVerifier", "opus", "audit-verifier", 30],
  "campaign-author": ["campaignAuthor", "sonnet", "campaign-author", 60],
  tester: ["tester", "haiku", "remedy-tester", 15],
  investigator: ["investigator", "sonnet", "remedy-investigator", 25],
  planner: ["planner", "opus", "remedy-planner", 60],
  builder: ["builder", "sonnet", "remedy-builder", 60],
  "builder-risk": ["builderRisk", "opus", "remedy-builder", 60],
  "builder-mechanical": ["builderMechanical", "haiku", "remedy-builder", 60],
  "builder-escalation": ["builderEscalation", "opus", "remedy-builder", 60],
  reviewer: ["reviewer", "opus", "remedy-reviewer", 30],
};
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function effortFor(models, model) { return (models?.effort && models.effort[model]) || DEFAULT_EFFORT[model] || "medium"; }
function modelFor(models, role) { const [key, def] = ROLES[role]; return models?.[key] || def; }

function result(role, model, models, reason, extra) {
  const [, , agent, turns] = ROLES[role];
  return { role, agent: "fixit-plugin:" + agent, model, effort: model === "inherit" ? "inherit" : effortFor(models, model), turns, reason, ...extra };
}

function resolveRole(role, models) {
  const r = ROLES[role] ? role : Object.keys(ROLES).find((k) => camel(k) === role);
  if (!r) throw new Error(`Unknown role ${role}. One of: ${Object.keys(ROLES).join(", ")}`);
  return result(r, modelFor(models, r), models, "role default");
}

// First match wins; rules 3-6 all land on opus, so every one that applies is named in the reason.
function resolveItem(item, models, planText) {
  models = models || {};
  if (item.model) return result("builder", item.model, models, "pinned by `remedy route --set`");
  if (item.escalation?.model) return result("builder-escalation", item.escalation.model, models, `escalated: ${item.escalation.reason || "same failure twice"}`);
  const why = [];
  if (item.severity === "critical" || item.severity === "high") why.push(`severity ${item.severity}`);
  if (RISK_OPUS.has(item.risk)) why.push(`risk ${item.risk}`);
  const prefix = String(item.id || "").split("-")[0];
  if ((models.riskPrefixes || DEFAULT_PREFIXES).includes(prefix)) why.push(`prefix ${prefix}`);
  const hit = planText && (models.riskPaths || []).find((p) => planText.includes(p));
  if (hit) why.push(`plan touches ${hit}`);
  if (why.length) return result("builder-risk", modelFor(models, "builder-risk"), models, why.join("; "));
  if (item.risk === "mechanical") return result("builder-mechanical", modelFor(models, "builder-mechanical"), models, "risk mechanical", { mode: "mechanical" });
  return result("builder", modelFor(models, "builder"), models, "default");
}

// A cluster built by one worker takes the highest tier among its items.
function highest(results) {
  return results.reduce((a, b) => ((TIER[b.model] ?? 1) > (TIER[a.model] ?? 1) ? b : a));
}

const routeLine = (r) => `route: agent=${r.agent} model=${r.model} effort=${r.effort} turns=${r.turns} reason="${r.reason}"`;

// Problems with meta.models, for validate. Returns error strings.
function checkModels(models) {
  const errs = [];
  if (models === undefined) return errs;
  if (!models || typeof models !== "object" || Array.isArray(models)) return ["meta.models must be an object"];
  const bad = (v) => (v === "inherit" || ALIASES.includes(v) ? null : /\d{8}|claude-/.test(String(v)) ? "is a dated or full model id; use opus, sonnet, haiku or inherit" : "must be opus, sonnet, haiku or inherit");
  for (const [role, [key]] of Object.entries(ROLES)) if (models[key] !== undefined && bad(models[key])) errs.push(`meta.models.${key} ${models[key]} ${bad(models[key])}`);
  for (const k of ["riskPrefixes", "riskPaths"]) if (models[k] !== undefined && !(Array.isArray(models[k]) && models[k].every((x) => typeof x === "string"))) errs.push(`meta.models.${k} must be a list of strings`);
  if (models.effort !== undefined) {
    if (!models.effort || typeof models.effort !== "object") errs.push("meta.models.effort must be an object");
    else for (const [m, e] of Object.entries(models.effort)) {
      if (!ALIASES.includes(m)) errs.push(`meta.models.effort.${m}: key must be opus, sonnet or haiku`);
      if (!EFFORTS.includes(e)) errs.push(`meta.models.effort.${m} ${e} must be one of ${EFFORTS.join(", ")}`);
    }
  }
  if (models.budgetUsd !== undefined && !(typeof models.budgetUsd === "number" && models.budgetUsd > 0)) errs.push("meta.models.budgetUsd must be a positive number");
  return errs;
}
// Problems with one item's routing fields.
function checkItemRouting(i) {
  const errs = [];
  if (i.risk !== undefined && !RISKS.includes(i.risk)) errs.push(`unknown risk ${i.risk}; one of ${RISKS.join(", ")}`);
  if (i.model !== undefined && !MODEL_VALUES.includes(i.model)) errs.push(`model ${i.model} must be opus, sonnet, haiku or inherit${/\d{8}|claude-/.test(String(i.model)) ? " (dated ids are not allowed)" : ""}`);
  if (i.escalation !== undefined && !MODEL_VALUES.includes(i.escalation?.model)) errs.push(`escalation.model ${i.escalation?.model} must be opus, sonnet, haiku or inherit`);
  return errs;
}

module.exports = { ALIASES, MODEL_VALUES, EFFORTS, RISKS, ROLES, TIER, resolveItem, resolveRole, highest, routeLine, checkModels, checkItemRouting, modelFor, effortFor };
