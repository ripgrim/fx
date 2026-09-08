import { describe, expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { Adapter, Store, PaperReader, parseDiffParameters, fontFamily, collectTokens, digest, inventory, serialize, threeWay, validateEditTargets, type DesignRecord } from "./helper";

const record = (workspace: string): DesignRecord => ({
  capture_context: { policy: 3, state_label: "test fixture", state_fingerprint: "fixture" },
  version: 1, id: "capture", workspace, source_revision: "revision", source_files: {},
  url: "http://localhost:3000/demo", selector: "main", viewport: { width: 1440, height: 900 },
  root: { key: "0", name: "Header", tag: "div", text: "A & B", styles: { display: "flex" }, bindings: {}, rect: { x: 0, y: 0, width: 1440, height: 900 }, children: [] },
  screenshot: "source.png", findings: [], phase: "import", operations: [],
});

describe("persistent design workflow", () => {
  test("Paper comparison requests a native PNG export and rejects disguised JPEG", async () => {
    const root = await mkdtemp(join(tmpdir(), "fx-paper-png-"));
    const path = join(root, "board.png");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZkAAAAASUVORK5CYII=", "base64");
    await writeFile(path, png);
    const read = spyOn(PaperReader.prototype, "read").mockImplementation(async (name, args) => {
      if (name === "export") {
        expect(args).toEqual({ type: "image", nodes: { board: [{ format: "png", scale: "1x" }] }, fileId: "file" });
        return { content: [{ type: "text", text: JSON.stringify({ exports: [{ nodeId: "board", filePath: path }] }) }] };
      }
      expect(["get_node_info", "get_jsx"]).toContain(name);
      return {};
    });
    try {
      expect((await new PaperReader().snapshot("board", "file")).image).toBe(`data:image/png;base64,${png.toString("base64")}`);
      await writeFile(path, Buffer.from([255, 216, 255, 224]));
      await expect(new PaperReader().snapshot("board", "file")).rejects.toThrow("not PNG");
    } finally { read.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
  test("diff parameters accept explicit source, node, selector, and page state", () => {
    expect(parseDiffParameters('node:board http://localhost:3000/demo --selector "main > section" --session-storage \'{"owned":"true"}\' --height 1000')).toEqual({ target: "node:board", url: "http://localhost:3000/demo", selector: "main > section", session_storage: { owned: "true" }, height: 1000 });
    expect(() => parseDiffParameters('--height nope')).toThrow("Viewport");
    expect(() => parseDiffParameters('--unknown value')).toThrow("Use /diff");
    expect(() => parseDiffParameters('--selector "main')).toThrow("quoted");
  });
  test("diff finds workspace imports across sessions and keeps evidence with its owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "fx-diff-sessions-"));
    const directory = join(root, "sessions", "new");
    const workspace = join(root, "project");
    await mkdir(directory, { recursive: true });
    await mkdir(workspace);
    const owner = new Store(join(root, "sessions", "old", "design"));
    const source = { ...record(workspace), artboard_id: "board", file_id: "file", source_revision: (await inventory(workspace)).revision };
    await owner.save(source);
    const adapter = new Adapter();
    const compare = spyOn(adapter, "freshDiff").mockResolvedValue({ status: "ready" });
    const initialize = spyOn(PaperReader.prototype, "initialize").mockResolvedValue(undefined);
    const read = spyOn(PaperReader.prototype, "read").mockImplementation(async name => ({ content: [{ type: "text", text: JSON.stringify(name === "get_selection" ? { selectedNodes: [{ id: "board" }] } : { url: "https://app.paper.design/file/file/page" }) }] }));
    try {
      for (const target of ["", "node:board", "capture:capture", "/demo"]) {
        expect((await adapter.call("diff", { session_directory: directory, workspace, target })).status).toBe("ready");
        expect(compare.mock.calls.at(-1)![3]!.id).toBe(source.id);
      }
      expect(await new Store(join(directory, "design")).list()).toEqual([]);
      const foreign = join(root, "other-project");
      await mkdir(foreign);
      expect((await adapter.call("diff", { session_directory: directory, workspace: foreign, target: "node:board" })).message).toContain("Supply a source");
      delete source.capture_context;
      await owner.save(source);
      expect((await adapter.call("diff", { session_directory: directory, workspace, target: "node:board" })).status).toBe("ready");
      expect(compare).toHaveBeenCalledTimes(5);
    } finally { compare.mockRestore(); initialize.mockRestore(); read.mockRestore(); await adapter.close(); await rm(root, { recursive: true }); }
  });
  test("diff resolves linked targets and refuses ambiguous or unmapped selections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fx-diff-command-"));
    const adapter = new Adapter();
    let selectedNodes: { id: string }[] = [];
    const initialized = spyOn(PaperReader.prototype, "initialize").mockResolvedValue(undefined);
    const read = spyOn(PaperReader.prototype, "read").mockImplementation(async name => {
      if (name === "get_basic_info") return { content: [{ type: "text", text: JSON.stringify({ url: "https://app.paper.design/file/file/page" }) }] };
      expect(name).toBe("get_selection");
      return { content: [{ type: "text", text: JSON.stringify({ selectedNodes }) }] };
    });
    const calls = spyOn(adapter, "freshDiff").mockResolvedValue({ status: "ready", url: "http://127.0.0.1:1234/a/view" });
    try {
      const source = record(directory);
      source.source_revision = (await inventory(directory)).revision;
      source.artboard_id = "artboard";
      source.file_id = "file";
      await new Store(join(directory, "design")).save(source);
      // Inventory ignores the generated design evidence only when outside the workspace.
      const args = { session_directory: directory, target: "node:artboard" };
      source.workspace = await mkdtemp(join(tmpdir(), "fx-diff-source-"));
      try {
        source.source_revision = (await inventory(source.workspace)).revision;
        await new Store(join(directory, "design")).save(source);
        expect((await adapter.call("diff", args)).status).toBe("ready");
        selectedNodes = [{ id: "foreign" }];
        expect((await adapter.call("diff", { ...args, target: "" })).status).toBe("blocked");
        selectedNodes = [{ id: "artboard" }, { id: "foreign" }];
        expect((await adapter.call("diff", { ...args, target: "" })).status).toBe("blocked");
        selectedNodes = [{ id: "artboard" }];
        expect((await adapter.call("diff", { ...args, target: "" })).status).toBe("ready");
      } finally { await rm(source.workspace, { recursive: true }); }
    } finally { calls.mockRestore(); read.mockRestore(); initialized.mockRestore(); await adapter.close(); await rm(directory, { recursive: true }); }
  });
  test("legacy captures cannot be admitted as state-consistent imports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fx-legacy-state-"));
    const adapter = new Adapter();
    try {
      const source = record(directory);
      delete source.capture_context;
      await new Store(join(directory, "design")).save(source);
      const result = await adapter.call("prepare_import", { session_directory: directory, capture_id: source.id });
      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("capture-state-unverified");
      expect((await new Store(join(directory, "design")).load(source.id)).operations).toEqual([]);
    } finally { await adapter.close(); await rm(directory, { recursive: true }); }
  });
  test("font identity comes from WOFF2 metadata and survives serialization", () => {
    const name = Buffer.from("Evidence Sans", "utf16le").swap16();
    const table = Buffer.alloc(18 + name.length);
    table.writeUInt16BE(1, 2); table.writeUInt16BE(18, 4);
    table.writeUInt16BE(3, 6); table.writeUInt16BE(1, 8); table.writeUInt16BE(0x409, 10);
    table.writeUInt16BE(16, 12); table.writeUInt16BE(name.length, 14); name.copy(table, 18);
    const compressed = brotliCompressSync(table);
    const header = Buffer.alloc(48);
    header.write("wOF2"); header.writeUInt32BE(0x10000, 4); header.writeUInt16BE(1, 12);
    header.writeUInt32BE(compressed.length, 20);
    const font = Buffer.concat([header, Buffer.from([5, table.length]), compressed]);
    expect(fontFamily(font)).toBe("Evidence Sans");
    expect(() => fontFamily(font.subarray(0, 49))).toThrow();
    const source = record("workspace");
    source.root.styles["font-family"] = "arbitrary-alias";
    source.root.resolved_font_family = fontFamily(font);
    expect(serialize(source.root).html).toContain("Evidence Sans");
    expect(source.root.styles["font-family"]).toBe("arbitrary-alias");
  });
  test("prepared edits require live membership in the linked file and artboard", async () => {
    const source = { ...record("workspace"), file_id: "file", artboard_id: "root" };
    let detached = false;
    const paper = { async read(_name: string, args: any) {
      expect(args.fileId).toBe("file");
      return { content: [{ type: "text", text: JSON.stringify({ children: args.nodeId === "root" && !detached ? [{ id: "header" }] : [] }) }] };
    } };
    const args = { fileId: "file", updates: [{ nodeId: "header", styles: { color: "var(--ink)" } }] };
    await validateEditTargets(source, "mcp_paper_update_styles", args, paper);
    await expect(validateEditTargets(source, "mcp_paper_update_styles", { ...args, fileId: "other" }, paper)).rejects.toThrow("linked Paper file");
    await expect(validateEditTargets(source, "mcp_paper_delete_nodes", { fileId: "file", nodeIds: ["root"] }, paper)).rejects.toThrow("artboard root");
    await expect(validateEditTargets(source, "mcp_paper_move_nodes", { fileId: "file", moves: [{ nodeId: "header", parentId: "foreign" }] }, paper)).rejects.toThrow("outside");
    detached = true;
    await expect(validateEditTargets(source, "mcp_paper_update_styles", args, paper)).rejects.toThrow("outside");
    await expect(validateEditTargets({ ...source, file_id: undefined }, "mcp_paper_update_styles", args, paper)).rejects.toThrow("explicitly linked");
  });
  test("the helper serves MCP over stdio without polluting the protocol", async () => {
    const child = Bun.spawn([process.execPath, "run", fileURLToPath(new URL("./helper.ts", import.meta.url))], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    const responses = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(responses[0].result.serverInfo.name).toBe("fx-design");
    const capture = responses[1].result.tools.find((tool: any) => tool.name === "capture_source");
    expect(capture.inputSchema.required).not.toContain("session_directory");
    expect(capture.annotations.readOnlyHint).toBe(false);
  });
  test("renames are independent from source identity and captures survive restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fx-design-test-"));
    try {
      const source = record(directory);
      await new Store(directory).save(source);
      source.root.name = "New readable name";
      await new Store(directory).save(source);
      expect((await new Store(directory).load(source.id)).root.key).toBe("0");
      expect((await new Store(directory).list()).length).toBe(1);
      expect(() => new Store(directory).path("../escape")).toThrow();
    } finally { await rm(directory, { recursive: true }); }
  });
  test("exact SVG survives serialization and copy is escaped", () => {
    const source = record("workspace");
    const svg = '<svg viewBox="0 0 17 19"><path d="M1.234 7.891Z"/></svg>';
    source.root.children.push({ ...source.root, key: "0/0", text: "", svg, children: [] });
    expect(serialize(source.root).html).toContain(svg);
    expect(serialize(source.root).html).toContain("A &amp; B");
  });
  test("same-valued token candidates never become guessed bindings", () => {
    const source = record("workspace");
    source.root.bindings.color = { candidates: ["--text", "--icon"], value: "white" };
    const result = serialize(source.root);
    expect(result.findings[0]?.kind).toBe("binding-ambiguous");
    expect(result.html).not.toContain("var(--text)");
  });
  test("verified source bindings seed exact tokens and retain their names", () => {
    const source = record("workspace");
    source.root.styles.color = "rgb(12, 34, 56)";
    source.root.bindings.color = { candidates: ["--ink"], value: "rgb(12,34,56)", verified: true };
    const vocabulary = collectTokens(source.root);
    expect(vocabulary.tokens[0]?.name).toBe("ink");
    expect(vocabulary.tokens[0]?.value).toBe("rgb(12, 34, 56)");
    expect(serialize(source.root, vocabulary.bindings).html).toContain("color:var(--ink)");
    expect(serialize(source.root, vocabulary.bindings).findings).toEqual([]);
  });
  test("different scoped values receive distinct reversible canvas bindings", () => {
    const source = record("workspace");
    source.root.styles.color = "rgb(0, 0, 0)";
    source.root.bindings.color = { candidates: ["--ink"], value: "black", verified: true };
    source.root.children = [{ ...source.root, key: "0/0", styles: { color: "rgb(255, 255, 255)" }, children: [] }];
    const vocabulary = collectTokens(source.root);
    expect(vocabulary.tokens.length).toBe(2);
    expect(vocabulary.bindings["0:color"]).not.toBe(vocabulary.bindings["0/0:color"]);
  });
  test("import token collisions preserve shared values and exact source bindings", () => {
    const source = record("workspace");
    source.root.styles.color = "rgb(0, 0, 0)";
    source.root.bindings.color = { candidates: ["--ink"], value: "black", verified: true };
    const existing = new Map([["--ink", "white"]]);
    const first = collectTokens(source.root, existing);
    const name = first.tokens[0]!.name;
    expect(name).not.toBe("ink");
    expect(existing.get("--ink")).toBe("white");
    expect(serialize(source.root, first.bindings).html).toContain(`var(--${name})`);
    existing.set(`--${name}`, "rgb(0, 0, 0)");
    expect(collectTokens(source.root, existing)).toEqual(first);
    existing.set(`--${name}`, "red");
    expect(collectTokens(source.root, existing).tokens[0]!.name).not.toBe(name);
  });
  test("source outlines paginate without returning raw SVG payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fx-design-test-"));
    try {
      const source = record(directory);
      source.root.children = Array.from({ length: 55 }, (_, index) => ({ ...source.root, key: `0/${index}`, svg: "x".repeat(100000), children: [] }));
      await new Store(join(directory, "design")).save(source);
      const adapter = new Adapter();
      const first = await adapter.call("source_tree", { session_directory: directory, capture_id: source.id });
      expect(first.nodes.length).toBe(40);
      expect(first.next_offset).toBe(40);
      expect(JSON.stringify(first).length).toBeLessThan(20000);
      const last = await adapter.call("source_tree", { session_directory: directory, capture_id: source.id, offset: first.next_offset });
      expect(last.nodes.length).toBe(16);
      expect(last.next_offset).toBeNull();
    } finally { await rm(directory, { recursive: true }); }
  });
  test("MCP inspection bounds findings and exposes handles rather than payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fx-design-test-"));
    try {
      const source = record(directory);
      source.findings = Array.from({ length: 1000 }, () => ({ kind: "binding-unverified", key: "0", value: "x".repeat(1000) }));
      source.operations = [{ tool: "mcp_paper_write_html", arguments: { html: "x".repeat(100000) }, hash: "proof", status: "pending" }];
      await new Store(join(directory, "design")).save(source);
      const child = Bun.spawn([process.execPath, "run", fileURLToPath(new URL("./helper.ts", import.meta.url))], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inspect", arguments: { session_directory: directory } } }) + "\n");
      child.stdin.end();
      const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(0);
      expect(errors).toBe("");
      expect(output.length).toBeLessThan(10000);
      const capture = JSON.parse(output).result.structuredContent.captures[0];
      expect(capture.finding_count).toBe(1000);
      expect(capture.findings_truncated).toBe(true);
      expect(capture.operations[0].arguments).toBeUndefined();
      expect((await new Store(join(directory, "design")).load(source.id)).findings.length).toBe(1000);
    } finally { await rm(directory, { recursive: true }); }
  });
  test("prepared token requests use Paper CSS names and retain reconciled bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fx-design-test-"));
    const initialize = spyOn(PaperReader.prototype, "initialize").mockResolvedValue(undefined);
    const read = spyOn(PaperReader.prototype, "read").mockResolvedValue({ content: [{ type: "text", text: ":root { --ink: white; }" }] });
    try {
      const source = record(directory);
      source.root.styles.color = "rgb(0, 0, 0)";
      source.root.bindings.color = { candidates: ["--ink"], value: "black", verified: true };
      const store = new Store(join(directory, "design"));
      await store.save(source);
      await new Adapter().call("prepare_import", { session_directory: directory, capture_id: source.id, file_id: "file" });
      const saved = await store.load(source.id);
      const token = saved.operations[0]!.arguments.tokens[0];
      expect(token.name).toMatch(/^--[a-zA-Z0-9_-]+$/);
      expect(token.name).not.toBe("--ink");
      expect(serialize(saved.root, saved.token_bindings).html).toContain(`var(${token.name})`);
    } finally { initialize.mockRestore(); read.mockRestore(); await rm(directory, { recursive: true }); }
  });
  test("three way comparison distinguishes independent and conflicting edits", () => {
    expect(threeWay({ text: "old", gap: 8 }, { text: "new", gap: 8 }, { text: "old", gap: 12 }).conflicts).toEqual([]);
    expect(threeWay({ text: "old" }, { text: "design" }, { text: "code" }).conflicts.length).toBe(1);
    expect(threeWay({ text: "old" }, { text: "new" }, { text: "new" }).conflicts).toEqual([]);
  });
  test("prepared imports are idempotent and reject unprepared or stale writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fx-design-test-"));
    try {
      const workspace = join(directory, "project");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(workspace);
      await writeFile(join(workspace, "page.tsx"), "export default () => null");
      const source = record(workspace), initial = await inventory(workspace);
      source.source_files = initial.files;
      source.source_revision = initial.revision;
      await new Store(join(directory, "design")).save(source);
      const adapter = new Adapter(), args = { session_directory: directory, capture_id: source.id };
      const first = await adapter.call("prepare_import", args);
      const repeated = await new Adapter().call("prepare_import", args);
      expect(first.operations).toEqual(repeated.operations);
      const operation = first.operations[0];
      expect((await adapter.call("preflight", { session_directory: directory, paperTool: operation.tool, argumentsJson: "{}" })).status).toBe("blocked");
      await writeFile(join(workspace, "page.tsx"), "export default () => <main />");
      expect(adapter.call("preflight", { session_directory: directory, paperTool: operation.tool, argumentsJson: JSON.stringify(operation.arguments) })).rejects.toThrow("Source changed");
      expect(digest(operation.arguments)).not.toBe(digest({ ...operation.arguments, name: "changed" }));
    } finally { await rm(directory, { recursive: true }); }
  });
  test("host resolution preserves exact payloads and receipts survive restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fx-design-receipt-"));
    try {
      const source = record(directory), initial = await inventory(directory);
      source.source_revision = initial.revision;
      const operation = { tool: "mcp_paper_create_artboard", arguments: { name: "Import", styles: { width: "300px", height: "80px" } } };
      source.operations = [{ ...operation, hash: digest(operation), status: "pending" }];
      const store = new Store(join(directory, "design"));
      await store.save(source);
      const adapter = new Adapter(), args = { session_directory: directory, capture_id: source.id, operation_hash: digest(operation) };
      expect((await adapter.call("resolve_operation", args)).arguments).toEqual(operation.arguments);
      await expect(adapter.call("execute", args)).rejects.toThrow("fx host");
      await expect(adapter.call("record_result", { ...args, result_json: '{"id":"board"}' })).rejects.toThrow("not admitted");
      await adapter.call("preflight", { session_directory: directory, paperTool: operation.tool, argumentsJson: JSON.stringify(operation.arguments) });
      await expect(adapter.call("resolve_operation", args)).rejects.toThrow("next pending");
      await expect(adapter.call("record_result", { ...args, result_json: '{"error":"failed"}' })).rejects.toThrow("successful");
      // Simulate interruption between the host's durable receipt and its RPC.
      await writeFile(join(store.directory, `${source.id}-${digest(operation)}.receipt`), '{"id":"board"}');
      const recovered = await new Adapter().call("check", args);
      expect(recovered.status).toBe("pending");
      const saved = await new Store(join(directory, "design")).load(source.id);
      expect(saved.operations[0]?.result).toEqual({ id: "board" });
      expect(saved.operations[1]?.arguments.html).toContain("A &amp; B");
      const acknowledgement = await new Adapter().call("record_result", { ...args, result_json: '{"id":"board"}' });
      expect(acknowledgement.status).toBe("already-recorded");
      expect(acknowledgement.operations).toBeUndefined();
      expect((await store.load(source.id)).operations).toHaveLength(2);
    } finally { await rm(directory, { recursive: true }); }
  });
});
