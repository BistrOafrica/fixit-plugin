/* fixit logs adapters: turn a source name into a command, and read lines.
 * Zero dependencies, Node >= 18.
 *
 *   docker:NAME  compose:SERVICE[@file]  journald:UNIT  kubectl:[NS/]POD  file:PATH
 *
 * A source never goes through a shell: fetch() returns an argv, which the
 * caller spawns directly, so a source string cannot inject a command. Names
 * must look like names (and may not start with "-").
 *
 * Every adapter asks its tool for timestamps, and the caller also filters
 * client-side on [start, end): half-open, so a baseline window that ends at T
 * and a window that starts at T never share a line.
 */
"use strict";
const fs = require("fs");

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const strip = (s) => String(s == null ? "" : s).replace(ANSI, "");

// ---------- times ----------
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
// "15m", "2h", "1d", or an ISO time. Returns epoch ms, or null.
function parseTime(t, now = Date.now()) {
  const s = String(t == null ? "" : t).trim();
  let m = /^(\d+)([smhdw])$/.exec(s);
  if (m) return now - Number(m[1]) * UNIT_MS[m[2]];
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00Z" : /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s.replace(" ", "T") : s.replace(" ", "T") + "Z");
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
const ISO_IN_LINE = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/;
// First ISO-style timestamp in a line, as epoch ms (a missing zone means UTC), or null.
function lineTime(line) {
  const m = ISO_IN_LINE.exec(line.length > 400 ? line.slice(0, 400) : line);
  if (!m) return null;
  let z = m[4] || "Z";
  if (/^[+-]\d{4}$/.test(z)) z = z.slice(0, 3) + ":" + z.slice(3);
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3] || ""}${z}`);
  return Number.isNaN(ms) ? null : ms;
}
const isoMs = (ms) => new Date(ms).toISOString();
const utcDateTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]*$/;
function name(kind, v) {
  if (!v || !NAME.test(v)) throw new Error(`${kind}: "${v || ""}" is not a plain name (letters, digits, . _ : @ / -, not starting with "-")`);
  return v;
}

// A source is "kind:rest". fetch({rest, start, end}) -> { argv } or { file }.
const ADAPTERS = {
  docker: {
    label: (rest) => `docker:${rest}`,
    fetch({ rest, start, end }) {
      const a = ["docker", "logs", "--timestamps"];
      if (start != null) a.push("--since", isoMs(start));
      if (end != null) a.push("--until", isoMs(end));
      return { argv: [...a, name("docker", rest)] };
    },
  },
  compose: {
    label: (rest) => `compose:${rest}`,
    fetch({ rest, start, end }) {
      const at = rest.indexOf("@"), service = at < 0 ? rest : rest.slice(0, at), file = at < 0 ? "" : rest.slice(at + 1);
      const a = ["docker", "compose"];
      if (file) a.push("-f", name("compose file", file));
      a.push("logs", "--no-color", "--timestamps");
      if (start != null) a.push("--since", isoMs(start));
      if (end != null) a.push("--until", isoMs(end));
      return { argv: [...a, name("compose", service)] };
    },
  },
  journald: {
    label: (rest) => `journald:${rest}`,
    fetch({ rest, start, end }) {
      const a = ["journalctl", "--no-pager", "--utc", "-o", "short-iso", "-u", name("journald", rest)];
      if (start != null) a.push("--since", utcDateTime(start));
      if (end != null) a.push("--until", utcDateTime(end));
      return { argv: a };
    },
  },
  kubectl: {
    label: (rest) => `kubectl:${rest}`,
    fetch({ rest, start }) { // kubectl has --since-time and no --until: the end is cut client-side
      const slash = rest.indexOf("/"), ns = slash < 0 ? "" : rest.slice(0, slash), pod = slash < 0 ? rest : rest.slice(slash + 1);
      const a = ["kubectl", "logs", "--timestamps"];
      if (ns) a.push("-n", name("kubectl namespace", ns));
      if (start != null) a.push(`--since-time=${isoMs(start)}`);
      return { argv: [...a, name("kubectl", pod)] };
    },
  },
  file: {
    label: (rest) => `file:${rest}`,
    fetch({ rest }) { if (!rest) throw new Error("file: needs a path"); return { file: rest }; },
  },
};

// "docker:api" -> { kind, rest }. A name in config `logs` is resolved by the caller first.
function parseSource(s) {
  const m = /^([a-z]+):(.*)$/s.exec(String(s || ""));
  if (!m || !ADAPTERS[m[1]]) throw new Error(`Unknown log source "${s}". Use docker:NAME, compose:SERVICE[@file], journald:UNIT, kubectl:[NS/]POD, file:PATH, or a name from "logs" in fixit.config.json.`);
  return { kind: m[1], rest: m[2] };
}

// Keep the lines of text that fall in [start, end). A line with no timestamp (a stack frame, a wrapped
// line) goes with the line before it. Before any timestamp, lines are kept only when no window was asked for.
function filterWindow(text, start, end) {
  if (start == null && end == null) return text;
  const out = [];
  let keep = false, seen = false;
  for (const line of text.split("\n")) {
    const t = lineTime(line);
    if (t != null) { seen = true; keep = (start == null || t >= start) && (end == null || t < end); }
    else if (!seen) keep = false;
    if (keep) out.push(line);
  }
  return out.length ? out.join("\n") + "\n" : "";
}

// ---------- reading entries ----------
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function levelOf(line, json) {
  const norm = (v) => {
    const s = String(v).toLowerCase();
    if (/^(fatal|panic|crit|critical|alert|emerg|emergency|error|err|severe)$/.test(s)) return "error";
    if (/^(warn|warning)$/.test(s)) return "warn";
    if (/^(debug|trace|verbose)$/.test(s)) return "debug";
    if (/^(info|notice|information)$/.test(s)) return "info";
    return null;
  };
  if (json) for (const k of ["level", "lvl", "severity", "levelname", "log_level"]) if (json[k] != null) { const l = norm(json[k]); if (l) return l; }
  let m = /\blevel["']?\s*[=:]\s*["']?([A-Za-z]+)/.exec(line);
  if (m && norm(m[1])) return norm(m[1]);
  m = /(?:^|[\s\[|<(])(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|WARN|WARNING|INFO|NOTICE|DEBUG|TRACE)(?=$|[\s\]|>):])/.exec(line);
  if (m) return norm(m[1]);
  if (/\b(error|fatal|panic|exception|traceback|failed|refused)\b/i.test(line)) return "error";
  if (/\bwarn(ing)?\b/i.test(line)) return "warn";
  return "info";
}

// Placeholders for the parts of a message that change between lines of the same kind.
function normalise(line, json) {
  let s = strip(json && (json.msg || json.message) ? String(json.msg || json.message) : line);
  return s
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/g, "<ts>")
    .replace(/\b\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}( [+-]\d{4})?/g, "<ts>")
    .replace(/\b\d{2}:\d{2}:\d{2}(\.\d+)?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ").trim();
}

const CONTINUATION = /^(\s+\S|\s*at\s|Caused by:|Traceback |\.\.\. \d+ more)/;
// Split text into entries { line (1-based, in text), level, key, t, raw }. Indented lines and
// stack frames belong to the entry before them, so a trace is one template and not forty.
function readEntries(text) {
  const entries = [];
  const all = text.split("\n");
  if (all.length && all[all.length - 1] === "") all.pop();
  for (let i = 0; i < all.length; i++) {
    const raw = all[i];
    if (!raw.trim()) continue;
    const prev = entries[entries.length - 1];
    // A line that opens with a timestamp is always a new entry, whatever it looks like after it.
    if (prev && lineTime(raw) == null && CONTINUATION.test(raw)) { prev.more++; continue; }
    let json = null;
    const tr = raw.trim();
    if (tr[0] === "{" && tr[tr.length - 1] === "}") { try { const j = JSON.parse(tr); if (j && typeof j === "object") json = j; } catch { /* plain text */ } }
    const body = json ? raw : strip(raw);
    const t = json && json.time ? (Date.parse(json.time) || lineTime(raw)) : json && json.timestamp ? (Date.parse(json.timestamp) || lineTime(raw)) : lineTime(raw);
    entries.push({ line: i + 1, level: levelOf(body, json), key: normalise(raw, json), t: Number.isNaN(t) ? null : t, raw: strip(raw), more: 0 });
  }
  return entries;
}

module.exports = { ADAPTERS, parseSource, parseTime, lineTime, filterWindow, readEntries, normalise, levelOf, LEVELS, strip, isoMs };
