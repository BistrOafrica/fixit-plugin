/* Guards the plugin's agents, commands and documents. No network, no model.
 * Run: node --test scripts/plugin-text.test.cjs */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { ROLES, ALIASES, MODEL_VALUES, EFFORTS } = require(path.join(ROOT, "skills/remedy/scripts/route.cjs"));

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const mdIn = (d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith(".md")).map((f) => path.join(d, f));

// Frontmatter: simple "key: value" lines between the first two "---" lines.
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9-]*): ?(.*)$/);
    assert.ok(kv, `frontmatter line not "key: value": ${line}`);
    fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: text.slice(m[0].length) };
}

const AGENTS = mdIn("agents");
const COMMANDS = mdIn("commands");
// Documents a person or model reads. security-audit is vendored and not ours to edit.
const DOCS = [
  "README.md",
  ...AGENTS,
  ...COMMANDS,
  ...mdIn("skills/remedy"),
  ...mdIn("skills/remedy/templates"),
  "skills/test-campaign/SKILL.md",
  "skills/test-campaign/FOUNDATIONS.md",
];

test("every agent parses, with a name equal to its file, a short description and no ignored fields", () => {
  assert.ok(AGENTS.length >= 10);
  for (const f of AGENTS) {
    const p = frontmatter(read(f));
    assert.ok(p, `${f}: no frontmatter`);
    assert.strictEqual(p.fm.name, path.basename(f, ".md"), f);
    assert.ok(p.fm.description && p.fm.description.length <= 200, `${f}: description missing or over 200 chars`);
    assert.ok(!/: /.test(p.fm.description) || /^['"]/.test(p.fm.description), `${f}: description has ": " and is not quoted`);
    for (const bad of ["permissionMode", "hooks", "mcpServers", "initialPrompt"]) assert.ok(!(bad in p.fm), `${f}: uses ignored field ${bad}`);
    assert.ok(p.body.trim().length > 100, `${f}: empty body`);
  }
});

test("agent models are aliases, never dated ids; effort and limits are valid", () => {
  for (const f of AGENTS) {
    const { fm } = frontmatter(read(f));
    assert.ok(MODEL_VALUES.includes(fm.model), `${f}: model ${fm.model} is not an alias`);
    assert.ok(!/\d{8}|claude-/.test(fm.model), f);
    if (fm.effort) assert.ok(EFFORTS.includes(fm.effort), `${f}: effort ${fm.effort}`);
    if (fm.maxTurns) assert.ok(/^\d+$/.test(fm.maxTurns), f);
    if (fm.autoCompactWindow) {
      const w = Number(fm.autoCompactWindow);
      assert.ok(w >= 100000 && w <= 1000000, `${f}: autoCompactWindow ${fm.autoCompactWindow} outside 100000..1000000`);
    }
    if (fm.isolation) assert.strictEqual(fm.isolation, "worktree", f);
  }
});

test("commands: frontmatter parses, models are aliases, only forks and long-work commands set one", () => {
  for (const f of COMMANDS) {
    const p = frontmatter(read(f));
    assert.ok(p, `${f}: no frontmatter`);
    assert.ok(p.fm.description, f);
    assert.ok(!/: /.test(p.fm.description) || /^['"]/.test(p.fm.description), `${f}: description has ": " and is not quoted`);
    if (p.fm.model) assert.ok(ALIASES.includes(p.fm.model), `${f}: model ${p.fm.model}`);
    if (p.fm.effort) assert.ok(EFFORTS.includes(p.fm.effort), f);
  }
  // A live coordinator runs these, so they carry no model (switching writes the whole cache again).
  for (const f of ["build", "intake", "plan", "status", "sync", "usage"]) assert.ok(!("model" in frontmatter(read(`commands/${f}.md`)).fm), `${f} must not set model`);
});

test("every agent and role route.cjs can return has an agent file", () => {
  const names = new Set(AGENTS.map((f) => path.basename(f, ".md")));
  for (const [role, [, , agent]] of Object.entries(ROLES)) assert.ok(names.has(agent), `role ${role} returns agent ${agent}, which has no file`);
  // Frontmatter defaults agree with the routing table.
  for (const [role, [, model, agent, turns]] of Object.entries(ROLES)) {
    if (role.includes("-risk") || role.includes("mechanical") || role.includes("escalation") || role === "audit-hunter-deep") continue; // set by the Agent call
    const { fm } = frontmatter(read(`agents/${agent}.md`));
    assert.strictEqual(fm.model, model, `${agent}: frontmatter model ${fm.model}, route says ${model}`);
    if (turns !== "none") assert.strictEqual(Number(fm.maxTurns), turns, `${agent}: maxTurns ${fm.maxTurns}, route says ${turns}`);
  }
});

test("no agent, command or document runs remedy approve, except as a refusal or the coordinator's rule 5", () => {
  const rule5 = "Never approve. Run `remedy approve` only when the owner, in this conversation, names the item and tells you to.";
  for (const f of DOCS) {
    const t = read(f);
    if (f === "agents/remedy-coordinator.md") {
      assert.ok(t.includes(rule5), "coordinator rule 5 wording changed");
      assert.strictEqual(t.split("remedy approve").length - 1, 1, "coordinator names remedy approve more than once");
      continue;
    }
    for (const line of t.split("\n")) {
      if (!/\bapprove\b/.test(line) || !/(remedy(\.cjs)?|fixit) approve/.test(line)) continue;
      // Allowed: telling someone never to run it, or saying the owner runs it.
      assert.ok(/never|not run|owner|OWNER|no agent|approves nothing|refus/i.test(line), `${f}: "${line.trim().slice(0, 120)}" runs or implies remedy approve`);
    }
  }
  for (const f of [...AGENTS, ...COMMANDS].filter((f) => f !== "agents/remedy-coordinator.md" && f !== "agents/remedy-builder.md" && f !== "agents/remedy-reviewer.md")) {
    assert.ok(!/remedy approve/.test(read(f)), `${f}: names remedy approve`);
  }
  assert.ok(/Never run `remedy approve`/.test(read("agents/remedy-builder.md")));
  assert.ok(/never run `remedy approve`/.test(read("agents/remedy-reviewer.md")));
});

test("no shipped document mentions the removed rewrite", () => {
  const all = [...DOCS, "hooks/hooks.json", "skills/remedy/SKILL.md"];
  for (const f of all) {
    const t = read(f);
    for (const bad of ["--cmd", "FIXIT_RAW", "pre-bash", "rewrite.extra"]) assert.ok(!t.includes(bad), `${f} mentions ${bad}`);
  }
});

test("every agent that runs tests or reads logs says to use fixit and add missing lanes to the config", () => {
  const need = ["agents/remedy-builder.md", "agents/remedy-reviewer.md", "agents/remedy-investigator.md", "agents/remedy-tester.md", "agents/campaign-author.md", "skills/remedy/BUILD.md", "skills/remedy/PLANNING.md"];
  for (const f of need) {
    const t = read(f);
    assert.ok(/fixit test/.test(t) && /fixit logs/.test(t), `${f}: must name fixit test and fixit logs`);
    assert.ok(/never raw/.test(t), `${f}: must forbid raw test and log commands`);
    assert.ok(/fixit\.config\.json/.test(t), `${f}: must say missing lanes go in fixit.config.json`);
  }
  for (const f of ["commands/init.md", "README.md"]) assert.ok(read(f).includes("fixit.config.json"), `${f} must explain fixit.config.json`);
});

test("no agent or command carries the audit's sandbox rules away from the audit agents", () => {
  for (const f of ["agents/audit-hunter.md", "agents/audit-verifier.md"]) assert.ok(/sandbox|scratch/i.test(read(f)), f);
});

// Subcommands named in code spans must exist.
function cliCommands() {
  const help = execFileSync("node", [path.join(ROOT, "skills/remedy/scripts/remedy.cjs"), "help"], { encoding: "utf8" });
  const remedy = new Set([...help.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]));
  const fhelp = execFileSync("node", [path.join(ROOT, "scripts/fixit.cjs"), "help"], { encoding: "utf8" });
  const fixit = new Set([...fhelp.matchAll(/^ {2}fixit ([a-z]+)\b/gm)].map((m) => m[1]));
  return { remedy, fixit };
}
function codeSpans(text) {
  const spans = [];
  text.replace(/```[\s\S]*?```/g, (b) => (spans.push(b), ""));
  for (const m of text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)) spans.push(m[1]);
  return spans;
}

test("every remedy and fixit subcommand a document names exists", () => {
  const { remedy, fixit } = cliCommands();
  remedy.add("help"); assert.ok(remedy.has("brief") && remedy.has("usage") && remedy.has("run") && remedy.has("handoff") && fixit.has("test") && fixit.has("logs"));
  const missing = [];
  for (const f of DOCS) {
    for (const span of codeSpans(read(f))) {
      for (const m of span.matchAll(/(?:^|[\s(|])(remedy|fixit)(?:\.cjs)? ([a-z][a-z-]*)\b/g)) {
        const [, cli, sub] = m;
        if (!(cli === "remedy" ? remedy : fixit).has(sub)) missing.push(`${f}: ${cli} ${sub}`);
      }
      for (const m of span.matchAll(/remedy\.cjs ([a-z][a-z-]*)\b/g)) {
        if (!remedy.has(m[1])) missing.push(`${f}: remedy.cjs ${m[1]}`);
      }
    }
  }
  assert.deepStrictEqual(missing, []);
});

test("README lists every command file and every agent", () => {
  const readme = read("README.md");
  for (const f of COMMANDS) assert.ok(readme.includes(`/fixit-plugin:${path.basename(f, ".md")}`), `README lacks ${f}`);
  for (const f of AGENTS) assert.ok(readme.includes(path.basename(f, ".md")), `README lacks agent ${f}`);
});

test("a command's allowed-tools is the one exact remedy line it runs, so it can never cover remedy approve", () => {
  let seen = 0;
  for (const f of mdIn("commands")) {
    const text = read(f), m = text.match(/^allowed-tools:\s*(.*)$/m);
    if (!m) continue;
    seen++;
    assert.doesNotMatch(m[1], /\*|approve/, f);
    const inner = /^Bash\((node \$\{CLAUDE_PLUGIN_ROOT\}\/skills\/remedy\/scripts\/remedy\.cjs [^)]+)\)$/.exec(m[1]);
    assert.ok(inner, `${f}: allowed-tools must name one exact remedy command, not ${m[1]}`);
    assert.ok(text.includes("!`" + inner[1] + "`"), `${f}: allowed-tools must match the command's ! line`);
  }
  assert.ok(seen >= 3, "status, sync and usage each allow their own line");
});

test("the agents that change files have the tools to do it", () => {
  for (const f of ["agents/remedy-builder.md", "agents/campaign-author.md"]) {
    const line = /^tools:\s*(.*)$/m.exec(read(f).split("---")[1]);
    assert.ok(line, `${f} needs a tools list`);
    for (const t of ["Read", "Grep", "Glob", "Bash", "Edit", "Write"]) assert.ok(line[1].split(/,\s*/).includes(t), `${f} lacks ${t}`);
  }
});
