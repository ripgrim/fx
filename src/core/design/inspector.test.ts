import { expect, test, spyOn } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Inspector, inspectorHtml, type VerificationSnapshot } from "./inspector";
import { Adapter, Browser, PaperReader, Store, inventory, type DesignRecord } from "./helper";
import * as propertyDiff from "./property_diff";

test("inspector persists evidence, opens once and serves only the bound capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-inspector-"));
  const inspector = new Inspector();
  const snapshot: VerificationSnapshot = { version: 1, capture_id: "capture", phase: "import", state: "building", source_url: "http://localhost/demo", source_revision: "a".repeat(64), checked_at: new Date().toISOString(), message: "Building", findings: [] };
  try {
    const pending = await inspector.publish(directory, snapshot);
    expect(pending.auto_open).toBe(false);
    const checked = await inspector.publish(directory, { ...snapshot, state: "needs-repair", source_image: "data:image/png;base64,c291cmNl", canvas_image: "data:image/png;base64,cGFwZXI=" });
    expect(checked.auto_open).toBe(true);
    expect(checked.url).toBe(pending.url);
    expect((await inspector.publish(directory, { ...snapshot, state: "outdated" })).auto_open).toBe(false);
    const response = await fetch(checked.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(inspectorHtml);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const current = await fetch(checked.url.replace(/view$/, "snapshot"));
    expect((await current.json()).state).toBe("outdated");
    expect((await fetch(checked.url, { headers: { Origin: "https://foreign.example" } })).status).toBe(403);
    expect((await fetch(checked.url, { method: "POST" })).status).toBe(403);
    expect((await fetch(new URL("/snapshot", checked.url))).status).toBe(404);
    expect(JSON.parse(await readFile(join(directory, "inspector/capture/snapshot.json"), "utf8")).source_revision).toBe(snapshot.source_revision);
  } finally { await inspector.close(); await rm(directory, { recursive: true, force: true }); }
});

test("inspector uses text nodes for untrusted labels and labels residuals as approximate", () => {
  expect(inspectorHtml).not.toContain("innerHTML");
  expect(inspectorHtml).toContain("Pixel diff is approximate.");
  expect(inspectorHtml).not.toContain("Click a capture to open");
  expect(inspectorHtml).toContain('<details id="diagnostics"><summary>Details</summary>');
  expect(inspectorHtml).toContain("outdated · disconnected");
  expect(inspectorHtml).toContain("max-width:760px");
});

test("profile service reuses its endpoint across captures, concurrent sessions and restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-inspector-reuse-"));
  const first = new Inspector(), second = new Inspector(), restarted = new Inspector();
  const snapshot: VerificationSnapshot = { version: 1, capture_id: "one", phase: "import", state: "needs-repair", source_url: "http://localhost/one", source_revision: "a".repeat(64), checked_at: new Date().toISOString(), message: "session one", findings: [], source_image: "data:image/png;base64,eA==", canvas_image: "data:image/png;base64,eQ==" };
  const a = join(directory, ".fx/sessions/a/design"), b = join(directory, ".fx/sessions/b/design");
  try {
    const [one, other] = await Promise.all([first.publish(a, snapshot), second.publish(b, { ...snapshot, message: "session two" })]);
    expect(new URL(one.url).origin).toBe(new URL(other.url).origin);
    expect(one.url).not.toBe(other.url);
    const two = await second.publish(a, { ...snapshot, capture_id: "two", source_url: "http://localhost/two" });
    expect(two.url).toBe(one.url);
    expect(two.auto_open).toBe(false);
    expect((await (await fetch(one.url.replace(/view$/, "snapshot"))).json()).capture_id).toBe("two");
    expect((await (await fetch(one.url.replace(/view$/, "snapshot?capture=one"))).json()).capture_id).toBe("one");
    expect((await (await fetch(other.url.replace(/view$/, "snapshot"))).json()).message).toBe("session two");
    await first.close(); await second.close();
    const again = await restarted.publish(a, snapshot);
    expect(again.url).toBe(one.url);
    expect(again.auto_open).toBe(false);
    expect((await fetch(one.url)).status).toBe(200);
  } finally { await first.close(); await second.close(); await restarted.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an unrelated listener on the saved port is not killed or overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-inspector-collision-"));
  const first = new Inspector(), second = new Inspector();
  const snapshot: VerificationSnapshot = { version: 1, capture_id: "one", phase: "import", state: "building", source_url: "http://localhost", source_revision: "a", checked_at: new Date().toISOString(), message: "building", findings: [] };
  let listener: ReturnType<typeof createServer> | undefined;
  try {
    const view = await first.publish(directory, snapshot); await first.close();
    listener = createServer((_request, response) => response.end("unrelated"));
    await new Promise<void>(resolve => listener!.listen(Number(new URL(view.url).port), "127.0.0.1", resolve));
    await expect(second.publish(directory, snapshot)).rejects.toThrow("saved port is occupied");
    expect(await (await fetch(view.url)).text()).toBe("unrelated");
  } finally { await new Promise<void>(resolve => listener ? listener.close(() => resolve()) : resolve()); await second.close(); await rm(directory, { recursive: true, force: true }); }
});

