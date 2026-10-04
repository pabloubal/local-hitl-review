// Pack-and-run smoke test for the published CLI (issue #129).
//
// Builds the bundle, packs @pablou/lhr exactly as `npm publish` would, installs the
// tarball into a throwaway directory outside the workspace, and runs the installed
// `lhr` bin: --version, --help, and an MCP initialize handshake over stdio.
//
// Usage: npm run smoke:pack -w @pablou/lhr   (or: node packages/cli/scripts/smoke-pack.mjs)
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "lhr-smoke-"));
const keep = process.env.LHR_SMOKE_KEEP === "1";

// The installed bin must not pick up a developer's LHR_* settings.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith("LHR_") && k !== "CLAUDE_CODE_SESSION_ID",
  ),
);

function fail(message, detail) {
  console.error(`smoke-pack: FAIL: ${message}`);
  if (detail) console.error(detail);
  console.error(`smoke-pack: work dir ${work}`);
  process.exit(1);
}

/** Runs a command, failing the smoke test on a non-zero exit. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env,
    timeout: 120_000,
    ...opts,
  });
  if (r.error) fail(`${cmd} ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) {
    fail(
      `${cmd} ${args.join(" ")} exited ${r.status}`,
      `${r.stdout}\n${r.stderr}`,
    );
  }
  return r;
}

function check(cond, message, detail) {
  if (!cond) fail(message, detail);
  console.log(`smoke-pack: ok: ${message}`);
}

try {
  // 1. Build and pack, as the release job does before `npm publish`.
  run(process.execPath, ["esbuild.mjs"], { cwd: pkgDir });
  const packDir = join(work, "pack");
  mkdirSync(packDir);
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: pkgDir,
    }).stdout,
  )[0];
  const files = packed.files.map((f) => f.path).sort();
  check(
    files.includes("dist/lhr.mjs"),
    "tarball contains dist/lhr.mjs",
    files.join("\n"),
  );
  check(
    !files.some(
      (f) =>
        f.startsWith("src/") || f.startsWith("test/") || f.endsWith(".map"),
    ),
    "tarball has no sources, tests or source maps",
    files.join("\n"),
  );
  check(
    packed.version === pkg.version,
    `tarball version is ${pkg.version}`,
    packed.version,
  );

  // 2. Install the tarball into a fresh project outside the workspace.
  const installDir = join(work, "install");
  mkdirSync(installDir);
  writeFileSync(join(installDir, "package.json"), '{ "private": true }\n');
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      join(packDir, packed.filename),
    ],
    {
      cwd: installDir,
    },
  );
  const bin = join(installDir, "node_modules", ".bin", "lhr");

  // 3. Run the installed bin directly, so the shebang and exec bit are exercised.
  const emptyDir = join(work, "empty");
  mkdirSync(emptyDir);
  const version = run(bin, ["--version"], { cwd: emptyDir });
  check(
    version.stdout === `${pkg.version}\n`,
    `lhr --version prints ${pkg.version}`,
    version.stdout,
  );

  const help = run(bin, ["--help"], { cwd: emptyDir });
  check(
    /^Usage:/m.test(help.stdout) && /^ {2}mcp\b/m.test(help.stdout),
    "lhr --help lists commands",
    help.stdout,
  );

  // 4. MCP handshake over stdio: initialize, initialized, tools/list, then EOF.
  // Runs outside any review root: the server must still start and list its tools.
  const frame = (o) => `${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`;
  const input = [
    frame({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-pack", version: "1" },
      },
    }),
    frame({ method: "notifications/initialized" }),
    frame({ id: 2, method: "tools/list", params: {} }),
  ].join("");
  const mcp = run(bin, ["mcp"], { cwd: emptyDir, input, timeout: 30_000 });
  let replies;
  try {
    replies = Object.fromEntries(
      mcp.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .map((m) => [m.id, m]),
    );
  } catch (e) {
    fail(`lhr mcp wrote non-JSON to stdout: ${e.message}`, mcp.stdout);
  }
  const init = replies[1]?.result;
  check(
    init?.serverInfo?.name === "lhr" &&
      init?.serverInfo?.version === pkg.version,
    `lhr mcp initialize returns serverInfo lhr ${pkg.version}`,
    mcp.stdout,
  );
  const tools = replies[2]?.result?.tools ?? [];
  check(
    tools.length > 0,
    `lhr mcp tools/list returns ${tools.length} tools`,
    mcp.stdout,
  );

  console.log(`smoke-pack: PASS (${packed.filename})`);
} finally {
  if (keep) console.log(`smoke-pack: kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
