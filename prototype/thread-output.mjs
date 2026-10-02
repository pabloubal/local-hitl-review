#!/usr/bin/env node
// PROTOTYPE (throwaway): what `lhr thread list` / `lhr thread show` could print.
// Fake data, no core. Answers the question on wayfinder ticket #101.
//
//   node prototype/thread-output.mjs                 # all scenarios
//   node prototype/thread-output.mjs list --width 60 # one view, forced width
//   node prototype/thread-output.mjs show orphaned
//   node prototype/thread-output.mjs | cat           # piped: no colour
//   NO_COLOR=1 node ...                              # no colour on a TTY
//   --color forces colour (to preview it through a pipe)

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const pos = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const useColor = flag("color") || (!!process.stdout.isTTY && !process.env.NO_COLOR);
const width = Number(opt("width")) || (process.stdout.isTTY ? process.stdout.columns : Number(process.env.COLUMNS)) || 80;

const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c(2), bold = c(1), red = c(31), yellow = c(33), green = c(32), cyan = c(36), mag = c(35);
const sev = { critical: (s) => bold(red(s)), high: red, medium: yellow, low: dim };
const stateColor = { current: (s) => s, outdated: yellow, orphaned: red };

// ---- fake data (shape follows #100: id, status, severity, whoseTurn, reviewer, location, anchor, messageCount) ----
const threads = [
  { id: "01HXK3M9QZ7A", short: "01HXK3", status: "open", severity: "high", whoseTurn: "agent", reviewer: "pablo", messageCount: 2,
    location: "src/auth/session.ts:42-47", anchor: { path: "src/auth/session.ts", startLine: 42, endLine: 47, saved: 42, state: "current", method: "diff" } },
  { id: "01HXK4B2TR1C", short: "01HXK4", status: "open", severity: "medium", whoseTurn: "human", reviewer: "claude-code", messageCount: 3,
    location: "src/auth/session.ts:88", anchor: { path: "src/auth/session.ts", startLine: 88, endLine: 88, saved: 71, state: "outdated", method: "text-search" } },
  { id: "01HXK5N8WD4E", short: "01HXK5", status: "open", severity: "low", whoseTurn: "agent", reviewer: "pablo", messageCount: 1,
    location: "src/old/legacy.ts:12", anchor: { path: "src/old/legacy.ts", startLine: undefined, endLine: undefined, saved: 12, state: "orphaned", method: "diff" } },
  { id: "01HXK6P1VF9G", short: "01HXK6", status: "open", severity: "critical", whoseTurn: "agent", reviewer: "pablo", messageCount: 1,
    location: "README.md (file)", anchor: { path: "README.md", state: "current", method: "path" } },
  { id: "01HXK7Q4XH2J", short: "01HXK7", status: "resolved", severity: "medium", whoseTurn: "human", reviewer: "pablo", messageCount: 4,
    location: "src/index.ts:5-9 (old)", anchor: { path: "src/index.ts", startLine: 5, endLine: 9, saved: 5, state: "current", method: "pinned" } },
];

const code = {
  current: { first: 40, lines: ["function load(id: string) {", "  const s = store.get(id);", "  if (!s) return null;", "  if (s.expiresAt < Date.now()) {", "    store.delete(id);", "    return s; // expired but returned", "  }", "  return s;", "}"], hi: [42, 47 - 1] },
};
const showCases = {
  current: {
    thread: threads[0],
    snippet: { label: "working tree", first: 40, hi: [42, 47], lines: ["function load(id: string) {", "  const s = store.get(id);", "  if (!s) return null;", "  if (s.expiresAt < Date.now()) {", "    store.delete(id);", "    return s; // expired but returned", "  }", "  return s;", "}", ""] },
    messages: [
      { author: "pablo (human)", at: "2026-09-30 14:02", round: "r1", severity: "high", body: "This returns the session after deleting it. An expired session should come back as null, otherwise callers treat it as live." },
      { author: "claude-code (agent)", at: "2026-09-30 14:19", body: "Agreed. Fixed in 3f2a9c1: expired sessions now return null. I added a test in session.test.ts covering the boundary (expiresAt === now)." },
    ],
  },
  outdated: {
    thread: threads[1],
    note: "anchor moved: saved at line 71, now line 88 (text-search). Lines above were edited since this comment.",
    snippet: { label: "working tree", first: 86, hi: [88, 88], lines: ["export function touch(id: string) {", "  const s = load(id);", "  s!.expiresAt = Date.now() + TTL;", "  return s;", "}"] },
    messages: [
      { author: "claude-code (agent)", at: "2026-10-01 09:12", severity: "medium", body: "Not sure about the non-null assertion here: load() can now return null after the previous fix. Should touch() throw or no-op?" },
      { author: "pablo (human)", at: "2026-10-01 09:40", body: "No-op, but log it." },
      { author: "pablo (human)", at: "2026-10-01 09:41", body: "Also see the thread on line 42." },
    ],
  },
  orphaned: {
    thread: threads[2],
    note: "orphaned: src/old/legacy.ts no longer exists at HEAD. Showing the lines as they were when the comment was made (snapshot at 9ab01de).",
    snippet: { label: "snapshot 9ab01de", first: 10, hi: [12, 12], lines: ["// TODO remove after v2", "const LEGACY = true;", "export const mode = LEGACY ? 'a' : 'b';", ""] },
    messages: [{ author: "pablo (human)", at: "2026-09-28 17:30", severity: "low", body: "Dead flag. Delete?" }],
  },
};

