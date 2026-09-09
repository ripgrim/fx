/** fx's managed design adapter. Paper mutations are executed by fx, never here. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, realpath, rm, stat } from "node:fs/promises";
import { resolve, relative, join, isAbsolute, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { brotliDecompressSync } from "node:zlib";
import { Inspector, type VerificationSnapshot } from "./inspector";
import { comparePixelBuffers, comparisonSensitivity } from "./comparison";
import { bindImportReceipt, normalizePropertyStyles, readBoundProperties, type SourceManifestEntry, type SourceBinding, type PropertyComparison } from "./property_diff";

export const VERSION = 1;
type Json = Record<string, any>;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export function parseDiffParameters(input: string) {
  const tokens: string[] = [];
  let token = "", quote = "", started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && input[i + 1] === quote) token += input[++i];
      else token += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) tokens.push(token); token = ""; started = false; }
    else { token += char; started = true; }
  }
  if (quote) throw new Error("Close the quoted parameter.");
  if (started) tokens.push(token);
  const result: Json = { target: "" };
  const options: Record<string, string> = { "--selector": "selector", "--ready-selector": "ready_selector", "--width": "width", "--height": "height", "--session-storage": "session_storage", "--local-storage": "local_storage" };
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i], key = options[value];
    if (key) {
      if (++i === tokens.length) throw new Error(`Missing value for ${value}.`);
      result[key] = key.endsWith("storage") ? JSON.parse(tokens[i]) : key === "width" || key === "height" ? Number(tokens[i]) : tokens[i];
      if ((key === "width" || key === "height") && (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 10000)) throw new Error("Viewport dimensions must be between 1 and 10000.");
    } else if (/^https?:\/\//.test(value)) {
      if (result.url) throw new Error("Supply one source URL.");
      result.url = new URL(value).href;
    } else if (!result.target && /^(node:|capture:|\/)/.test(value)) result.target = value;
    else throw new Error("Use /diff node:ID URL [--selector 'CSS selector'].");
  }
  return result;
}
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export interface DesignNode {
  key: string;
  name: string;
  tag: string;
  text: string;
  svg?: string;
  svg_rendered?: string;
  image?: string;
  resolved_font_family?: string;
  // Generated boxes retain their source identity without pretending to be DOM nodes.
  pseudo_elements?: { pseudo: "::before" | "::after"; styles: Record<string, string> }[];
  styles: Record<string, string>;
  bindings: Record<string, { candidates: string[]; value: string; verified?: boolean }>;
  rect: { x: number; y: number; width: number; height: number };
  children: DesignNode[];
}
export interface DesignRecord {
  capture_context?: { policy: number; state_label: string; state_fingerprint: string; ready_selector?: string };
  version: number;
  id: string;
  workspace: string;
  source_revision: string;
  source_files: Record<string, string>;
  source_index?: { file: string; hash: string; components: string[]; slots: string[] }[];
  font_evidence?: { alias: string; family: string; url: string; sha256: string }[];
  url: string;
  selector: string;
  viewport: { width: number; height: number };
  root: DesignNode;
  screenshot: string;
  findings: Json[];
  phase: "import" | "design" | "apply";
  artboard_id?: string;
  file_id?: string;
  baseline?: Json;
  source_manifest?: SourceManifestEntry[];
  source_bindings?: SourceBinding[];
  canvas_revision?: string;
  verified_operations?: number;
  verification?: VerificationSnapshot;
  token_bindings?: Record<string, string>;
  tokens?: { name: string; type: string; value: string | number; description: string }[];
  operations: { tool: string; arguments: Json; hash: string; status: "pending" | "started" | "applied"; result?: Json }[];
}

export class Store {
  constructor(readonly directory: string) {}
  path(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid operation identity");
    return join(this.directory, `${id}.json`);
  }
  async load(id: string): Promise<DesignRecord> {
    const value = JSON.parse(await readFile(this.path(id), "utf8"));
    if (value.version !== VERSION || value.id !== id) throw new Error("Unsupported design record");
    return value;
  }
  async save(record: DesignRecord) {
    await mkdir(this.directory, { recursive: true });
    const path = this.path(record.id), temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  }
  async list() {
    const entries = await readdir(this.directory).catch(() => []);
    return Promise.all(entries.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map(name => this.load(name.slice(0, -5))));
  }
}

export async function inventory(workspace: string) {
  const root = await realpath(workspace);
  const files: Record<string, string> = {};
  const excluded = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".tokens", ".fx", "storybook-static", ".screenshots"]);
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || excluded.has(entry.name) || (entry.isDirectory() && entry.name.startsWith(".next-"))) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(tsx?|jsx?|css|scss|svg)$/.test(entry.name) || entry.name === "package.json") {
        if (Object.keys(files).length >= 10000) throw new Error("Source inventory exceeds 10000 files");
        files[relative(root, path).replaceAll("\\", "/")] = digest(await readFile(path, "utf8"));
      }
    }
  }
  await walk(root);
  return { root, files, revision: digest(files) };
}

async function sourceIndex(workspace: string, files: Record<string, string>) {
  const index: NonNullable<DesignRecord["source_index"]> = [];
  for (const [file, hash] of Object.entries(files)) {
    if (!/\.[jt]sx$/.test(file)) continue;
    const text = await readFile(join(workspace, file), "utf8");
    // These are search candidates, never an assertion that a DOM node belongs to a file.
    const components = [...new Set(Array.from(text.matchAll(/\b(?:function|const|class)\s+([A-Z][\w]*)/g), match => match[1]!))];
    const slots = [...new Set(Array.from(text.matchAll(/data-slot\s*=\s*["']([^"']+)["']/g), match => match[1]!))];
    index.push({ file, hash, components, slots });
  }
  return index;
}

async function command(executable: string, args: string[], input?: string): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    let stdout = "", stderr = "", settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : accept(stdout); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Browser ${args[3] ?? "command"} timed out`)); }, 60000);
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) { child.kill(); finish(new Error("Browser output limit exceeded")); } });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on("error", error => finish(error));
    // A daemon may retain inherited pipe handles on Windows after the CLI exits.
    child.on("exit", code => finish(code === 0 ? undefined : new Error(`Browser command failed (${code}): ${stderr || stdout.slice(-2000)}`)));
  });
}

/** Read only identity metadata, not glyph outlines. WOFF2 collections are unsupported.
 * Formats: https://www.w3.org/TR/WOFF2/ and OpenType's name table. */
export function fontFamily(bytes: Uint8Array): string {
  const data = Buffer.from(bytes);
  let table: Buffer | undefined;
  const slice = (buffer: Buffer, offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > buffer.length) throw new Error("Invalid font table bounds");
    return buffer.subarray(offset, offset + length);
  };
  if (data.length > 16 * 1024 * 1024) throw new Error("Font exceeds metadata limit");
  if (data.toString("ascii", 0, 4) === "wOF2") {
    if (data.length < 48 || data.toString("ascii", 4, 8) === "ttcf") throw new Error("Unsupported font collection");
    let cursor = 48, offset = 0, nameOffset = -1, nameLength = 0;
    const uint128 = () => {
      let value = 0;
      for (let index = 0; index < 5; index++) {
        const byte = data.readUInt8(cursor++);
        if ((index === 0 && byte === 128) || value > 0x1ffffff) throw new Error("Invalid font length");
        value = value * 128 + (byte & 127);
        if (!(byte & 128)) return value;
      }
      throw new Error("Invalid font length");
    };
    for (let index = 0; index < data.readUInt16BE(12); index++) {
      const flags = data.readUInt8(cursor++), code = flags & 63, transform = flags >> 6;
      const tag = code === 63 ? slice(data, cursor, 4).toString("ascii") : code === 5 ? "name" : code === 10 ? "glyf" : code === 11 ? "loca" : "other";
      if (code === 63) cursor += 4;
      const original = uint128();
      const transformed = tag === "glyf" || tag === "loca" ? transform !== 3 : transform !== 0;
      const length = transformed ? uint128() : original;
      if (tag === "name") {
        if (transformed || nameOffset >= 0) throw new Error("Invalid font name table");
        nameOffset = offset; nameLength = length;
      }
      offset += length;
      if (offset > 32 * 1024 * 1024) throw new Error("Font exceeds metadata limit");
    }
    if (nameOffset < 0) throw new Error("Font has no name table");
    const inflated = brotliDecompressSync(slice(data, cursor, data.readUInt32BE(20)), { maxOutputLength: 32 * 1024 * 1024 });
    if (inflated.length !== offset) throw new Error("Invalid font stream length");
    table = slice(inflated, nameOffset, nameLength);
  } else if (data.readUInt32BE(0) === 0x10000 || data.toString("ascii", 0, 4) === "OTTO") {
    for (let index = 0; index < data.readUInt16BE(4); index++) {
      const entry = slice(data, 12 + index * 16, 16);
      if (entry.toString("ascii", 0, 4) === "name") table = slice(data, entry.readUInt32BE(8), entry.readUInt32BE(12));
    }
  }
  if (!table || table.readUInt16BE(0) > 1) throw new Error("Unsupported font identity format");
  const names: { id: number; language: number; value: string }[] = [];
  for (let index = 0; index < table.readUInt16BE(2); index++) {
    const entry = slice(table, 6 + index * 12, 12);
    const platform = entry.readUInt16BE(0), id = entry.readUInt16BE(6);
    if ((platform !== 0 && platform !== 3) || (id !== 1 && id !== 16)) continue;
    const raw = slice(table, table.readUInt16BE(4) + entry.readUInt16BE(10), entry.readUInt16BE(8));
    const value = new TextDecoder("utf-16be", { fatal: true }).decode(raw).trim();
    if (!value || value.length > 200 || /[\x00-\x1f]/.test(value)) continue;
    names.push({ id, language: entry.readUInt16BE(4), value });
  }
  names.sort((a, b) => b.id - a.id || Number(b.language === 0x409) - Number(a.language === 0x409));
  if (!names.length) throw new Error("Font family metadata unavailable");
  return names[0]!.value;
}

