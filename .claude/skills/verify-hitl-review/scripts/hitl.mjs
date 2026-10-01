#!/usr/bin/env node
// Verification harness for the Local HITL Review extension.
// Launches a disposable VS Code (isolated profile, scratch git fixture, the
// extension loaded via --extensionDevelopmentPath) and drives its renderer over
// the Chrome DevTools Protocol. Zero dependencies: Node 22 global WebSocket.
//
// State lives in $HITL_RUN (default: $TMPDIR/verify-hitl-review/current):
//   $HITL_RUN/state.json   pid, CDP port, paths
//   $HITL_RUN/instance/    profile, extensions dir, fixture repo (removed by `stop`)
//   $HITL_RUN/evidence/    proof artifacts (kept by `stop`)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
// npm-workspaces layout: the extension package lives in packages/vscode, while
// node_modules and .vscode-test stay hoisted at the repo root.
const EXT = path.join(REPO, "packages/vscode");
const BUNDLE = path.join(EXT, "out/extension.js");
const RUN = process.env.HITL_RUN || path.join(os.tmpdir(), "verify-hitl-review", "current");
const STATE = path.join(RUN, "state.json");
const EVIDENCE = path.join(RUN, "evidence");
const EXT_ID = "pablo.local-hitl-review";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => { console.error(`hitl: ${msg}`); process.exit(1); };
const readState = () => {
  if (!fs.existsSync(STATE)) die(`no instance at ${RUN} (run: hitl.mjs launch)`);
  return JSON.parse(fs.readFileSync(STATE, "utf8"));
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function codeBinary() {
  if (process.env.HITL_CODE) return process.env.HITL_CODE;
  const { downloadAndUnzipVSCode } = await import(
    path.join(REPO, "node_modules/@vscode/test-electron/out/index.js")
  );
  return downloadAndUnzipVSCode({ version: "stable", cachePath: path.join(REPO, ".vscode-test") });
}

// Fixture: `main` has src/app.ts and README.md; `feature/review-me` edits app.ts
// and adds src/new.ts. The extension auto-detects `main` as the base branch.
function makeFixture(dir) {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "verify@example.invalid");
  git(dir, "config", "user.name", "verify");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(dir, "src/app.ts"),
    "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-qb", "feature/review-me");
  fs.writeFileSync(path.join(dir, "src/app.ts"),
    "export function add(a: number, b: number) {\n  // TODO validate input\n  return a + b + 0;\n}\n");
  fs.writeFileSync(path.join(dir, "src/new.ts"), "export const answer = 42;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "feature work");
}

async function cdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function connect() {
  const st = readState();
  if (!alive(st.pid)) die(`instance pid ${st.pid} is not running`);
  const page = (await cdpTargets(st.port)).find(
    (t) => t.type === "page" && t.url.includes("workbench"),
  );
  if (!page) die("no workbench page on the CDP port");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
    return r.result.value;
  };
  return { st, send, evaluate, close: () => ws.close() };
}

// Key combos like "F1", "Escape", "cmd+enter", "alt+c", "ctrl+shift+p".
const KEYS = {
  enter: ["Enter", "Enter", 13, "\r"], escape: ["Escape", "Escape", 27], tab: ["Tab", "Tab", 9],
  backspace: ["Backspace", "Backspace", 8], up: ["ArrowUp", "ArrowUp", 38],
  down: ["ArrowDown", "ArrowDown", 40], left: ["ArrowLeft", "ArrowLeft", 37],
  right: ["ArrowRight", "ArrowRight", 39], home: ["Home", "Home", 36], end: ["End", "End", 35],
  f1: ["F1", "F1", 112], space: [" ", "Space", 32, " "],
};
async function pressKey(send, combo) {
  const parts = combo.toLowerCase().split("+");
  const name = parts.pop();
  const mods = { alt: 1, ctrl: 2, cmd: 4, meta: 4, shift: 8 };
  const modifiers = parts.reduce((m, p) => m | (mods[p] ?? die(`unknown modifier ${p}`)), 0);
  let [key, code, keyCode, text] = KEYS[name] || [];
  if (!key) {
    if (!/^[a-z0-9]$/.test(name)) die(`unknown key ${name}`);
    key = name; keyCode = name.toUpperCase().charCodeAt(0);
    code = /\d/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`;
    text = modifiers & ~8 ? undefined : name;
  }
  if (modifiers & ~8) text = undefined;
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", text, ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function clickAt(send, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

// Locate a visible element by CSS selector, optionally narrowed by text it contains.
async function locate(evaluate, selector, text) {
  return evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 &&
        (${JSON.stringify(text ?? null)} === null || ((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')).replace(/\u00a0/g, ' ').includes(${JSON.stringify(text ?? "")}));
    });
    if (!els.length) return null;
    const r = els[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: els[0].getAttribute('aria-label') || els[0].innerText.slice(0, 80) };
  })()`);
}