// ---- helpers ----
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, n) => s + " ".repeat(Math.max(0, n - strip(s).length));
const trunc = (s, n) => (strip(s).length > n ? s.slice(0, n - 1) + "…" : s);

function wrap(text, w) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line && (line + " " + word).length > w) { out.push(line); line = word; }
      else line = line ? line + " " + word : word;
    }
    out.push(line);
  }
  return out;
}

const turn = (t) => (t === "agent" ? cyan("agent") : mag("human"));
const marker = (a) => (a.state === "current" ? "" : stateColor[a.state](a.state === "outdated" ? "moved" : "orphaned"));

// ---- thread list ----
function list() {
  const open = threads.filter((t) => t.status === "open");
  const wide = width >= 80;
  console.log(dim(`${open.length} open threads (status: open; --status all to widen)`));
  console.log();
  if (wide) {
    console.log(dim(pad("ID", 8) + pad("SEV", 10) + pad("TURN", 7) + pad("LOCATION", Math.max(20, width - 8 - 10 - 7 - 10 - 5)) + pad("ANCHOR", 10) + "MSGS"));
    const locW = Math.max(20, width - 8 - 10 - 7 - 10 - 5);
    for (const t of open) {
      console.log(pad(bold(t.short), 8) + pad(sev[t.severity](t.severity), 10) + pad(turn(t.whoseTurn), 7) + pad(trunc(t.location, locW - 1), locW) + pad(marker(t.anchor), 10) + t.messageCount);
    }
  } else {
    // narrow: two lines per thread, nothing truncated mid-path
    for (const t of open) {
      console.log(`${bold(t.short)}  ${sev[t.severity](t.severity)}  ${turn(t.whoseTurn)}  ${marker(t.anchor)}`.trimEnd());
      console.log("  " + trunc(t.location, width - 2));
    }
  }
  console.log();
  console.log(dim("lhr thread show <id>   (unique prefix is enough)"));
}

// ---- thread show ----
function show(name) {
  const k = showCases[name];
  const t = k.thread;
  const rule = dim("─".repeat(Math.min(width, 100)));
  console.log(`${bold(t.short)} ${dim(t.id.slice(t.short.length))}  ${t.status === "open" ? green("open") : dim("resolved")}  ${sev[t.severity](t.severity)}  ${dim("turn:")} ${turn(t.whoseTurn)}  ${dim("reviewer:")} ${t.reviewer}`);
  console.log(`${bold(t.location)}`);
  if (k.note) for (const l of wrap(k.note, width - 2)) console.log(stateColor[t.anchor.state](`! ${l}`));
  console.log(rule);
  const s = k.snippet;
  const gw = String(s.first + s.lines.length).length;
  console.log(dim(`  ${s.label}`));
  s.lines.forEach((ln, i) => {
    if (ln === "" && i === s.lines.length - 1) return;
    const n = s.first + i;
    const hit = n >= s.hi[0] && n <= s.hi[1];
    const body = trunc(ln, width - gw - 5);
    console.log((hit ? bold(">") : " ") + " " + dim(String(n).padStart(gw)) + dim(" │ ") + (hit ? bold(body) : dim(body)));
  });
  console.log(rule);
  for (const m of k.messages) {
    const meta = [m.round, m.severity && `severity: ${m.severity}`].filter(Boolean).join(", ");
    console.log(`${bold(m.author)}  ${dim(m.at)}${meta ? "  " + dim(meta) : ""}`);
    for (const l of wrap(m.body, width - 2)) console.log("  " + l);
    console.log();
  }
  console.log(dim(`lhr thread reply ${t.short} -   |   lhr thread resolve ${t.short}`));
}

// ---- run ----
const head = (s) => console.log("\n" + "=".repeat(8) + ` ${s} ` + "=".repeat(8) + "\n");
const mode = pos[0];
if (mode === "list") list();
else if (mode === "show") show(pos[1] ?? "current");
else {
  console.log(dim(`[width=${width} color=${useColor}]`));
  head("lhr thread list"); list();
  for (const n of Object.keys(showCases)) { head(`lhr thread show (${n})`); show(n); }
}