export class Browser {
  constructor(readonly session: string, readonly executable = process.env.FX_DESIGN_BROWSER ?? (process.platform === "win32" ? "agent-browser.exe" : "agent-browser")) {}
  async call(...args: string[]) {
    const output = await command(this.executable, ["--session", this.session, "--json", ...args]);
    const result = JSON.parse(output);
    if (!result.success) throw new Error(result.error ?? "Browser operation failed");
    return result.data;
  }
  async evaluate(script: string) {
    const output = await command(this.executable, ["--session", this.session, "--json", "eval", "--stdin"], script);
    const response = JSON.parse(output);
    if (!response.success) throw new Error(response.error ?? "Browser evaluation failed");
    const result = response.data;
    return result.result ?? result;
  }
}

/** This transport has no mutation API. Writes must pass through fx tool admission. */
export class PaperReader {
  private session?: string;
  private sequence = 0;
  constructor(readonly url = process.env.FX_DESIGN_PAPER_URL ?? "http://127.0.0.1:29979/mcp") {}
  private async request(payload: Json) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(this.session ? { "Mcp-Session-Id": this.session } : {}) };
    const body = JSON.stringify(payload);
    const endpoint = new URL(this.url);
    // Paper Desktop is a Windows process when fx runs under WSL. Windows curl
    // reaches its loopback without exposing Paper on a LAN interface.
    if (process.platform === "linux" && process.env.WSL_DISTRO_NAME && ["127.0.0.1", "localhost"].includes(endpoint.hostname)) {
      const args = ["--silent", "--show-error", "--max-time", "30", "--include", "--request", "POST", "--data-binary", "@-", ...Object.entries(headers).flatMap(([name, value]) => ["--header", `${name}: ${value}`]), this.url];
      const raw = await command("curl.exe", args, body);
      const boundary = raw.indexOf("\r\n\r\n");
      if (boundary < 0) throw new Error("Windows Paper bridge returned invalid HTTP headers");
      const lines = raw.slice(0, boundary).split("\r\n"), status = Number(lines.shift()?.split(" ")[1]);
      const received = new Headers();
      for (const line of lines) { const split = line.indexOf(":"); if (split > 0) received.append(line.slice(0, split), line.slice(split + 1).trim()); }
      return new Response(status === 204 ? null : raw.slice(boundary + 4), { status, headers: received });
    }
    return fetch(this.url, { method: "POST", headers, body, signal: AbortSignal.timeout(30000) });
  }
  private async rpc(method: string, params: Json = {}) {
    const response = await this.request({ jsonrpc: "2.0", id: ++this.sequence, method, params });
    if (!response.ok) throw new Error(`Paper MCP returned HTTP ${response.status}`);
    this.session = response.headers.get("mcp-session-id") ?? this.session;
    const body = await response.text();
    const payload = response.headers.get("content-type")?.includes("text/event-stream") ? body.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(value => value.id === this.sequence) : JSON.parse(body);
    if (!payload || payload.error) throw new Error(payload?.error?.message ?? "Paper returned no matching response");
    return payload.result;
  }
  async initialize() {
    await this.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fx-design-reader", version: "1" } });
    const response = await this.request({ jsonrpc: "2.0", method: "notifications/initialized" });
    if (!response.ok) throw new Error(`Paper initialization returned HTTP ${response.status}`);
  }
  async read(name: string, args: Json) {
    if (!["get_selection", "get_basic_info", "get_node_info", "get_children", "get_computed_styles", "get_jsx", "get_screenshot", "export", "get_tokens", "get_font_family_info"].includes(name)) throw new Error("Paper reader rejects mutations");
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result;
  }
  async snapshot(nodeId: string, fileId?: string) {
    const args = { nodeId, ...(fileId ? { fileId } : {}) };
    const nodes = await this.read("get_node_info", args);
    const jsx = await this.read("get_jsx", args);
    // get_screenshot is JPEG-only in Paper Desktop. Export the actual canvas,
    // never re-encode that lossy screenshot and call it lossless evidence.
    const exported = await this.read("export", { type: "image", nodes: { [nodeId]: [{ format: "png", scale: "1x" }] }, ...(fileId ? { fileId } : {}) });
    const payload = exported.structuredContent ?? JSON.parse(exported.content?.find((part: Json) => part.type === "text")?.text ?? "{}");
    const entry = payload.exports?.find((item: Json) => item.nodeId === nodeId);
    const image = await readPaperPng(entry?.filePath);
    return { nodes, jsx, image };
  }
}

export async function readPaperPng(filePath: unknown): Promise<string> {
  if (typeof filePath !== "string" || !filePath.toLowerCase().endsWith(".png")) throw new Error("Paper did not provide a lossless PNG export");
  let path = filePath.replace(/\\+/g, "/");
  if (path.startsWith("//")) throw new Error("Remote Paper exports are not supported");
  if (process.platform === "linux" && process.env.WSL_DISTRO_NAME && /^[A-Za-z]:\//.test(path)) path = `/mnt/${path[0]!.toLowerCase()}${path.slice(2)}`;
  if (!isAbsolute(path)) throw new Error("Paper export must be a local absolute path");
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("Paper PNG exceeds the capture limit");
  const bytes = await readFile(path);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Paper export is not PNG; recapture required");
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function paperObject(result: Json): Json {
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content ?? []).filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("\n");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Paper returned no structured node evidence");
  return value;
}

/** Recheck live membership at admission, not just when the edit is prepared. */
export async function validateEditTargets(record: DesignRecord, tool: string, args: Json, paper: Pick<PaperReader, "read">) {
  if (!record.file_id || !record.artboard_id) throw new Error("Design edits require an explicitly linked Paper file and artboard");
  if (args.fileId !== record.file_id) throw new Error("Design edit must target the linked Paper file");
  const members = new Set<string>([record.artboard_id]);
  const queue = [record.artboard_id];
  for (let index = 0; index < queue.length; index++) {
    const value = paperObject(await paper.read("get_children", { nodeId: queue[index], fileId: record.file_id }));
    if (!Array.isArray(value.children)) throw new Error("Paper returned no child membership evidence");
    for (const child of value.children) {
      if (typeof child.id !== "string" || !child.id || members.has(child.id)) throw new Error("Paper returned invalid or cyclic membership evidence");
      members.add(child.id);
      if (members.size > 10000) throw new Error("Paper artboard exceeds membership limit");
      // Read every node: omitted child counts must not hide descendants.
      queue.push(child.id);
    }
  }
  const targets: string[] = [];
  const scalarKeys = new Set(["nodeId", "parentId", "before", "after", "id"]);
  function visit(value: unknown) {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "styles") continue;
      if (scalarKeys.has(key)) {
        if (typeof item !== "string" || !members.has(item)) throw new Error("Design edit references a node outside its linked artboard");
        targets.push(item);
      } else if (key === "nodeIds") {
        if (!Array.isArray(item) || !item.length) throw new Error("Design edit requires node IDs");
        for (const id of item) {
          if (typeof id !== "string" || !members.has(id)) throw new Error("Design edit references a node outside its linked artboard");
          targets.push(id);
        }
      } else visit(item);
    }
  }
  visit(args);
  if (!targets.length) throw new Error("Design edit has no verifiable node targets");
  if (["mcp_paper_delete_nodes", "mcp_paper_move_nodes", "mcp_paper_duplicate_nodes"].includes(tool)) {
    // Root placement and lifecycle are not ordinary edits inside an artboard.
    if (targets.includes(record.artboard_id)) throw new Error("Structural edits to the linked artboard root are unsupported");
  }
}

