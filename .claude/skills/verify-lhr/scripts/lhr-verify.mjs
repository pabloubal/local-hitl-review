#!/usr/bin/env node
// Verification harness for the `lhr` CLI and `lhr mcp` (no dependencies, Node >= 20.11).
// Every drive happens in its own throwaway git repo ("session") under $LHR_RUN/sessions,
// with a hermetic environment, and leaves its proof under $LHR_RUN/evidence.
// Usage: lhr-verify.mjs <build|new|path|doctor|run|mcp|tree|stop> [...]  (see SKILL.md)
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const ROOT = realpathSync(join(import.meta.dirname, "..", "..", "..", ".."));
const BIN = join(ROOT, "packages/cli/dist/lhr.mjs");
const RUN =
  process.env.LHR_RUN ||
  join(realpathSync(process.env.TMPDIR || tmpdir()), "verify-lhr", "current");
const EVIDENCE = join(RUN, "evidence");
const STATE = join(RUN, "state.json");
const GITCONFIG = join(RUN, "gitconfig");

const die = (msg, code = 1) => {
  process.stderr.write(`lhr-verify: ${msg}\n`);
  process.exit(code);
};
const readState = () =>
  existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, "utf8"))
    : { sessions: {}, mcpPids: [] };
const writeState = (s) => {
  mkdirSync(RUN, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
};
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", ...opts });

/** Pull `--flag value` / `--flag` out of argv; returns [opts, rest]. */
function parse(argv, valued, boolean = []) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    const name = a.startsWith("--") ? a.slice(2) : undefined;
    if (name && valued.includes(name)) opts[name] = argv[++i];
    else if (name && boolean.includes(name)) opts[name] = true;
    else rest.push(a);
  }
  return [opts, rest];
}

function session(name) {
  const st = readState();
  const n = name || st.current;
  const s = n && st.sessions[n];
  if (!s) die(`no session${n ? ` "${n}"` : ""}; run: lhr-verify.mjs new`);
  if (!existsSync(s.repo))
    die(`session "${n}" repo is gone (${s.repo}); run: lhr-verify.mjs new`);
  return { name: n, ...s };
}

/** Hermetic env: fixed git identity (the human's name), no colour, no inherited lhr/agent identity. */
function env(agent) {
  const e = { ...process.env };
  for (const k of Object.keys(e))
    if (
      k.startsWith("LHR_") ||
      k === "FORCE_COLOR" ||
      k === "CLAUDE_CODE_SESSION_ID"
    )
      delete e[k];
  if (!existsSync(GITCONFIG)) {
    mkdirSync(RUN, { recursive: true });
    writeFileSync(
      GITCONFIG,
      "[user]\n\tname = Test Human\n\temail = human@example.invalid\n[init]\n\tdefaultBranch = main\n",
    );
  }
  Object.assign(e, {
    GIT_CONFIG_GLOBAL: GITCONFIG,
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
  });
  if (agent) {
    e.LHR_SESSION_ID = agent.session;
    e.LHR_AGENT_NAME = agent.name;
  }
  return e;
}

const agentOpts = (o) =>
  o.agent
    ? {
        session: o["agent-session"] || "verify-agent-session",
        name: o["agent-name"] || "verify-agent",
      }
    : undefined;

// Keep `/` so evidence lands in per-feature folders; drop anything that could escape the evidence dir.
const slug = (s) =>
  s
    .split("/")
    .map((p) => p.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "_"))
    .filter(Boolean)
    .join("/");