// Like locate, but polls for up to 5s: views and diff editors render a beat
// after the click or command that opened them.
async function find(evaluate, selector, text) {
  for (let i = 0; i < 20; i++) {
    const hit = await locate(evaluate, selector, text);
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

const commands = {
  async launch() {
    if (fs.existsSync(STATE) && alive(readState().pid)) die(`instance already running at ${RUN}; run stop first`);
    // Fail fast if the extension package moved (it did once: root → packages/vscode).
    const manifest = path.join(EXT, "package.json");
    const pkg = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : {};
    if (`${pkg.publisher}.${pkg.name}` !== EXT_ID) die(`${manifest} is not ${EXT_ID}; update EXT in hitl.mjs`);
    const inst = path.join(RUN, "instance");
    fs.rmSync(inst, { recursive: true, force: true });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const workspace = path.join(inst, "fixture");
    makeFixture(workspace);
    console.log("building extension (npm run build -w local-hitl-review)...");
    execFileSync("npm", ["run", "build", "--silent", "-w", "local-hitl-review"], { cwd: REPO, stdio: "inherit" });
    const code = await codeBinary();
    const port = await freePort();
    // VS Code's IPC socket lives in the profile dir and macOS caps socket paths
    // at 103 chars, so the profile gets a short temp dir of its own.
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "hitl-"));
    fs.mkdirSync(path.join(userData, "User"), { recursive: true });
    fs.writeFileSync(path.join(userData, "User/settings.json"), JSON.stringify({
      "security.workspace.trust.enabled": false,
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "update.mode": "none",
      "telemetry.telemetryLevel": "off",
      "git.openRepositoryInParentFolders": "never",
      "window.restoreWindows": "none",
      "chat.disableAIFeatures": true,
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      // macOS defaults to native context menus and modal dialogs, which CDP
      // cannot see or click.
      "window.menuStyle": "custom",
      "window.dialogStyle": "custom",
    }, null, 2));
    const log = fs.openSync(path.join(inst, "code.log"), "w");
    const child = spawn(code, [
      workspace,
      `--extensionDevelopmentPath=${EXT}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(inst, "extensions")}`,
      `--remote-debugging-port=${port}`,
      "--disable-extensions", "--new-window", "--skip-welcome", "--skip-release-notes",
      "--disable-workspace-trust", "--disable-telemetry",
    ], { detached: true, stdio: ["ignore", log, log] });
    child.unref();
    fs.writeFileSync(STATE, JSON.stringify({ pid: child.pid, port, workspace, userData, code, startedAt: new Date().toISOString() }, null, 2));
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (!alive(child.pid)) die(`VS Code exited early; see ${path.join(inst, "code.log")}`);
      try {
        const page = (await cdpTargets(port)).find((t) => t.type === "page" && t.url.includes("workbench"));
        if (page) break;
      } catch { /* port not up yet */ }
    }
    // The extension activates on `onView:vscodeComment.changedFiles`, so open
    // Source Control the way a user would, then wait for activation.
    const c = await connect();
    for (let i = 0; i < 30 && !(await c.evaluate("!!document.querySelector('.monaco-workbench .part.sidebar')")); i++) await sleep(500);
    await pressKey(c.send, "ctrl+shift+g");
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const hit = await locate(c.evaluate, ".pane-header", "Local HITL Review");
      if (hit) {
        const expanded = await c.evaluate(`[...document.querySelectorAll('.pane-header')].some((h) =>
          (h.getAttribute('aria-label') || '').startsWith('Local HITL Review') && h.getAttribute('aria-expanded') === 'true')`);
        if (!expanded) await clickAt(c.send, hit.x, hit.y);
        break;
      }
    }
    c.close();
    for (let i = 0; i < 30; i++) {
      if (activationLogged(userData)) {
        console.log(JSON.stringify({ ready: true, run: RUN, pid: child.pid, port, workspace, evidence: EVIDENCE }));
        return;
      }
      await sleep(1000);
    }
    die("timed out waiting for extension activation (run doctor, then logs)");
  },

  async doctor() {
    const st = readState();
    const checks = {
      pidAlive: alive(st.pid),
      cdp: false,
      workbenchPage: false,
      windowTitle: null,
      extensionActivated: activationLogged(st.userData),
      buildFresh: fs.existsSync(BUNDLE) && fs.statSync(BUNDLE).mtimeMs <= Date.parse(st.startedAt),
      fixtureBranch: null,
    };
    try {
      const targets = await cdpTargets(st.port);
      checks.cdp = true;
      const page = targets.find((t) => t.type === "page" && t.url.includes("workbench"));
      checks.workbenchPage = !!page;
      checks.windowTitle = page?.title ?? null;
    } catch { /* leave false */ }
    try { checks.fixtureBranch = git(st.workspace, "branch", "--show-current"); } catch { /* missing */ }
    const ok = checks.pidAlive && checks.cdp && checks.workbenchPage && checks.extensionActivated &&
      checks.fixtureBranch === "feature/review-me";
    console.log(JSON.stringify({ ok, run: RUN, port: st.port, pid: st.pid, ...checks }, null, 2));
    if (!checks.buildFresh) console.log("note: packages/vscode/out/extension.js is missing or was rebuilt after launch; restart to load it");
    process.exit(ok ? 0 : 1);
  },

  async key(...combos) {
    const c = await connect();
    for (const combo of combos) { await pressKey(c.send, combo); await sleep(150); }
    c.close();
  },

  async type(text) {
    const c = await connect();
    await c.send("Input.insertText", { text });
    // Comment widgets sync their input to the extension host asynchronously; a
    // submit key sent right after typing can find the reply still empty.
    await sleep(500);
    c.close();
  },

  // Run a command the way a user does: F1, type its palette title, pick the
  // row whose label starts with that title (case-insensitive), Enter.
  async palette(title) {
    const c = await connect();
    // Context-dependent commands (e.g. adding a comment in a just-opened diff)
    // appear a beat late, so retry a few times before giving up.
    let rows = [];
    let idx = -1;
    for (let attempt = 0; attempt < 4 && idx < 0; attempt++) {
      if (attempt) { await pressKey(c.send, "escape"); await sleep(1000); }
      await pressKey(c.send, "f1");
      await sleep(400);
      await c.send("Input.insertText", { text: title });
      await sleep(700);
      rows = await c.evaluate(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')]
        .map((r) => r.getAttribute('aria-label') || '')`);
      idx = rows.findIndex((l) => l.toLowerCase().startsWith(title.toLowerCase()));
    }
    if (idx < 0) {
      await pressKey(c.send, "escape");
      c.close();
      die(`palette has no command starting with "${title}" (rows: ${rows.slice(0, 5).join(" | ")})`);
    }
    for (let i = 0; i < idx; i++) await pressKey(c.send, "down");
    await pressKey(c.send, "enter");
    console.log(`ran: ${rows[idx]}`);
    c.close();
  },

  async click(selector, text) {
    const c = await connect();
    const hit = await find(c.evaluate, selector, text);
    if (!hit) { c.close(); die(`no visible element for ${selector}${text ? ` containing "${text}"` : ""}`); }
    await clickAt(c.send, hit.x, hit.y);
    console.log(`clicked: ${hit.label}`);
    c.close();
  },

  async dblclick(selector, text) {
    const c = await connect();
    const hit = await find(c.evaluate, selector, text);
    if (!hit) { c.close(); die(`no visible element for ${selector}${text ? ` containing "${text}"` : ""}`); }
    for (const type of ["mousePressed", "mouseReleased"]) {
      for (const clickCount of [1, 2]) {
        await c.send("Input.dispatchMouseEvent", { type, x: hit.x, y: hit.y, button: "left", clickCount });
      }
    }
    console.log(`double-clicked: ${hit.label}`);
    c.close();
  },

  // Print innerText (or aria-labels with --aria) of every visible match.
  async text(selector, flag) {
    const c = await connect();
    const out = await c.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => ${flag === "--aria" ? "e.getAttribute('aria-label')" : "e.innerText"})`);
    console.log(out.join("\n"));
    c.close();
  },

  async eval(expression) {
    const c = await connect();
    console.log(JSON.stringify(await c.evaluate(expression), null, 2));
    c.close();
  },

  async screenshot(name) {
    if (!name) die("usage: screenshot <name>");
    const c = await connect();
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    const file = path.isAbsolute(name) ? name : path.join(EVIDENCE, name.endsWith(".png") ? name : `${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(file);
    c.close();
  },

  // Copy the fixture's .feedback directory (the extension's persisted state) into evidence.
  async feedback(name = "feedback") {
    const st = readState();
    const src = path.join(st.workspace, ".feedback");
    const dest = path.join(EVIDENCE, name);
    if (!fs.existsSync(src)) die(`${src} does not exist`);
    fs.cpSync(src, dest, { recursive: true });
    for (const f of fs.readdirSync(dest).filter((f) => f.endsWith(".review"))) {
      console.log(`== ${f}\n${fs.readFileSync(path.join(dest, f), "utf8")}`);
    }
    console.log(dest);
  },

  async logs() {
    const st = readState();
    for (const f of findLogs(st.userData, /Local HITL Review|exthost\.log$/)) {
      console.log(`== ${f}\n${fs.readFileSync(f, "utf8").split("\n").slice(-40).join("\n")}`);
    }
  },

  async stop() {
    if (fs.existsSync(STATE)) {
      const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
      await quit(st);
      // Keep the extension logs with the proof before the profile goes away.
      const logDir = path.join(EVIDENCE, "logs");
      for (const f of findLogs(st.userData, /Local HITL Review|exthost\.log$/)) {
        fs.mkdirSync(logDir, { recursive: true });
        fs.copyFileSync(f, path.join(logDir, path.basename(f)));
      }
      fs.rmSync(st.userData, { recursive: true, force: true });
      fs.rmSync(STATE);
    }
    fs.rmSync(path.join(RUN, "instance"), { recursive: true, force: true });
    console.log(`stopped; evidence kept at ${EVIDENCE}`);
  },
};

// Quit the instance we started. Signalling the whole process group kills the
// renderer before the main process, and VS Code then shows a "terminated
// unexpectedly" dialog that keeps it alive. So ask it to quit over CDP first,
// fall back to SIGTERM on the main pid alone, and only then SIGKILL the group.
async function quit(st) {
  const groupAlive = () => alive(st.pid) || alive(-st.pid);
  const waitGone = async (ms) => {
    for (let t = 0; t < ms && groupAlive(); t += 250) await sleep(250);
    return !groupAlive();
  };
  if (!groupAlive()) return;
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${st.port}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    if (await waitGone(10000)) return;
  } catch { /* CDP gone; fall through */ }
  try { process.kill(st.pid, "SIGTERM"); } catch { /* gone */ }
  if (await waitGone(5000)) return;
  console.error("hitl: graceful quit failed; force-killing the instance's process group");
  try { process.kill(st.pid, "SIGKILL"); } catch { /* gone */ }
  try { process.kill(-st.pid, "SIGKILL"); } catch { /* gone */ }
  await waitGone(3000);
}

function findLogs(userData, pattern) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (pattern.test(e.name)) out.push(p);
    }
  };
  walk(path.join(userData, "logs"));
  return out;
}

function activationLogged(userData) {
  return findLogs(userData, /exthost\.log$/).some((f) =>
    fs.readFileSync(f, "utf8").includes(`ExtensionService#_doActivateExtension ${EXT_ID}`));
}

const [cmd, ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log(`usage: hitl.mjs <${Object.keys(commands).join("|")}> [args]`);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd](...args);