export async function compareImages(source: string, canvas: string) {
  const browser = new Browser(`fx-design-diff-${randomUUID()}`);
  try {
    await browser.call("open", "about:blank");
    return await browser.evaluate(`(async () => {
      const load = src => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
      const [a, b] = await Promise.all([load(${JSON.stringify(source)}), load(${JSON.stringify(canvas)})]);
      const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
      if (width * height > 32000000) throw new Error('Image comparison exceeds pixel limit');
      const pixels = image => { const c = document.createElement('canvas'); c.width = width; c.height = height; const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, width, height).data; };
      const {mask, ...comparison} = (${comparePixelBuffers.toString()})(pixels(a), pixels(b), ${comparisonSensitivity.pixel_channel_epsilon}, a.width);
      return { ...comparison, sensitivity: ${JSON.stringify(comparisonSensitivity)}, total_pixels: width * height, dimensions_match: a.width === b.width && a.height === b.height, match: comparison.different_pixels === 0 && a.width === b.width && a.height === b.height };
    })()`);
  } finally { await browser.call("close").catch(() => undefined); }
}

/** Runs inside the source browser. Keep all dependencies within this function. */
export async function captureDocument(selector: string) {
  // This document belongs to the disposable capture browser, not the user's tab.
  // Keep the stylesheet active through the screenshot, including late-mounted hosts.
  // Never exclude generic portals or iframes: those can be real product content.
  if (!document.querySelector('style[data-fx-capture]')) {
    const capture_style = document.createElement("style");
    capture_style.dataset.fxCapture = "true";
    capture_style.textContent = "nextjs-portal { display: none !important; }";
    document.head.append(capture_style);
  }
  await document.fonts.ready;
  const roots = document.querySelectorAll(selector);
  if (roots.length !== 1) throw new Error(`Expected one page surface, found ${roots.length}`);
  const root = roots[0]!;
  await Promise.all(Array.from(root.querySelectorAll("img")).map(img => img.decode().catch(() => undefined)));
  const findings: Json[] = [];
  const font_families = new Set<string>();
  const props = ["display", "position", "width", "height", "min-width", "max-width", "min-height", "max-height", "box-sizing", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "align-items", "align-self", "justify-content", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left", "color", "background-color", "background-image", "background-size", "background-position", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "box-shadow", "opacity", "overflow", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-decoration", "white-space", "transform", "transform-origin", "top", "left", "right", "bottom", "z-index", "object-fit"];
  const rules: CSSStyleRule[] = [];
  const font_rules: CSSFontFaceRule[] = [];
  function collect(list: CSSRuleList) {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue;
      if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
      if (rule instanceof CSSStyleRule) rules.push(rule);
      if (rule instanceof CSSFontFaceRule) font_rules.push(rule);
      if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules);
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try { collect(sheet.cssRules); } catch { findings.push({ kind: "stylesheet-unreadable", href: sheet.href }); }
  }
  const origin = root.getBoundingClientRect();
  async function imageData(url: string) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Image fetch failed");
      const blob = await response.blob();
      return await new Promise<string>((accept, reject) => { const reader = new FileReader(); reader.onload = () => accept(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
    } catch { findings.push({ kind: "asset-unavailable", url }); return undefined; }
  }
  async function walk(el: Element, key: string): Promise<DesignNode> {
    const computed = getComputedStyle(el), rect = el.getBoundingClientRect();
    font_families.add(computed.fontFamily);
    const styles = Object.fromEntries(props.map(prop => [prop, computed.getPropertyValue(prop)]));
    const bindings: DesignNode["bindings"] = {};
    const authored: Record<string, string[]> = {};
    for (const rule of rules) {
      try { if (!el.matches(rule.selectorText)) continue; } catch { continue; }
      for (const prop of Array.from(rule.style)) {
        const raw = rule.style.getPropertyValue(prop).trim();
        (authored[prop] ??= []).push(raw);
        const names = Array.from(raw.matchAll(/var\(\s*(--[\w-]+)/g), match => match[1]!);
        for (const name of names) {
          const previous = bindings[prop]?.candidates ?? [];
          bindings[prop] = { candidates: [...new Set([...previous, name])], value: computed.getPropertyValue(name).trim() };
        }
      }
    }
    for (const prop of Array.from((el as HTMLElement).style ?? [])) {
      const raw = (el as HTMLElement).style.getPropertyValue(prop);
      (authored[prop] ??= []).push(raw.trim());
      const names = Array.from(raw.matchAll(/var\(\s*(--[\w-]+)/g), match => match[1]!);
      if (names.length === 1) bindings[prop] = { candidates: names, value: computed.getPropertyValue(names[0]!).trim() };
    }
    for (const [prop, binding] of Object.entries(bindings)) {
      const name = binding.candidates[0];
      binding.verified = binding.candidates.length === 1 && (authored[prop] ?? []).every(raw => raw.replace(/\s/g, "") === `var(${name})`);
    }
    const pseudo_elements: NonNullable<DesignNode["pseudo_elements"]> = [];
    for (const pseudo of ["::before", "::after"] as const) {
      const style = getComputedStyle(el, pseudo);
      if (style.content === "none" || style.content === "normal" || style.display === "none") continue;
      // Empty absolute decorations can be represented by ordinary editable boxes.
      // Generated text/counters, replaced content and unhandled paint effects need
      // separate measured representations; never claim those were preserved.
      const effects = ["filter", "backdrop-filter", "clip-path", "mask-image", "-webkit-mask-image", "perspective"];
      const unsupported_effect = effects.some(prop => { const value = style.getPropertyValue(prop); return value && value !== "none"; });
      if (!["\"\"", "''"].includes(style.content) || style.position !== "absolute" || style.backgroundImage.includes("url(") || unsupported_effect || style.mixBlendMode !== "normal" || el instanceof SVGElement || el instanceof HTMLImageElement) {
        findings.push({ kind: "pseudo-element", key, pseudo });
        continue;
      }
      const paint = Object.fromEntries([...props, "visibility", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius"].map(prop => [prop, style.getPropertyValue(prop)]));
      // Paper normalizes every box to border-box. Convert resolved content sizes
      // before serialization so borders/padding do not shrink generated boxes.
      if (style.boxSizing === "content-box") {
        for (const [dimension, sides] of [["width", ["left", "right"]], ["height", ["top", "bottom"]]] as const) {
          const extra = sides.reduce((sum, side) => sum + parseFloat(style.getPropertyValue(`padding-${side}`)) + parseFloat(style.getPropertyValue(`border-${side}-width`)), 0);
          for (const property of [dimension, `min-${dimension}`, `max-${dimension}`]) {
            if (/^\d+(?:\.\d+)?px$/.test(paint[property]!)) paint[property] = `${parseFloat(paint[property]!) + extra}px`;
          }
        }
      }
      paint["box-sizing"] = "border-box";
      paint["pointer-events"] = "none";
      pseudo_elements.push({ pseudo, styles: paint });
    }
    if (el.tagName === "CANVAS" || el.tagName === "VIDEO" || el.tagName === "IFRAME") findings.push({ kind: "unsupported-element", key, tag: el.tagName });
    const tag = el.tagName.toLowerCase();
    const image = el instanceof HTMLImageElement ? await imageData(el.currentSrc || el.src) : undefined;
    if (styles["background-image"]?.includes("url(")) findings.push({ kind: "background-asset", key });
    const svg = tag === "svg" ? el.outerHTML : undefined;
    let svg_rendered: string | undefined;
    if (svg) {
      const clone = el.cloneNode(true) as Element;
      const originals = [el, ...Array.from(el.querySelectorAll("*"))];
      const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
      originals.forEach((original, index) => {
        const measured = getComputedStyle(original);
        const properties = index === 0 ? [...props, "fill", "stroke", "stroke-width"] : ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "fill-rule", "opacity", "visibility"];
        copies[index]!.setAttribute("style", properties.map(property => `${property}:${measured.getPropertyValue(property)}`).join(";"));
      });
      svg_rendered = clone.outerHTML;
    }
    const text = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join("");
    if (text.trim() && el.children.length && !svg) findings.push({ kind: "mixed-text-content", key });
    return { key, name: el.getAttribute("data-slot") ?? el.getAttribute("aria-label") ?? tag, tag, text, svg, svg_rendered, image, styles, bindings, pseudo_elements,
      rect: { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height },
      children: svg ? [] : await Promise.all(Array.from(el.children).filter(child => !["SCRIPT", "STYLE", "LINK", "NOSCRIPT"].includes(child.tagName) && getComputedStyle(child).display !== "none").map((child, index) => walk(child, `${key}/${index}`))) };
  }
  const captured = await walk(root, "0");
  const stable = root.getBoundingClientRect();
  if (Math.abs(stable.width - origin.width) > 0.01 || Math.abs(stable.height - origin.height) > 0.01) findings.push({ kind: "unstable-layout" });
  const font_assets = [];
  for (const rule of font_rules) {
    const alias = rule.style.fontFamily.replace(/^["']|["']$/g, "");
    if (![...font_families].some(family => family.split(",")[0]!.trim().replace(/^["']|["']$/g, "") === alias)) continue;
    const match = rule.style.getPropertyValue("src").match(/url\(["']?([^"')]+)["']?\)/);
    if (!match) continue;
    const url = new URL(match[1]!, rule.parentStyleSheet?.href ?? location.href).href;
    const data = await imageData(url);
    if (data) font_assets.push({ alias, url, data });
  }
  return { root: captured, findings, font_families: [...font_families], font_assets };
}

export function collectTokens(root: DesignNode, existing: Map<string, string> = new Map()) {
  const tokens: NonNullable<DesignRecord["tokens"]> = [];
  const bindings: Record<string, string> = {};
  const candidates: { key: string; property: string; name: string; type: string; value: string }[] = [];
  const typeFor = (property: string) => {
    if (["color", "background-color", "border-color"].includes(property)) return "color";
    if (property === "border-radius") return "radius";
    if (property === "font-size") return "fontSize";
    if (property === "font-weight") return "fontWeight";
    if (property === "line-height") return "lineHeight";
    if (property === "letter-spacing") return "letterSpacing";
    if (/^(padding|margin|gap|row-gap|column-gap|width|height|min-width|max-width|min-height|max-height)(-|$)/.test(property)) return "spacing";
    return undefined;
  };
  function walk(node: DesignNode) {
    for (const [property, binding] of Object.entries(node.bindings)) {
      const type = typeFor(property), value = node.styles[property];
      if (!binding.verified || !type || !value || value.includes("var(")) continue;
      const name = binding.candidates[0]!;
      if (!/^--[a-zA-Z_][\w-]*$/.test(name)) continue;
      candidates.push({ key: node.key, property, name, type, value });
    }
    node.children.forEach(walk);
  }
  walk(root);
  for (const candidate of candidates) {
    const collision = candidates.some(other => other.name === candidate.name && (other.type !== candidate.type || other.value !== candidate.value));
    const base = candidate.name.slice(2);
    let name = base + (collision ? `-fx-${digest([candidate.type, candidate.value]).slice(0, 8)}` : "");
    let suffix = 0;
    while (existing.has(`--${name}`) && existing.get(`--${name}`) !== candidate.value) {
      name = `${base}-fx-${digest([candidate.type, candidate.value]).slice(0, 8)}${suffix ? `-${suffix}` : ""}`;
      suffix++;
    }
    bindings[`${candidate.key}:${candidate.property}`] = `--${name}`;
    if (!tokens.some(token => token.name === name)) tokens.push({ name, type: candidate.type, value: candidate.type === "fontWeight" ? Number(candidate.value) : candidate.value, description: `Source ${candidate.name}; resolved for ${candidate.key}. Original token identity is retained by fx.` });
  }
  return { tokens, bindings };
}

export function serialize(root: DesignNode, token_bindings: Record<string, string> = {}, identity?: string) {
  const findings: Json[] = [];
  const manifest: { key: string; label: string; name: string; styles: Record<string, string>; width: number; height: number; rect?: DesignNode["rect"] }[] = [];
  function label(key: string, name: string, styles: Record<string, string>, width: number, height: number, rect?: DesignNode["rect"]) {
    if (!identity) return name;
    const value = `fx-source-${digest([identity, key]).slice(0, 32)}`;
    manifest.push({ key, label: value, name, styles, width, height, rect });
    return value;
  }
  function emit(node: DesignNode): string {
    if (node.svg) return node.svg_rendered ?? node.svg; // Preserve path data verbatim, never regenerate geometry.
    const styles = { ...node.styles };
    if (node.resolved_font_family) styles["font-family"] = JSON.stringify(node.resolved_font_family);
    for (const [property, binding] of Object.entries(node.bindings)) {
      const token = token_bindings[`${node.key}:${property}`];
      if (token) styles[property] = `var(${token})`;
      else findings.push({ kind: binding.candidates.length === 1 ? "binding-unverified" : "binding-ambiguous", key: node.key, property, ...binding });
    }
    const css = Object.entries(styles).filter(([, value]) => value !== "").map(([key, value]) => `${key}:${value}`).join(";");
    const attrs = `layer-name="${escape(label(node.key, node.name, node.styles, node.rect.width, node.rect.height, node.rect))}" style="${escape(css)}"`;
    if (node.image) return `<img ${attrs} src="${escape(node.image)}" />`;
    const decoration = (pseudo: "::before" | "::after") => (node.pseudo_elements ?? []).filter(box => box.pseudo === pseudo).map(box => {
      const paint = Object.entries(box.styles).filter(([, value]) => value !== "").map(([property, value]) => `${property}:${value}`).join(";");
      const name = `${node.name} ${pseudo} decoration`;
      // General pseudo geometry lacks a DOM rect. Only reuse the host rect for
      // the proven full-envelope case; never invent overlay coordinates.
      const width = parseFloat(box.styles.width ?? ""), height = parseFloat(box.styles.height ?? "");
      const rect = node.styles.position === "relative" && box.styles.left === "0px" && box.styles.top === "0px" && width === node.rect.width && height === node.rect.height ? node.rect : undefined;
      return `<div layer-name="${escape(label(`${node.key}/${pseudo}`, name, box.styles, width, height, rect))}" aria-hidden="true" style="${escape(paint)}"></div>`;
    }).join("");
    return `<div ${attrs}>${decoration("::before")}${escape(node.text)}${node.children.map(emit).join("")}${decoration("::after")}</div>`;
  }
  const html = emit(root);
  return { html, findings, manifest };
}

export function changes(base: any, current: any, path = ""): Json[] {
  if (JSON.stringify(base) === JSON.stringify(current)) return [];
  if (!base || !current || typeof base !== "object" || typeof current !== "object") return [{ path, before: base, after: current }];
  return [...new Set([...Object.keys(base), ...Object.keys(current)])].flatMap(key => changes(base[key], current[key], `${path}/${key}`));
}

export function threeWay(base: Json, canvas: Json, source: Json) {
  const design = changes(base, canvas), code = changes(base, source);
  const conflicts = design.filter(a => code.some(b => (a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`)) && JSON.stringify(a.after) !== JSON.stringify(b.after)));
  return { changes: design, conflicts };
}

/** Reject mixed-time evidence instead of turning it into a visual regression. */
export async function captureConsistently(browser: Pick<Browser, "evaluate" | "call">, selector: string, screenshot: string) {
  // Warm fonts/assets and install capture-only overlay suppression before observing.
  await browser.evaluate(`(${captureDocument.toString()})(${JSON.stringify(selector)})`);
  await browser.evaluate(`(() => {
    const guard = { epoch: 0 };
    const observer = new MutationObserver(records => {
      if (records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest('nextjs-portal')) return false;
        const nodes = [...record.addedNodes, ...record.removedNodes];
        return !(record.type === 'childList' && nodes.length && nodes.every(node => node instanceof Element && node.matches('nextjs-portal')));
      })) guard.epoch++;
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__fxCaptureGuard = guard;
    return true;
  })()`);
  for (let attempt = 0; attempt < 3; attempt++) {
    await browser.evaluate("new Promise(resolve => setTimeout(resolve, 500))");
    const epoch = await browser.evaluate("window.__fxCaptureGuard.epoch");
    const before = await browser.evaluate(`(${captureDocument.toString()})(${JSON.stringify(selector)})`);
    await browser.evaluate("new Promise(resolve => setTimeout(resolve, 300))");
    await browser.call("screenshot", selector, screenshot);
    const after = await browser.evaluate(`(${captureDocument.toString()})(${JSON.stringify(selector)})`);
    const finalEpoch = await browser.evaluate("window.__fxCaptureGuard.epoch");
    if (epoch === finalEpoch && digest(before) === digest(after)) return before;
  }
  throw new Error("Capture changed during import. Wait for a stable page state or supply ready_selector; no import was prepared.");
}

const tool = (name: string, description: string, properties: Json, required: string[] = [], readOnly = true) => ({ name, description, inputSchema: { type: "object", properties, required: required.filter(key => key !== "session_directory"), additionalProperties: false }, annotations: { readOnlyHint: readOnly } });
const string = { type: "string", minLength: 1 };
export const TOOLS = [
  tool("diff", "Capture a live source page and compare with Paper without editing either. Target accepts [node:ID] [URL] [--selector CSS] [--ready-selector CSS] [--width N] [--height N] [--session-storage JSON] [--local-storage JSON]. Without a URL, use an existing workspace link.", { session_directory: string, workspace: string, target: { type: "string" } }, ["session_directory"], false),
  tool("discover", "Discover source files, styles and assets. Supply workspace only; fx supplies the session directory.", { workspace: string, session_directory: string }, ["workspace", "session_directory"]),
  tool("capture_source", "Capture a consistent rendered page in an isolated browser. Does not inherit the user's tab state. Supply ready_selector for the intended settled state and explicit session_storage/local_storage string values when needed. Never guess ownership or authentication state.", { workspace: string, session_directory: string, url: string, selector: string, state_label: string, ready_selector: string, session_storage: { type: "object", additionalProperties: { type: "string" } }, local_storage: { type: "object", additionalProperties: { type: "string" } }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } }, ["workspace", "session_directory", "url", "selector"], false),
  tool("source_tree", "Read a bounded component outline. Follow next_offset for remaining nodes; exact assets and styles remain in the persisted capture used by import.", { session_directory: string, capture_id: string, offset: { type: "integer", minimum: 0 } }, ["session_directory", "capture_id"]),
  tool("prepare_import", "Prepare a captured page import. Call execute with each pending operation hash; fx sends the stored payload and records the real result.", { session_directory: string, capture_id: string, file_id: string }, ["session_directory", "capture_id"], false),
  tool("execute", "Execute one prepared operation by capture ID and operation hash. fx validates and authorizes its exact underlying Paper action. Inspect after each operation to discover the next step.", { session_directory: string, capture_id: string, operation_hash: string }, ["capture_id", "operation_hash"], false),
  tool("resolve_operation", "Host-only payload resolution. Agents use execute, not this endpoint.", { session_directory: string, capture_id: string, operation_hash: string }, ["capture_id", "operation_hash"]),
  tool("record_result", "Host-only receipt endpoint. fx records actual Paper results automatically; agents must not call this tool.", { session_directory: string, capture_id: string, operation_hash: string, result_json: string }, ["session_directory", "capture_id", "operation_hash", "result_json"], false),
  tool("preflight", "Validate exact prepared import operations; inspect failures before retrying.", { paperTool: string, argumentsJson: string, session_directory: string }, ["paperTool", "argumentsJson", "session_directory"], false),
  tool("inspect", "List persisted captures, artboards and outstanding import operations.", { session_directory: string }, ["session_directory"]),
  tool("compare", "Read the current Paper artboard and compare it against its baseline. Returns source search candidates and concurrent source edits; does not write code.", { session_directory: string, capture_id: string }, ["capture_id"]),
  tool("check", "Read Paper and check the current workflow phase. Design edits are differences, not import regressions.", { session_directory: string, capture_id: string, nodeId: string, fileId: string }, ["session_directory"]),
  tool("verify", "Verify an imported artboard against its source screenshot, or inspect intentional design changes. Never claims fidelity with unresolved findings.", { session_directory: string, capture_id: string }, ["session_directory", "capture_id"], false),
  tool("prepare_edit", "Prepare an exact targeted Paper edit after a verified import. Existing source identity and baseline survive intentional changes.", { session_directory: string, capture_id: string, paper_tool: string, arguments: { type: "object" } }, ["session_directory", "capture_id", "paper_tool", "arguments"], false),
];

export class Adapter {
  constructor(readonly inspector = new Inspector()) {}
  async close() { await this.inspector.close(); }
  async freshDiff(store: Store, args: Json, parameters: Json, previous?: DesignRecord) {
    const paper = new PaperReader();
    await paper.initialize();
    const info = paperObject(await paper.read("get_basic_info", {}));
    const fileId = typeof info.url === "string" ? new URL(info.url).pathname.split("/")[2] : undefined;
    if (!fileId) return { status: "blocked", message: "Open a Paper file first." };
    let nodeId = parameters.target.startsWith("node:") ? parameters.target.slice(5) : previous?.artboard_id;
    if (!nodeId) {
      const selection = paperObject(await paper.read("get_selection", {}));
      if (selection.selectedNodes?.length !== 1) return { status: "blocked", message: "Select one Paper node or supply node:ID." };
      nodeId = selection.selectedNodes[0].id;
    }
    const file = previous?.file_id ?? fileId;
    const board = file === fileId && Array.isArray(info.artboards) ? info.artboards.find((entry: Json) => entry.id === nodeId) : undefined;
    // Confirm the target before launching a browser. No Paper writes are used.
    await paper.read("get_node_info", { nodeId, fileId: file });
    const captured = await this.call("capture_source", {
      session_directory: args.session_directory, workspace: args.workspace ?? previous?.workspace,
      url: parameters.url ?? previous?.url, selector: parameters.selector ?? previous?.selector ?? "body",
      width: parameters.width ?? previous?.viewport.width ?? board?.width ?? 1440, height: parameters.height ?? previous?.viewport.height ?? board?.height ?? 900,
      ready_selector: parameters.ready_selector, session_storage: parameters.session_storage, local_storage: parameters.local_storage,
      fresh: true,
    });
    const source = await store.load(captured.capture_id);
    // A comparison owns a separate record; never rebind or alter an imported design.
    const comparison = { ...source, id: randomUUID(), artboard_id: nodeId, file_id: file, operations: [] };
    await store.save(comparison);
    return this.compareCapture(store, comparison);
  }
  async compareCapture(store: Store, record: DesignRecord) {
    if (record.capture_context?.policy !== 3) return { status: "blocked", message: "Recapture the intended page state before comparing." };
    if (record.operations.some(operation => operation.status !== "applied")) return { status: "blocked", message: "Finish the import before comparing." };
    const paper = new PaperReader();
    await paper.initialize();
    const canvas = await paper.snapshot(record.artboard_id!, record.file_id);
    const source_image = `data:image/png;base64,${(await readFile(record.screenshot)).toString("base64")}`;
    const visual = await compareImages(source_image, canvas.image);
    const inspector = await this.publish(store, record, visual.match ? "verified" : "needs-repair", "Comparison", { source_image, canvas_image: canvas.image, canvas_revision: digest(canvas), visual });
    return inspector.unavailable ? { status: "blocked", message: "Viewer unavailable." } : { status: "ready", url: inspector.url };
  }
  private async publish(store: Store, record: DesignRecord, state: VerificationSnapshot["state"], message: string, evidence: Partial<VerificationSnapshot> = {}) {
    const nodes: DesignNode[] = [];
    const walk = (node: DesignNode) => { nodes.push(node); node.children.forEach(walk); };
    walk(record.root);
    record.verification = {
      ...record.verification, version: 1, capture_id: record.id, phase: record.phase, state,
      source_url: record.url, source_revision: record.source_revision, artboard_id: record.artboard_id,
      file_id: record.file_id, canvas_revision: record.canvas_revision, checked_at: new Date().toISOString(), message,
      findings: record.findings.map(finding => {
        const node = nodes.find(node => node.key === finding.key);
        return { kind: finding.kind, property: finding.property, key: finding.key, ...(node ? { rect: { ...node.rect, x: node.rect.x - record.root.rect.x, y: node.rect.y - record.root.rect.y } } : {}) };
      }), ...evidence,
    };
    await store.save(record);
    try { return await this.inspector.publish(store.directory, record.verification); }
    catch { return { state, phase: record.phase, message: "Visual inspector unavailable; evidence is saved", url: "", auto_open: false, unavailable: true }; }
  }
  async call(name: string, args: Json): Promise<Json> {
    const spec = TOOLS.find(tool => tool.name === name);
    if (!spec) throw new Error(`Unknown design operation: ${name}`);
    for (const key of spec.inputSchema.required) if (args[key] === undefined || args[key] === "") throw new Error(`Missing ${key}`);
    const directory = resolve(args.session_directory);
    if (!isAbsolute(args.session_directory)) throw new Error("Session directory must be absolute");
    const store = new Store(join(directory, "design"));
    if (name === "diff") {
      let parameters: Json;
      try { parameters = parseDiffParameters(String(args.target ?? "")); }
      catch (error) { return { status: "blocked", message: (error as Error).message }; }
      if (parameters.url) return this.freshDiff(store, args, parameters);
      const stores = [store];
      const workspace = args.workspace ? await realpath(args.workspace) : undefined;
      // Session directories are host-bound. Search only sibling sessions in this profile,
      // and retain the owning store so evidence is never moved into the new session.
      if (workspace) for (const entry of await readdir(dirname(directory), { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== directory.split(/[\\/]/).pop()) stores.push(new Store(join(dirname(directory), entry.name, "design")));
      }
      const owners = new Map<DesignRecord, Store>();
      for (const owner of stores) {
        for (const record of await owner.list().catch(() => [])) {
          if (!record.artboard_id) continue;
          if (workspace && await realpath(record.workspace).catch(() => undefined) !== workspace) continue;
          owners.set(record, owner);
        }
      }
      let records = [...owners.keys()];
      const target = parameters.target;
      if (target.startsWith("capture:")) records = records.filter(record => record.id === target.slice(8));
      else if (target.startsWith("node:")) records = records.filter(record => record.artboard_id === target.slice(5));
      else if (target) records = records.filter(record => new URL(record.url).pathname === target);
      else if (records.length) {
        const paper = new PaperReader();
        await paper.initialize();
        const selection = paperObject(await paper.read("get_selection", {}));
        if (!Array.isArray(selection.selectedNodes)) throw new Error("Paper returned an invalid selection");
        if (selection.selectedNodes.length > 1) return { status: "blocked", message: "Select one artboard or use /diff capture:ID." };
        if (selection.selectedNodes.length) {
          const info = paperObject(await paper.read("get_basic_info", {}));
          const fileId = typeof info.url === "string" ? new URL(info.url).pathname.split("/")[2] : undefined;
          if (!fileId) throw new Error("Cannot identify the selected Paper file");
          records = records.filter(record => (!record.file_id || record.file_id === fileId) && selection.selectedNodes.some((node: Json) => node.id === record.artboard_id));
        }
        else records.sort((a, b) => (b.verification?.checked_at ?? "").localeCompare(a.verification?.checked_at ?? ""));
        if (!selection.selectedNodes.length && records.length > 1 && records[0].verification?.checked_at && records[0].verification.checked_at !== records[1].verification?.checked_at) records = records.slice(0, 1);
      }
      if (!records.length) return { status: "blocked", message: "Supply a source: /diff node:ID http://localhost:3000/path" };
      if (records.length !== 1) return { status: "blocked", message: "Choose a capture: " + records.map(record => `/diff capture:${record.id}`).join(" · ") };
      const record = records[0];
      return this.freshDiff(store, args, parameters, record);
    }
    if (name === "discover") {
      const source = await inventory(args.workspace);
      return { version: VERSION, status: "discovered", workspace: source.root, source_revision: source.revision, files: Object.keys(source.files), tools: TOOLS.map(tool => tool.name) };
    }
    if (name === "inspect") return { version: VERSION, captures: (await store.list()).map(({ id, url, phase, artboard_id, operations, findings, verification }) => ({ id, url, phase, artboard_id, operations, findings, verification: verification ? { state: verification.state, checked_at: verification.checked_at, message: verification.message } : undefined })) };
    if (name === "capture_source") {
      const source = await inventory(args.workspace), url = new URL(args.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Capture requires an HTTP page");
      const id = randomUUID(), browser = new Browser(`fx-design-${id}`);
      const viewport = { width: args.width ?? 1440, height: args.height ?? 900 };
      await mkdir(store.directory, { recursive: true });
      try {
        await browser.call("open", url.href);
        await browser.call("set", "viewport", String(viewport.width), String(viewport.height));
        if (args.session_storage || args.local_storage) {
          for (const values of [args.session_storage, args.local_storage]) if (values && (typeof values !== "object" || Array.isArray(values) || Object.values(values).some(value => typeof value !== "string"))) throw new Error("Capture storage values must be strings");
          await browser.evaluate(`(() => {
            if (location.origin !== ${JSON.stringify(url.origin)}) throw new Error('Capture redirected to another origin; state was not applied');
            for (const [key, value] of Object.entries(${JSON.stringify(args.session_storage ?? {})})) sessionStorage.setItem(key, value);
            for (const [key, value] of Object.entries(${JSON.stringify(args.local_storage ?? {})})) localStorage.setItem(key, value);
            return true;
          })()`);
          await browser.call("open", url.href);
        }
        if (args.ready_selector) await browser.evaluate(`(async () => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const node = document.querySelector(${JSON.stringify(args.ready_selector)});
            if (node && node.getBoundingClientRect().width && node.getBoundingClientRect().height) return true;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error('Intended capture state did not become ready');
        })()`);
        const temporary_screenshot = join(store.directory, `${id}.capture.png`);
        const snapshot = await captureConsistently(browser, args.selector, temporary_screenshot);
        if (args.ready_selector && !await browser.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(args.ready_selector)}); return !!(node && node.getBoundingClientRect().width && node.getBoundingClientRect().height); })()`)) throw new Error("Intended capture state changed during capture");
        const capture_context = { policy: 3, state_label: args.state_label ?? (args.session_storage || args.local_storage ? "explicit prepared state" : "isolated default state"), state_fingerprint: digest({ session: args.session_storage ?? {}, local: args.local_storage ?? {} }), ready_selector: args.ready_selector };
        const font_evidence: NonNullable<DesignRecord["font_evidence"]> = [];
        for (const asset of snapshot.font_assets ?? []) {
          try {
            const bytes = Buffer.from(asset.data.slice(asset.data.indexOf(",") + 1), "base64");
            font_evidence.push({ alias: asset.alias, url: asset.url, family: fontFamily(bytes), sha256: createHash("sha256").update(bytes).digest("hex") });
          } catch (error) { snapshot.findings.push({ kind: "font-identity-unresolved", alias: asset.alias, message: String(error) }); }
        }
        const resolveFonts = (node: DesignNode) => {
          const alias = node.styles["font-family"]?.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
          const families = new Set(font_evidence.filter(face => face.alias === alias).map(face => face.family));
          if (families.size === 1) node.resolved_font_family = [...families][0];
          else if (families.size > 1) snapshot.findings.push({ kind: "font-identity-ambiguous", alias });
          node.children.forEach(resolveFonts);
        };
        resolveFonts(snapshot.root);
        const capture_id = args.fresh ? randomUUID() : digest({ capture_context, workspace: source.root, source_revision: source.revision, url: url.href, selector: args.selector, viewport, root: snapshot.root });
        try {
          const existing = await store.load(capture_id);
          return { version: VERSION, status: "captured", capture_id: existing.id, source_revision: existing.source_revision, screenshot: existing.screenshot, findings: existing.findings, reused: true };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const screenshot = join(store.directory, `${capture_id}.png`);
        await rename(temporary_screenshot, screenshot);
        const record: DesignRecord = { version: VERSION, id: capture_id, workspace: source.root, source_revision: source.revision, source_files: source.files, source_index: await sourceIndex(source.root, source.files), url: url.href, selector: args.selector, viewport, root: snapshot.root, screenshot, findings: snapshot.findings, phase: "import", operations: [] };
        record.font_evidence = font_evidence;
        record.capture_context = capture_context;
        await store.save(record);
        return { version: VERSION, status: "captured", capture_id, source_revision: record.source_revision, screenshot, findings: record.findings };
      } finally { await browser.call("close").catch(() => undefined); await rm(join(store.directory, `${id}.capture.png`), { force: true }); }
    }
    if (name === "preflight") {
      const arguments_ = JSON.parse(args.argumentsJson);
      const hash = digest({ tool: args.paperTool, arguments: arguments_ });
      const records = await store.list();
      for (const record of records) {
        const operation = record.operations.find(operation => operation.status !== "applied");
        if (operation?.hash !== hash || operation.status !== "pending") continue;
        if (record.phase === "import" && record.capture_context?.policy !== 3) throw new Error("Capture predates state-consistency checks; recapture before importing");
        const source = await inventory(record.workspace);
        if (source.revision !== record.source_revision) throw new Error("Source changed since capture; recapture before importing");
        if (record.phase === "design") {
          const paper = new PaperReader();
          await paper.initialize();
          await validateEditTargets(record, operation.tool, operation.arguments, paper);
        }
        operation.status = "started";
        await store.save(record);
        return { version: VERSION, status: "clean", capture_id: record.id, source_revision: source.revision, operation_hash: hash };
      }
      return { version: VERSION, status: "blocked", findings: [{ kind: "unprepared-operation", message: "Prepare the exact import operation first. An interrupted operation must be reconciled before retrying." }] };
    }
    const record = args.capture_id ? await store.load(args.capture_id) : (await store.list()).find(record => record.artboard_id === args.nodeId && (!args.fileId || record.file_id === args.fileId));
    if (!record) throw new Error("No matching captured artboard; supply capture_id");
    if ((name === "prepare_import" || ((name === "resolve_operation" || name === "check" || name === "verify") && record.phase === "import")) && record.capture_context?.policy !== 3) {
      const message = "Capture predates state-consistency checks. Recapture the intended page state before importing or evaluating fidelity.";
      const inspector = await this.publish(store, record, "outdated", message);
      return { version: VERSION, status: "blocked", reason: "capture-state-unverified", capture_id: record.id, message, inspector, fidelity_claim: false };
    }
    if (name === "execute") throw new Error("Prepared operations must be executed through the fx host");
    if (name === "resolve_operation") {
      const operation = record.operations.find(operation => operation.status !== "applied");
      if (!operation || operation.status !== "pending" || operation.hash !== args.operation_hash) throw new Error("Operation is not the next pending action; inspect or reconcile before continuing");
      if (digest({ tool: operation.tool, arguments: operation.arguments }) !== operation.hash) throw new Error("Stored operation integrity mismatch");
      return operation;
    }
    if (name === "check" || name === "verify") {
      for (const operation of record.operations.filter(operation => operation.status === "started")) {
        if (!/^[a-f0-9]{64}$/.test(operation.hash)) throw new Error("Invalid receipt identity");
        let receipt: string;
        try { receipt = await readFile(join(store.directory, `${record.id}-${operation.hash}.receipt`), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        await this.call("record_result", { session_directory: directory, capture_id: record.id, operation_hash: operation.hash, result_json: receipt });
        Object.assign(record, await store.load(record.id));
      }
      if (record.operations.some(operation => operation.status !== "applied")) {
        const inspector = await this.publish(store, record, "building", "Import section is still being built; differences are not failures yet.");
        if (name === "check") return { version: VERSION, status: "pending", capture_id: record.id, source_revision: record.source_revision, inspector, message: "Record the Paper result, then verify the completed operation group." };
        throw new Error("Record the outstanding Paper result before verification");
      }
      if (!record.artboard_id) throw new Error("No imported artboard to verify");
      await this.publish(store, record, "checking", "Comparing the completed operation group against its baseline.");
      try {
      const paper = new PaperReader();
      await paper.initialize();
      const canvas = await paper.snapshot(record.artboard_id, record.file_id);
      const canvas_revision = digest(canvas);
      const outstanding = async () => (await store.list()).filter(item => item.operations.some(operation => operation.status !== "applied") || item.operations.filter(operation => operation.status === "applied").length > (item.verified_operations ?? 0)).length;
      if (record.phase === "design") {
        {
          record.verified_operations = record.operations.filter(operation => operation.status === "applied").length;
          record.canvas_revision = canvas_revision;
          await store.save(record);
        }
        const inspector = await this.publish(store, record, "verified", "Intentional design changes recorded. This is not an import-fidelity claim and no code was changed.", { canvas_image: canvas.image, canvas_revision });
        return { version: VERSION, status: "clean", phase: "design", capture_id: record.id, artboard_id: record.artboard_id, source_revision: record.source_revision, canvas_revision, pending_verifications: await outstanding(), inspector, changes: changes(record.baseline, { nodes: canvas.nodes, jsx: canvas.jsx }), fidelity_claim: false };
      }
      const source = await inventory(record.workspace);
      if (source.revision !== record.source_revision) throw new Error("Source changed since capture");
      const source_image = `data:image/png;base64,${(await readFile(record.screenshot)).toString("base64")}`;
      const visual = await compareImages(source_image, canvas.image);
      let properties: PropertyComparison = { status: "unverified", scope: "dimensions-and-borders", checked_properties: 0, findings: [{ kind: "property-unverified", provenance: "computed-properties", key: "", property: "import-mapping" }], fidelity_claim: false };
      if (record.source_manifest?.length && record.file_id) {
        const browser = new Browser(`fx-design-properties-${randomUUID()}`);
        try {
          await browser.call("open", "about:blank");
          properties = await readBoundProperties(record.source_manifest, record.source_bindings ?? [], { capture_id: record.id, artboard_id: record.artboard_id, source_revision: record.source_revision, file_id: record.file_id }, (tool, arguments_) => paper.read(tool, arguments_), rows => browser.evaluate(`(${normalizePropertyStyles.toString()})(${JSON.stringify(rows)})`));
          const after = await paper.read("get_jsx", { nodeId: record.artboard_id, fileId: record.file_id });
          if (digest(after) !== digest(canvas.jsx)) throw new Error("Paper changed during property verification");
        } finally { await browser.call("close").catch(() => undefined); }
      }
      const status = visual.match && properties.status === "match" && record.findings.length === 0 ? "clean" : "regression";
      if (status === "clean") {
        record.baseline = { nodes: canvas.nodes, jsx: canvas.jsx };
        record.canvas_revision = canvas_revision;
        record.phase = "design";
        record.verified_operations = record.operations.filter(operation => operation.status === "applied").length;
        await store.save(record);
      }
      const inspector = await this.publish(store, record, status === "clean" ? "verified" : "needs-repair", status === "clean" ? "Whole-surface import verification passed." : "Import differences remain. Review the comparison before handoff.", { phase: "import", source_image, canvas_image: canvas.image, canvas_revision, visual, findings: [...record.findings, ...properties.findings] });
      return { version: VERSION, status, phase: "import", capture_id: record.id, artboard_id: record.artboard_id, source_revision: source.revision, canvas_revision, pending_verifications: await outstanding(), inspector, visual, properties, findings: [...record.findings, ...properties.findings], fidelity_claim: status === "clean" };
      } catch (error) {
        await this.publish(store, record, "outdated", "Verification could not finish. The previous evidence must not be treated as current.");
        throw error;
      }
    }
    if (name === "prepare_edit") {
      if (record.phase !== "design" || !record.baseline) throw new Error("Verify the initial import before editing its design");
      if (!["mcp_paper_update_styles", "mcp_paper_set_text_content", "mcp_paper_rename_nodes", "mcp_paper_move_nodes", "mcp_paper_duplicate_nodes", "mcp_paper_delete_nodes"].includes(args.paper_tool)) throw new Error("Unsupported design edit; existing vector assets must be reused");
      const paper = new PaperReader();
      await paper.initialize();
      await validateEditTargets(record, args.paper_tool, args.arguments, paper);
      const next = { tool: args.paper_tool, arguments: args.arguments };
      const hash = digest(next);
      const existing = record.operations.find(operation => operation.hash === hash && operation.status !== "applied");
      if (!existing) record.operations.push({ ...next, hash, status: "pending" });
      await store.save(record);
      return { version: VERSION, status: "prepared", capture_id: record.id, operation: existing ?? record.operations.at(-1) };
    }
    if (name === "source_tree") {
      const nodes: Json[] = [];
      const walk = (node: DesignNode) => {
        nodes.push({ key: node.key, name: node.name.slice(0, 120), tag: node.tag, rect: node.rect, text: node.text.slice(0, 160), asset: node.svg ? "svg" : node.image ? "image" : undefined, children: node.children.length });
        node.children.forEach(walk);
      };
      walk(record.root);
      const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
      return { version: VERSION, capture_id: record.id, nodes: nodes.slice(offset, offset + 40), total_nodes: nodes.length, next_offset: offset + 40 < nodes.length ? offset + 40 : null, finding_count: record.findings.length };
    }
    if (name === "prepare_import") {
      if (record.operations.length) return { version: VERSION, capture_id: record.id, operations: record.operations, artboard_id: record.artboard_id };
      const families = [...new Set((record.font_evidence ?? []).map(face => face.family))];
      if (families.length) {
        const paper = new PaperReader();
        await paper.initialize();
        const available = paperObject(await paper.read("get_font_family_info", { familyNames: families }));
        for (const family of families) {
          if (!available.fontsPerFamily?.[family]?.length) throw new Error(`Source font is not available in Paper: ${family}`);
        }
      }
      const vocabulary = collectTokens(record.root);
      record.tokens = vocabulary.tokens;
      record.token_bindings = vocabulary.bindings;
      const rendered = serialize(record.root, record.token_bindings);
      record.findings.push(...rendered.findings);
      record.file_id = args.file_id;
      if (record.tokens.length) {
        const paper = new PaperReader();
        await paper.initialize();
        const current = await paper.read("get_tokens", { format: "css", ...(record.file_id ? { fileId: record.file_id } : {}) });
        const css = (current.content ?? []).filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("\n");
        const existing = new Map(Array.from(css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g), (match: any) => [match[1], match[2].trim()]));
        const reconciled = collectTokens(record.root, existing);
        record.tokens = reconciled.tokens;
        record.token_bindings = reconciled.bindings;
        const missing = record.tokens.filter(token => !existing.has(`--${token.name}`));
        if (missing.length) {
          const seed = { tool: "mcp_paper_create_tokens", arguments: { tokens: missing.map(token => ({ ...token, name: `--${token.name}` })), ...(record.file_id ? { fileId: record.file_id } : {}) } };
          record.operations.push({ ...seed, hash: digest(seed), status: "pending" });
        }
      }
      const arguments_ = { name: new URL(record.url).pathname, styles: { width: `${record.root.rect.width}px`, height: `${record.root.rect.height}px` }, ...(record.file_id ? { fileId: record.file_id } : {}) };
      const operation = { tool: "mcp_paper_create_artboard", arguments: arguments_ };
      record.operations.push({ ...operation, hash: digest(operation), status: "pending" });
      await store.save(record);
      return { version: VERSION, status: "prepared", capture_id: record.id, findings: record.findings, operations: record.operations };
    }
    if (name === "record_result") {
      const operation = record.operations.find(operation => operation.hash === args.operation_hash);
      if (!operation) throw new Error("Unknown import operation");
      if (operation.status === "applied") return { version: VERSION, status: "already-recorded", capture_id: record.id };
      if (operation.status !== "started") throw new Error("Operation was not admitted by fx");
      const result = JSON.parse(args.result_json);
      if (!result || typeof result !== "object" || result.isError || result.error) throw new Error("Paper did not return a successful structured result");
      const hasFailure = (value: any): boolean => Boolean(value && typeof value === "object" && (value.result === "error" || value.error || (Array.isArray(value.ignoredStyles) && value.ignoredStyles.length) || Object.values(value).some(item => item && typeof item === "object" && hasFailure(item))));
      if (hasFailure(result)) throw new Error("Paper reported a partial or ignored operation; reconcile before continuing");
      if (operation.tool === "mcp_paper_create_artboard") {
        const nodeId = result.nodeId ?? result.id;
        if (typeof nodeId !== "string" || !nodeId) throw new Error("Paper result requires its artboard node ID");
        record.artboard_id = nodeId;
        const serialized = serialize(record.root, record.token_bindings, record.id);
        record.source_manifest = serialized.manifest;
        const next = { tool: "mcp_paper_write_html", arguments: { targetNodeId: nodeId, mode: "insert-children", html: serialized.html, ...(record.file_id ? { fileId: record.file_id } : {}) } };
        record.operations.push({ ...next, hash: digest(next), status: "pending" });
      }
      if (operation.tool === "mcp_paper_write_html" && record.source_manifest && record.artboard_id && operation.arguments.targetNodeId === record.artboard_id) {
        const mapped = bindImportReceipt(record.source_manifest, result, { capture_id: record.id, artboard_id: record.artboard_id, file_id: record.file_id, source_revision: record.source_revision, operation_hash: operation.hash });
        record.source_bindings = mapped.bindings;
        if (mapped.renames.length) {
          const next = { tool: "mcp_paper_rename_nodes", arguments: { updates: mapped.renames, ...(record.file_id ? { fileId: record.file_id } : {}) } };
          record.operations.push({ ...next, hash: digest(next), status: "pending" });
        }
      }
      operation.status = "applied";
      operation.result = result;
      await this.publish(store, record, record.operations.some(operation => operation.status !== "applied") ? "building" : "outdated", "Paper changed; waiting for the host checkpoint.");
      return { version: VERSION, status: "recorded", capture_id: record.id, artboard_id: record.artboard_id };
    }
    if (name === "compare") {
      const current = await inventory(record.workspace);
      if (!record.baseline) return { version: VERSION, status: "blocked", findings: [{ kind: "baseline-missing", message: "The imported Paper artboard has not been verified and recorded." }] };
      if (!record.artboard_id) throw new Error("Missing source artboard");
      const paper = new PaperReader();
      await paper.initialize();
      const canvas = await paper.snapshot(record.artboard_id, record.file_id);
      return { version: VERSION, capture_id: record.id, status: current.revision === record.source_revision ? "compared" : "source-changed", changes: changes(record.baseline, { nodes: canvas.nodes, jsx: canvas.jsx }), source_changes: changes(record.source_files, current.files), source_revision: current.revision, source_candidates: record.source_index, source_mapping_verified: false };
    }
    throw new Error("Unsupported operation");
  }
}

export async function serve() {
  const adapter = new Adapter(new Inspector(true));
  try {
  // Serial execution prevents concurrent read-modify-write races in session state.
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request: Json;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    let result: Json;
    try {
      if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fx-design", version: String(VERSION) } };
      else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools: TOOLS };
      else if (request.method === "tools/call") {
        try {
          const output = await adapter.call(request.params.name, request.params.arguments ?? {});
          if (request.params.name !== "resolve_operation") {
            // Public workflow results expose handles, never mutation payloads for
            // the model to reconstruct. Captures remain independently inspectable.
            const redact = (value: any): void => {
              if (!value || typeof value !== "object") return;
              if (typeof value.hash === "string" && typeof value.tool === "string") {
                delete value.arguments;
                delete value.result;
              }
              if (Array.isArray(value.findings)) {
                value.finding_count = value.findings.length;
                value.findings = value.findings.slice(0, 12).map((finding: Json) => ({ kind: finding.kind, key: finding.key, property: finding.property }));
                value.findings_truncated = value.finding_count > value.findings.length;
              }
              for (const item of Object.values(value)) redact(item);
            };
            redact(output);
          }
          result = { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
        } catch (error) {
          result = { isError: true, content: [{ type: "text", text: JSON.stringify({ version: VERSION, status: "blocked", message: String(error) }) }] };
        }
      } else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue; }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error) } }) + "\n"); }
  }
  } finally { await adapter.close(); }
}
if (import.meta.main) await serve();