function save(name, text) {
  const file = join(EVIDENCE, `${slug(name)}.txt`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function version() {
  return JSON.parse(
    readFileSync(join(ROOT, "packages/cli/package.json"), "utf8"),
  ).version;
}

function newestSrc(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestSrc(p));
    else newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

const commands = {
  build() {
    const r = sh("npm", ["run", "build", "-w", "@pablou/lhr"], { cwd: ROOT });
    if (r.status !== 0) die(`build failed:\n${r.stdout}${r.stderr}`);
    console.log(
      JSON.stringify({
        built: true,
        bin: BIN,
        version: sh("node", [BIN, "--version"]).stdout.trim(),
      }),
    );
  },

  /** new [name]: a fixture repo = base commit on main + an uncommitted edit to src/app.ts. */
  new(argv) {
    const [, [name]] = parse(argv, []);
    const st = readState();
    const n = name || `s${Object.keys(st.sessions).length + 1}`;
    if (st.sessions[n])
      die(`session "${n}" already exists; run stop or pick another name`);
    const repo = join(RUN, "sessions", n);
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = (...a) => {
      const r = sh("git", a, { cwd: repo, env: env() });
      if (r.status !== 0) die(`git ${a.join(" ")} failed: ${r.stderr}`);
    };
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    writeFileSync(
      join(repo, "src/app.ts"),
      "export const a = 1;\nexport function add(a, b) {\n  return a + b;\n}\n",
    );
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(
      join(repo, "src/app.ts"),
      "export const a = 1;\n// TODO validate input\nexport function add(a, b) {\n  return a + b;\n}\n",
    );
    writeFileSync(join(repo, "src/new.ts"), "export const b = 2;\n");
    st.sessions[n] = {
      repo: realpathSync(repo),
      created: new Date().toISOString(),
    };
    st.current = n;
    writeState(st);
    console.log(JSON.stringify({ session: n, repo: st.sessions[n].repo }));
  },

  path(argv) {
    const [o] = parse(argv, ["session"]);
    console.log(session(o.session).repo);
  },

  /** doctor: read-only; exit 0 only when the binary and session are worth driving. */
  doctor(argv) {
    const [o] = parse(argv, ["session"]);
    const checks = {};
    checks.node = {
      ok: Number(process.versions.node.split(".")[0]) >= 20,
      value: process.version,
    };
    checks.binExists = { ok: existsSync(BIN), value: BIN };
    if (checks.binExists.ok) {
      const built = sh("node", [BIN, "--version"], {
        env: env(),
      }).stdout.trim();
      checks.version = {
        ok: built === version(),
        value: `${built} (package.json ${version()})`,
      };
      checks.buildFresh = {
        ok:
          statSync(BIN).mtimeMs >=
          Math.max(
            newestSrc(join(ROOT, "packages/cli/src")),
            newestSrc(join(ROOT, "packages/core/src")),
          ),
        value: "dist newer than packages/cli/src and packages/core/src",
      };
    }
    const st = readState();
    const n = o.session || st.current;
    if (n && st.sessions[n]) {
      const s = st.sessions[n];
      checks.session = { ok: existsSync(s.repo), value: `${n} -> ${s.repo}` };
      if (checks.session.ok) {
        const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: s.repo,
          env: env(),
        });
        checks.fixtureBranch = {
          ok: branch.stdout.trim() === "main",
          value: branch.stdout.trim(),
        };
        if (existsSync(join(s.repo, ".lhr"))) {
          const c = sh("node", [BIN, "check"], { cwd: s.repo, env: env() });
          checks.check = {
            ok: c.status === 0,
            value: (c.stdout + c.stderr).trim().split("\n").pop(),
          };
        }
      }
    } else {
      checks.session = { ok: true, value: "none yet (run: new)" };
    }
    const live = (st.mcpPids || []).filter((p) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    });
    checks.noStrayMcp = {
      ok: live.length === 0,
      value: live.length ? `live pids ${live}` : "none",
    };
    const ok = Object.values(checks).every((c) => c.ok);
    console.log(JSON.stringify({ ok, evidenceDir: EVIDENCE, checks }, null, 2));
    process.exit(ok ? 0 : 1);
  },

  /** run [--agent] [--expect N] [--stdin TEXT] [--ev NAME] [--session S] -- <lhr args>: one CLI call, assert its exit code. */
  run(argv) {
    const [o, args] = parse(
      argv,
      ["expect", "stdin", "ev", "session", "agent-name", "agent-session"],
      ["agent"],
    );
    if (!args.length) die("usage: run [opts] -- <lhr args>");
    const s = session(o.session);
    const agent = agentOpts(o);
    const expect = Number(o.expect ?? 0);
    const t0 = Date.now();
    const r = sh("node", [BIN, ...args], {
      cwd: s.repo,
      env: env(agent),
      input: o.stdin,
    });
    const exit = r.status ?? -1;
    const ok = exit === expect;
    const text =
      `$ lhr ${args.join(" ")}\n` +
      `mode: ${agent ? `agent (${agent.name}, session ${agent.session})` : "human"}   cwd: ${s.repo}   ms: ${Date.now() - t0}\n` +
      (o.stdin !== undefined ? `stdin: ${JSON.stringify(o.stdin)}\n` : "") +
      `--- stdout\n${r.stdout}--- stderr\n${r.stderr}--- exit ${exit} (expected ${expect}) ${ok ? "OK" : "UNEXPECTED"}\n`;
    mkdirSync(EVIDENCE, { recursive: true });
    appendFileSync(join(EVIDENCE, "transcript.log"), `${text}\n`);
    if (o.ev) save(o.ev, text);
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.stdout.write(`[exit ${exit}${ok ? "" : `, expected ${expect}`}]\n`);
    process.exit(ok ? 0 : 1);
  },

  /** mcp [--agent-name N] [--agent-session ID] [--no-session] [--ev NAME] [--session S] <script.json|->: one server, many steps. */
  async mcp(argv) {
    const [o, [file]] = parse(
      argv,
      ["ev", "session", "agent-name", "agent-session"],
      ["no-session"],
    );
    if (!file) die("usage: mcp [opts] <script.json|->");
    const steps = JSON.parse(
      file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8"),
    );
    const s = session(o.session);
    const e = env();
    if (o["agent-name"]) e.LHR_AGENT_NAME = o["agent-name"];
    if (!o["no-session"])
      e.LHR_SESSION_ID = o["agent-session"] || "verify-mcp-session";
    const child = spawn("node", [BIN, "mcp", "--repo", s.repo], {
      cwd: s.repo,
      env: e,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const st = readState();
    st.mcpPids = [...(st.mcpPids || []), child.pid];
    writeState(st);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const pending = new Map();
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
      }
    });
    const exited = new Promise((res) =>
      child.on("exit", (code, sig) => res({ code, sig })),
    );
    let nextId = 1;
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for ${method}`)),
          15000,
        );
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    const lines = [];
    const log = [];
    let failed = false;
    const vars = {};
    const sub = (v) =>
      typeof v === "string"
        ? v.replace(/\$(\w+)/g, (m, k) => (k in vars ? vars[k] : m))
        : Array.isArray(v)
          ? v.map(sub)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]))
            : v;
    const dig = (obj, path) => path.split(".").reduce((a, k) => a?.[k], obj);
    try {
      const init = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "verify-lhr", version: "0" },
      });
      log.push({ step: "initialize", response: init });
      lines.push(
        `initialize -> server ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}, capabilities ${JSON.stringify(init.result?.capabilities)}`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      for (const [i, step] of steps.entries()) {
        if (step.sleep) {
          await new Promise((r) => setTimeout(r, step.sleep));
          lines.push(`${i + 1}. sleep ${step.sleep}ms`);
          continue;
        }
        const label = step.call
          ? `call ${step.call} ${JSON.stringify(sub(step.args ?? {}))}`
          : step.method;
        const msg = step.call
          ? await rpc("tools/call", {
              name: step.call,
              arguments: sub(step.args ?? {}),
            })
          : await rpc(step.method, sub(step.params ?? {}));
        const res = msg.result;
        let parsed;
        if (step.call && res?.content?.[0]?.text) {
          try {
            parsed = JSON.parse(res.content[0].text);
          } catch {
            parsed = undefined;
          }
        }
        const isError = step.call ? !!res?.isError || !!msg.error : !!msg.error;
        const expectError = step.expectError ?? false;
        const stepOk =
          isError === !!expectError &&
          (!step.expectCode ||
            (parsed?.error?.code ?? msg.error?.code) === step.expectCode);
        for (const [k, p] of Object.entries(step.save ?? {}))
          vars[k] = dig(res?.structuredContent ?? parsed, p);
        failed ||= !stepOk;
        log.push({
          step: i + 1,
          label,
          request: step,
          response: msg,
          ok: stepOk,
        });
        const summary =
          step.method === "tools/list"
            ? `${res?.tools?.length} tools: ${res?.tools?.map((t) => t.name).join(", ")}`
            : JSON.stringify(
                res?.structuredContent ?? parsed ?? msg.error ?? res,
              ).slice(0, 700);
        lines.push(
          `${i + 1}. ${label}\n   ${stepOk ? "OK" : "UNEXPECTED"} isError=${isError}${expectError ? ` (expected error${step.expectCode ? ` ${step.expectCode}` : ""})` : ""}\n   ${summary}`,
        );
      }
    } catch (err) {
      failed = true;
      lines.push(`ERROR ${err.message}`);
    }
    child.stdin.end();
    const killer = setTimeout(() => child.kill("SIGTERM"), 5000);
    const { code, sig } = await exited;
    clearTimeout(killer);
    const st2 = readState();
    st2.mcpPids = (st2.mcpPids || []).filter((p) => p !== child.pid);
    writeState(st2);
    const clean = code === 0 && !sig;
    failed ||= !clean;
    lines.push(
      `server exit: code ${code}${sig ? ` signal ${sig}` : ""} ${clean ? "OK (closed on stdin EOF)" : "UNEXPECTED"}${stderr.trim() ? `\nstderr: ${stderr.trim()}` : ""}`,
    );
    const text = `$ lhr mcp --repo ${s.repo}   (env: ${e.LHR_SESSION_ID ? `LHR_SESSION_ID=${e.LHR_SESSION_ID}` : "no session"}${e.LHR_AGENT_NAME ? `, LHR_AGENT_NAME=${e.LHR_AGENT_NAME}` : ""})\n${lines.join("\n")}\n`;
    process.stdout.write(text);
    mkdirSync(EVIDENCE, { recursive: true });
    appendFileSync(join(EVIDENCE, "transcript.log"), `${text}\n`);
    if (o.ev) {
      save(o.ev, text);
      writeFileSync(
        join(EVIDENCE, `${slug(o.ev)}.json`),
        JSON.stringify(log, null, 2),
      );
    }
    process.exit(failed ? 1 : 0);
  },

  /** tree [--ev NAME] [--session S]: every file under .lhr/ with its contents (the durable side effect). */
  tree(argv) {
    const [o] = parse(argv, ["ev", "session"]);
    const s = session(o.session);
    const dir = join(s.repo, ".lhr");
    if (!existsSync(dir)) die(`no .lhr/ in ${s.repo}`);
    const out = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else
          out.push(`===== ${relative(s.repo, p)}\n${readFileSync(p, "utf8")}`);
      }
    };
    walk(dir);
    const text = `${out.join("\n")}\n`;
    process.stdout.write(text);
    if (o.ev) {
      save(`${o.ev}`, text);
      cpSync(dir, join(EVIDENCE, `${slug(o.ev)}-lhr`), { recursive: true });
    }
  },

  /** stop: delete sessions and state, kill only MCP servers this harness started, keep evidence. */
  stop() {
    const st = readState();
    for (const pid of st.mcpPids || []) {
      try {
        process.kill(pid, "SIGTERM");
        console.error(`lhr-verify: terminated leftover mcp server ${pid}`);
      } catch {
        /* already gone */
      }
    }
    rmSync(join(RUN, "sessions"), { recursive: true, force: true });
    rmSync(STATE, { force: true });
    rmSync(GITCONFIG, { force: true });
    console.log(
      JSON.stringify({
        stopped: true,
        evidenceKept: EVIDENCE,
        files: existsSync(EVIDENCE) ? readdirSync(EVIDENCE).length : 0,
      }),
    );
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !commands[cmd])
  die(`usage: lhr-verify.mjs <${Object.keys(commands).join("|")}> [...]`, 2);
await commands[cmd](rest);