test("detached service survives its publisher and is reused by the next helper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-inspector-detached-"));
  const first = new Inspector(true), next = new Inspector(true);
  let view: { url: string } | undefined;
  try {
    const snapshot: VerificationSnapshot = { version: 1, capture_id: "one", phase: "import", state: "needs-repair", source_url: "http://localhost", source_revision: "a", checked_at: new Date().toISOString(), message: "checked", findings: [], source_image: "data:image/png;base64,eA==", canvas_image: "data:image/png;base64,eQ==" };
    view = await first.publish(directory, snapshot);
    await first.close();
    expect((await fetch(view.url)).status).toBe(200);
    const reused = await next.publish(directory, snapshot);
    expect(reused.url).toBe(view.url);
    expect(reused.auto_open).toBe(false);
    const service = JSON.parse(await readFile(join(directory, "inspector-service/service.json"), "utf8"));
    expect(service.pid).not.toBe(process.pid);
    const origin = new URL(view.url).origin;
    expect((await fetch(`${origin}/${service.capability}/shutdown`, { method: "POST", headers: { Origin: origin, "X-Fx-Generation": "stale-process" } })).status).toBe(409);
    expect((await fetch(view.url)).status).toBe(200);
  } finally {
    if (view) { const url = new URL(view.url), service = JSON.parse(await readFile(join(directory, "inspector-service/service.json"), "utf8")); await fetch(`${url.origin}/${url.pathname.split("/")[1]}/shutdown`, { method: "POST", headers: { Origin: url.origin, "X-Fx-Generation": service.generation } }); }
    await first.close(); await next.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("host checkpoints defer partial imports, verify finished groups and never repair intentional design changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-checkpoint-"));
  const adapter = new Adapter();
  const init = spyOn(PaperReader.prototype, "initialize").mockResolvedValue(undefined);
  const snapshot = spyOn(PaperReader.prototype, "snapshot").mockResolvedValue({ nodes: {}, jsx: {}, image: "data:image/png;base64,cGFwZXI=" });
  const read = spyOn(PaperReader.prototype, "read").mockResolvedValue({});
  const properties = spyOn(propertyDiff, "readBoundProperties").mockResolvedValue({ status: "match", scope: "dimensions-and-borders", checked_properties: 1, findings: [], fidelity_claim: false });
  const browserCall = spyOn(Browser.prototype, "call").mockResolvedValue({});
  const evaluate = spyOn(Browser.prototype, "evaluate").mockResolvedValue({ different_pixels: 0, total_pixels: 100, dimensions_match: true, match: true });
  try {
    const source = await inventory(directory);
    const screenshot = join(directory, "source.png");
    await writeFile(screenshot, "source");
    const record: DesignRecord = { version: 1, id: "capture", workspace: directory, source_revision: source.revision, source_files: source.files, url: "http://localhost/demo", selector: "body", viewport: { width: 10, height: 10 }, root: { key: "0", name: "root", tag: "body", text: "", styles: {}, bindings: {}, rect: { x: 0, y: 0, width: 10, height: 10 }, children: [] }, screenshot, findings: [], phase: "import", artboard_id: "artboard", operations: [{ tool: "mcp_paper_write_html", arguments: {}, hash: "operation", status: "pending" }] };
    const store = new Store(join(directory, "design"));
    record.file_id = "file";
    record.source_manifest = [{ key: "0", label: "fixture", name: "root", styles: {}, width: 10, height: 10 }];
    record.artboard_id = undefined;
    record.capture_context = { policy: 3, state_label: "test fixture", state_fingerprint: "fixture" };
    await store.save(record);
    const args = { session_directory: directory, capture_id: "capture" };
    const building = await adapter.call("check", args);
    expect(building.inspector.state).toBe("building");
    expect(snapshot).not.toHaveBeenCalled();
    record.operations[0]!.status = "applied";
    record.artboard_id = "artboard";
    await store.save(record);
    const verified = await adapter.call("check", args);
    expect(verified.status).toBe("clean");
    expect(verified.pending_verifications).toBe(0);
    expect(verified.inspector.auto_open).toBe(true);
    expect((await store.load("capture")).phase).toBe("design");
    snapshot.mockResolvedValue({ nodes: { intentional: "change" }, jsx: {}, image: "data:image/png;base64,bmV3" });
    const design = await adapter.call("check", args);
    expect(design.phase).toBe("design");
    expect(design.fidelity_claim).toBe(false);
    expect(design.changes.length).toBeGreaterThan(0);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(design.inspector.auto_open).toBe(false);
    const beforeDiff = await store.load("capture");
    const preview = await adapter.compareCapture(store, beforeDiff);
    expect(preview.status).toBe("ready");
    expect(evaluate).toHaveBeenCalledTimes(2);
    const afterDiff = await store.load("capture");
    expect(afterDiff.phase).toBe(beforeDiff.phase);
    expect(afterDiff.baseline).toEqual(beforeDiff.baseline);
    expect(afterDiff.operations).toEqual(beforeDiff.operations);
    expect(afterDiff.verification?.source_image).toBe("data:image/png;base64,c291cmNl");
    snapshot.mockRejectedValue(new Error("Disconnected"));
    await expect(adapter.call("check", args)).rejects.toThrow("Disconnected");
    expect((await store.load("capture")).verification?.state).toBe("outdated");
  } finally { init.mockRestore(); snapshot.mockRestore(); read.mockRestore(); properties.mockRestore(); browserCall.mockRestore(); evaluate.mockRestore(); await adapter.close(); await rm(directory, { recursive: true, force: true }); }
});
