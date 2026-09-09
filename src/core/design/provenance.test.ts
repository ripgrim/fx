import { expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceRegistry, validateReference, localRect, type ComponentReference } from "./provenance";
import { Adapter, PaperReader, Browser, Store } from "./helper";
import { renderComponentOverlay } from "./provenance";
import { comparePixelBuffers } from "./comparison";
import { inspectorHtml } from "./inspector";

const reference: ComponentReference = { node_id: "button", component_file: "button.tsx", export_name: "Button", props: { children: "Save", variant: "default" }, theme: "light", state: "rest", sizing: "intrinsic", preview: { url: "http://localhost:6006/iframe.html?id=button--default", selector: "button", width: 800, height: 600 } };

test("links survive sessions and renames but never silently redefine intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "fx-provenance-"));
  try {
    const first = new InstanceRegistry(root, "/workspace", "file", "board");
    await first.link(reference);
    await first.link(reference);
    const resumed = new InstanceRegistry(root, "/workspace", "file", "board");
    expect(await resumed.list()).toEqual([reference]);
    const changed = { ...reference, props: { children: "Delete" } };
    await expect(resumed.link(changed)).rejects.toThrow("explicitly");
    expect(await resumed.list()).toEqual([reference]);
    await resumed.link(changed, true);
    expect(await resumed.list()).toEqual([changed]);
    expect(await new InstanceRegistry(root, "/workspace", "other-file", "board").list()).toEqual([]);
    expect(await new InstanceRegistry(root, "/other-workspace", "file", "board").list()).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("references require real files, explicit intent and an isolated stretch container", () => {
  expect(() => validateReference(reference, { "button.tsx": "hash" })).not.toThrow();
  expect(() => validateReference(reference, {})).toThrow("existing");
  expect(() => validateReference({ ...reference, theme: "" }, { "button.tsx": "hash" })).toThrow("explicitly");
  expect(() => validateReference({ ...reference, sizing: "stretch" }, { "button.tsx": "hash" })).toThrow("container");
  expect(() => validateReference({ ...reference, preview: { ...reference.preview, url: "file:///secret" } }, { "button.tsx": "hash" })).toThrow("rendered");
});

test("local comparison placement tracks movement without changing component dimensions", () => {
  const board = { worldX: -200, worldY: 500 };
  expect(localRect({ worldX: -160, worldY: 520, width: 110, height: 32 }, board)).toEqual({ x: 40, y: 20, width: 110, height: 32 });
  expect(localRect({ worldX: 140, worldY: 620, width: 110, height: 32 }, board)).toEqual({ x: 340, y: 120, width: 110, height: 32 });
  expect(() => localRect({ width: 0 }, board)).toThrow();
});

test("the ordinary diff call uses linked instances across sessions, not a page baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "fx-component-diff-"));
  const workspace = join(root, "project"), one = join(root, "sessions", "one"), two = join(root, "sessions", "two");
  const adapter = new Adapter();
  const initialize = spyOn(PaperReader.prototype, "initialize").mockResolvedValue(undefined);
  const read = spyOn(PaperReader.prototype, "read").mockImplementation(async (name, args) => ({ structuredContent: name === "get_basic_info" ? { url: "https://app.paper.design/file/file/page" } : name === "get_selection" ? { selectedNodes: [{ id: "button" }] } : args.nodeId === "board" ? { id: "board", childIds: ["button"] } : { id: "button", artboardId: "board", childIds: [] } }));
  const compare = spyOn(adapter, "componentDiff").mockResolvedValue({ status: "ready", url: "http://viewer" });
  const page = spyOn(adapter, "freshDiff").mockRejectedValue(Error("Page diff must not run"));
  try {
    await mkdir(workspace); await mkdir(one, { recursive: true }); await mkdir(two);
    await writeFile(join(workspace, "button.tsx"), "export const Button = () => null;");
    await adapter.call("link_component", { session_directory: one, workspace, file_id: "file", artboard_id: "board", reference });
    expect(await adapter.call("diff", { session_directory: two, workspace, target: "node:board" })).toEqual({ status: "ready", url: "http://viewer" });
    expect(await adapter.call("diff", { session_directory: two, workspace })).toEqual({ status: "ready", url: "http://viewer" });
    expect(compare).toHaveBeenCalledTimes(2);
    expect(page).not.toHaveBeenCalled();
    expect(compare.mock.calls[0][4]).toEqual([reference]);
  } finally { initialize.mockRestore(); read.mockRestore(); compare.mockRestore(); page.mockRestore(); await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("component viewer uses one canvas and preserves per-instance inspection", () => {
  expect(() => new Function(inspectorHtml.split("<script>")[1]!.split("</script>")[0]!)).not.toThrow();
  expect(inspectorHtml).toContain(".components figure:not(:last-child){display:none}");
  expect(inspectorHtml).toContain("Code reference");
  expect(inspectorHtml).toContain("unlinked regions");
  expect(inspectorHtml).not.toContain("innerHTML");
});

test.skipIf(!process.env.FX_DESIGN_BROWSER)("real renderer preserves text pixels, flags borders, and ignores placement", async () => {
  const browser = new Browser("fx-component-renderer-test-" + Date.now());
  try {
    await browser.call("open", "about:blank");
    const result = await browser.evaluate(`(async () => {
      const image = (border, width=120) => { const c=document.createElement('canvas');c.width=width;c.height=36;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,width,36);x.font='14px sans-serif';x.fillStyle='black';x.fillText('Save changes',10,23);if(border)x.strokeRect(.5,.5,width-1,35);return c.toDataURL('image/png') };
      const b=document.createElement('canvas');b.width=500;b.height=300;
      for(const [x,y,border,width] of [[5,5,true,120],[250,150,true,120],[5,80,false,120],[250,220,true,130]]) {
        const img=await new Promise(resolve=>{const i=new Image();i.onload=()=>resolve(i);i.src=image(border,width)});
        b.getContext('2d').drawImage(img,x,y);
      }
      return (${renderComponentOverlay.toString()})(b.toDataURL('image/png'),[
        {node_id:'same',label:'Same',status:'unavailable',rect:{x:5,y:5,width:120,height:36},reference_image:image(true),paper_image:image(false)},
        {node_id:'moved',label:'Moved',status:'unavailable',rect:{x:250,y:150,width:120,height:36},reference_image:image(true),paper_image:image(true)},
        {node_id:'border',label:'Border',status:'unavailable',rect:{x:5,y:80,width:120,height:36},reference_image:image(true),paper_image:image(false)},
        {node_id:'size',label:'Size',status:'unavailable',rect:{x:250,y:220,width:130,height:36},reference_image:image(true),paper_image:image(true,130)},
        {node_id:'clipped',label:'Clipped',status:'unavailable',rect:{x:490,y:220,width:130,height:36},reference_image:image(true)}
      ],${comparePixelBuffers.toString()});
    })()`);
    expect(result.instances.map((item: any) => item.status)).toEqual(["consistent", "consistent", "drift", "drift", "unavailable"]);
    expect(result.instances[2].different_pixels).toBeGreaterThan(200);
    expect(result.overlay_image).toStartWith("data:image/png;base64,");
  } finally { await browser.call("close"); }
}, 60000);

test.skipIf(!process.env.FX_DESIGN_BROWSER)("stretch capture constrains content width, not padded container width", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-stretch-"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('<div id="container" style="box-sizing:border-box;padding:20px;width:424px;background:white"><input style="box-sizing:border-box;width:100%;height:32px" value="Test"></div>', { headers: { "Content-Type": "text/html" } }) });
  const adapter = new Adapter();
  try {
    const result = await adapter.call("capture_source", { workspace: directory, session_directory: directory, url: `http://127.0.0.1:${server.port}`, selector: "input", component_reference: true, component_container: { selector: "#container", width: 384 }, width: 600, height: 400 });
    const captured = await new Store(join(directory, "design")).load(result.capture_id);
    expect(captured.root.rect.width).toBe(384);
    expect(captured.component_backdrop).toBe("rgb(255, 255, 255)");
  } finally { server.stop(true); await adapter.close(); await rm(directory, { recursive: true, force: true }); }
}, 60000);
