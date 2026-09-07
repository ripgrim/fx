import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adapter, Store, Browser, captureDocument, serialize } from "./helper";

test("generated avatar rings and before/after decorations survive as pixel-identical editable boxes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-design-pseudo-"));
  const browser = new Browser(`fx-pseudo-${crypto.randomUUID()}`);
  const html = `<html><style>body{margin:0}main{display:flex;gap:12px;padding:10px;width:180px;height:60px;box-sizing:border-box}main>div{position:relative;width:28px;height:28px;flex-shrink:0;border-radius:9999px;background:#eee}.avatar::after{content:'';position:absolute;inset:0;border:1px solid #bfcac5;border-radius:inherit;box-sizing:border-box}.decorated::before{content:'';position:absolute;top:3px;left:2px;width:8px;height:5px;background:#345;box-sizing:content-box;padding:1px;border:2px solid #abc}.decorated::after{content:'';position:absolute;bottom:0;right:0;width:5px;height:5px;background:#789}.hidden::after{content:'';display:none}</style><body><main><div class="avatar"></div><div class="decorated"></div><div class="hidden"></div></main></body></html>`;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) });
  try {
    await browser.call("open", `http://127.0.0.1:${server.port}`);
    await browser.call("set", "viewport", "600", "400");
    const snapshot = await browser.evaluate(`(${captureDocument.toString()})("main")`);
    expect(snapshot.findings.filter((finding: any) => finding.kind === "pseudo-element")).toEqual([]);
    expect(snapshot.root.children[0].pseudo_elements[0].styles["border-top"]).toContain("1px solid");
    expect(snapshot.root.children[1].pseudo_elements[0].styles.width).toBe("14px");
    expect(snapshot.root.children[2].pseudo_elements).toEqual([]);
    await browser.call("screenshot", "main", join(directory, "source.png"));
    const imported = serialize(snapshot.root).html;
    expect(imported).toContain("::after decoration");
    await browser.evaluate(`(()=>{document.querySelectorAll('style').forEach(el=>el.remove());document.body.innerHTML=${JSON.stringify(imported)};return true})()`);
    await browser.call("screenshot", "body > div", join(directory, "imported.png"));
    expect(await Bun.file(join(directory, "source.png")).arrayBuffer()).toEqual(await Bun.file(join(directory, "imported.png")).arrayBuffer());
  } finally { await browser.call("close").catch(() => undefined); server.stop(true); await rm(directory, { recursive: true }); }
}, 120000);

test("unrepresented generated text and masked decorations remain unresolved", async () => {
  const browser = new Browser(`fx-pseudo-unsupported-${crypto.randomUUID()}`);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`<style>main::before{content:'required';position:absolute}main::after{content:'';position:absolute;mask-image:linear-gradient(black,transparent)}</style><main>Product</main>`, { headers: { "Content-Type": "text/html" } }) });
  try {
    await browser.call("open", `http://127.0.0.1:${server.port}`);
    const snapshot = await browser.evaluate(`(${captureDocument.toString()})("main")`);
    expect(snapshot.root.pseudo_elements).toEqual([]);
    expect(snapshot.findings.filter((finding: any) => finding.kind === "pseudo-element").map((finding: any) => finding.pseudo)).toEqual(["::before", "::after"]);
  } finally { await browser.call("close").catch(() => undefined); server.stop(true); }
}, 120000);

test("capture excludes Next.js overlays but retains application portals and iframes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-design-overlay-"));
  const browser = new Browser(`fx-overlay-${crypto.randomUUID()}`);
  const html = `<html><body style="margin:0"><main>Product</main><div data-slot="app-portal">Product dialog</div><iframe title="Product embed" srcdoc="Product content"></iframe><nextjs-portal style="display:block;position:fixed;inset:0;background:red"></nextjs-portal><script>document.querySelector('nextjs-portal').attachShadow({mode:'open'}).innerHTML='<button>Dev tools</button>';</script></body></html>`;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) });
  try {
    await browser.call("open", `http://127.0.0.1:${server.port}`);
    await browser.call("set", "viewport", "600", "400");
    const snapshot = await browser.evaluate(`(${captureDocument.toString()})("body")`);
    expect(snapshot.root.children.some((node: any) => node.tag === "nextjs-portal")).toBe(false);
    expect(snapshot.root.children.some((node: any) => node.name === "app-portal")).toBe(true);
    expect(snapshot.root.children.some((node: any) => node.tag === "iframe")).toBe(true);
    await browser.evaluate(`(()=>{const el=document.createElement('nextjs-portal');el.innerHTML='<iframe srcdoc="Dev tools"></iframe>';document.body.append(el);return true})()`);
    expect(await browser.evaluate(`Array.from(document.querySelectorAll('nextjs-portal')).every(el=>getComputedStyle(el).display==='none')`)).toBe(true);
    await browser.call("screenshot", "body", join(directory, "hidden.png"));
    await browser.evaluate(`(()=>{document.querySelectorAll('nextjs-portal').forEach(el=>el.remove());return true})()`);
    await browser.call("screenshot", "body", join(directory, "absent.png"));
    expect(await Bun.file(join(directory, "hidden.png")).arrayBuffer()).toEqual(await Bun.file(join(directory, "absent.png")).arrayBuffer());
  } finally { await browser.call("close").catch(() => undefined); server.stop(true); await rm(directory, { recursive: true }); }
}, 120000);

test("agent-browser captures actual SVG geometry and scoped token evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-design-browser-"));
  const svg = '<svg width="20" height="20" viewBox="0 0 20 20"><path d="M1.25 2.5 L17.75 18.5" stroke="currentColor"/></svg>';
  const html = `<html><style>body{margin:0}main{--ink:rgb(12,34,56);color:var(--ink);display:flex;width:300px;height:80px}span{font-family:sans-serif}</style><body><main data-slot="header">${svg}<span>Actual source</span></main></body></html>`;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) });
  try {
    const workspace = join(directory, "project");
    await mkdir(workspace);
    await writeFile(join(workspace, "page.tsx"), "export function Header() { return null }");
    const adapter = new Adapter();
    const result = await adapter.call("capture_source", { session_directory: directory, workspace, url: `http://127.0.0.1:${server.port}`, selector: "main", width: 600, height: 400 });
    const record = await new Store(join(directory, "design")).load(result.capture_id);
    expect(record.root.name).toBe("header");
    expect(record.root.rect.width).toBe(300);
    expect(record.root.children[0]?.svg).toContain('d="M1.25 2.5 L17.75 18.5"');
    expect(record.root.bindings.color?.candidates).toEqual(["--ink"]);
    expect((await Bun.file(record.screenshot).arrayBuffer()).byteLength).toBeGreaterThan(100);
    const repeated = await adapter.call("capture_source", { session_directory: directory, workspace, url: `http://127.0.0.1:${server.port}`, selector: "main", width: 600, height: 400 });
    expect(repeated.capture_id).toBe(result.capture_id);
    expect(repeated.reused).toBe(true);
  } finally { server.stop(true); await rm(directory, { recursive: true }); }
}, 120000);
