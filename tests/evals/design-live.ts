/** Opt-in, credentialed live Design evaluation. Not part of deterministic CI. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PaperReader } from "../../src/core/design/helper";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = join(homedir(), ".fx", "design-evals");
const binary = join(repo, "zig-out/bin/fx");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

type Run = { id: string; session: string; directory: string; binary: string; workspace: string; prompt: string; submitted: boolean; started: string; stopped?: string };

async function command(executable: string, args: string[], timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${executable} timed out`)); }, timeout);
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { errors = (errors + data).slice(-8000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${executable} exited ${code}: ${errors || output}`)); });
  });
}

async function save(run: Run) { await writeFile(join(run.directory, "run.json"), JSON.stringify(run, null, 2), { mode: 0o600 }); }
async function load(id: string): Promise<Run> {
  if (!/^[0-9TZa-f-]+$/.test(id)) throw new Error("Invalid run ID");
  const run: Run = JSON.parse(await readFile(join(root, id, "run.json"), "utf8"));
  if (run.id !== id || run.session !== `fx-design-eval-${id}` || run.directory !== join(root, id)) throw new Error("Run identity mismatch");
  return run;
}
async function screen(run: Run) {
  const text = await command("tmux", ["capture-pane", "-p", "-t", run.session, "-S", "-2000"]);
  await writeFile(join(run.directory, "screen.txt"), text, { mode: 0o600 });
  return text;
}
async function waitScreen(run: Run, predicate: (text: string) => boolean, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const text = await screen(run);
    if (predicate(text)) return text;
    const dead = await command("tmux", ["display-message", "-p", "-t", run.session, "#{pane_dead}"]);
    if (dead.trim() === "1") throw new Error(`fx exited during startup; inspect ${run.directory}`);
    await sleep(500);
  }
  throw new Error(`Timed out waiting for fx; inspect ${run.directory}`);
}
async function send(run: Run, text: string) {
  await command("tmux", ["send-keys", "-t", run.session, "-l", text]);
  await command("tmux", ["send-keys", "-t", run.session, "Enter"]);
}
async function paperInfo() {
  const reader = new PaperReader();
  await reader.initialize();
  const result = await reader.read("get_basic_info", {});
  return JSON.parse(result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n"));
}

async function start(submit: boolean) {
  if (process.platform !== "linux") throw new Error("Run this harness with native Bun inside WSL/Linux");
  const workspace = process.env.FX_DESIGN_WORKSPACE ?? join(homedir(), "comp-v2-design-system");
  const url = process.env.FX_DESIGN_URL ?? "http://127.0.0.1:3000/fullscreen/demo";
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Comp returned HTTP ${response.status}`);
  const before = await paperInfo();
  if (before.fileName !== "Zod For Design (Test)" || before.pageName !== "e2e") throw new Error("Select Zod For Design (Test) / e2e in Paper before starting");
  const id = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z") + "-" + crypto.randomUUID().slice(0, 8);
  const directory = join(root, id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const run: Run = { id, directory, session: `fx-design-eval-${id}`, binary, workspace, submitted: false, started: new Date().toISOString(),
    prompt: `Bring the Comp demo at ${url} into Paper's "Zod For Design (Test)" file, on the "e2e" page. The codebase is at ${workspace}.` };
  await save(run);
  await writeFile(join(directory, "paper-before.json"), JSON.stringify(before, null, 2), { mode: 0o600 });
  console.log(`Run ${id}\nEvidence: ${directory}\nBuilding ${binary}`);
  const zig = process.env.FX_DESIGN_ZIG ?? join(homedir(), "zig-x86_64-linux-0.16.0/zig");
  await command(zig, ["build", "-j2"], 600000);
  await writeFile(join(directory, "build.json"), JSON.stringify({ binary, sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex"), checkedAt: new Date().toISOString() }), { mode: 0o600 });
  const health = await command(binary, ["mcp", "list", "--connect"], 90000);
  await writeFile(join(directory, "mcp.txt"), health, { mode: 0o600 });
  for (const name of ["paper", "fx_design"]) if (!new RegExp(`^  ${name} .*state=ready`, "m").test(health)) throw new Error(`${name} is unavailable; no agent task submitted`);
  await command("tmux", ["new-session", "-d", "-s", run.session, "-x", "140", "-y", "45", "-c", repo, "/bin/sleep", "86400"]);
  await command("tmux", ["set-option", "-t", run.session, "remain-on-exit", "on"]);
  await command("tmux", ["respawn-pane", "-k", "-t", run.session, "-c", repo, "/usr/bin/env", `PATH=${process.env.PATH}`, "FX_DEBUG_RECORD=1", "FX_DEBUG_RECORD_SILENT_BANNER=1", `FX_RECORD=${join(directory, "terminal.fxtape")}`, "/usr/bin/script", "--quiet", "--flush", "--return", "--log-out", join(directory, "terminal.ansi"), "--command", quote(binary)]);
  await waitScreen(run, text => /(?:auto|plan|DESIGN).*·/.test(text));
  for (let attempt = 0; attempt < 6 && !/DESIGN\s*·/.test(await screen(run)); attempt++) {
    await command("tmux", ["send-keys", "-t", run.session, "BTab"]);
    await sleep(1000);
  }
  await waitScreen(run, text => /DESIGN\s*·/.test(text));
  // A list printed during reconnect is a snapshot, not a live status widget.
  // Refresh it until the latest snapshot confirms both transports.
  let connected = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    await send(run, "/mcp list");
    await sleep(2000);
    const text = await screen(run);
    const latest = text.slice(text.lastIndexOf("MCP health"));
    if (/fx_design .*state=ready/.test(latest) && /paper .*state=ready/.test(latest)) { connected = true; break; }
    await sleep(1000);
  }
  if (!connected) throw new Error(`MCP reconnect did not finish; inspect ${directory}`);
  if (submit) {
    await send(run, run.prompt);
    run.submitted = true;
    await save(run);
  }
  console.log(JSON.stringify({ id, session: run.session, submitted: run.submitted, directory, note: "Connectivity is verified; import success requires independent Paper inspection." }, null, 2));
}

async function status(run: Run) {
  const text = await screen(run);
  const pane = (await command("tmux", ["display-message", "-p", "-t", run.session, "#{pane_dead}:#{pane_dead_status}"])).trim();
  const after = await paperInfo();
  await writeFile(join(run.directory, "paper-current.json"), JSON.stringify(after, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ id: run.id, pane, submitted: run.submitted, file: after.fileName, page: after.pageName, artboards: after.artboardCount, evidence: run.directory, verdict: "unverified" }, null, 2));
  console.log(text.slice(-14000));
}

async function stop(run: Run) {
  await screen(run);
  await command("tmux", ["send-keys", "-t", run.session, "C-c", "C-c"]);
  await sleep(2000);
  await screen(run);
  await writeFile(join(run.directory, "stop.json"), JSON.stringify({ pane: (await command("tmux", ["display-message", "-p", "-t", run.session, "#{pane_dead}:#{pane_dead_status}"])).trim() }), { mode: 0o600 });
  await command("tmux", ["kill-session", "-t", run.session]);
  run.stopped = new Date().toISOString();
  await save(run);
  console.log(`Stopped only ${run.session}; evidence retained at ${run.directory}`);
}

const [action, id] = process.argv.slice(2);
try {
  if (action === "start") await start(id === "--submit");
  else if (action === "status" && id) await status(await load(id));
  else if (action === "stop" && id) await stop(await load(id));
  else throw new Error("Usage: bun tests/evals/design-live.ts start [--submit] | status <run-id> | stop <run-id>");
} catch (error) { console.error(String(error)); process.exitCode = 1; }
