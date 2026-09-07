import { createServer, type Server } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { comparePixelBuffers, comparisonSensitivity } from "./comparison";

export type VerificationState = "building" | "checking" | "verified" | "needs-repair" | "outdated";
export interface VerificationSnapshot {
  version: 1;
  capture_id: string;
  phase: "import" | "design" | "apply";
  state: VerificationState;
  source_url: string;
  source_revision: string;
  artboard_id?: string;
  file_id?: string;
  canvas_revision?: string;
  checked_at: string;
  message: string;
  source_image?: string;
  canvas_image?: string;
  findings: { kind: string; property?: string; key?: string; provenance?: string; change?: "removed" | "added" | "changed"; expected?: unknown; actual?: unknown; rect?: { x: number; y: number; width: number; height: number } }[];
  visual?: { different_pixels: number; raw_different_pixels?: number; ignored_pixels?: number; sensitivity?: typeof comparisonSensitivity; total_pixels: number; dimensions_match: boolean; match: boolean };
}

type ServiceIdentity = { version: 1; port: number; capability: string; root_id: string; renderer: string; pid: number; generation?: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const service_version = hash(await readFile(import.meta.filename, "utf8") + await readFile(join(dirname(import.meta.filename), "comparison.ts"), "utf8"));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function atomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
async function identity(root: string): Promise<ServiceIdentity | undefined> {
  let value: ServiceIdentity;
  try { value = JSON.parse(await readFile(join(root, "service.json"), "utf8")); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9-]{36}$/.test(value.capability) || value.root_id !== hash(resolve(root))) throw new Error("Invalid inspector service identity");
  return value;
}
const endpoint = (service: ServiceIdentity) => `http://127.0.0.1:${service.port}`;
async function healthy(service: ServiceIdentity) {
  try {
    const response = await fetch(`${endpoint(service)}/${service.capability}/health`, { headers: { Connection: "close" }, signal: AbortSignal.timeout(800) });
    const health = await response.json();
    return response.ok && health.root_id === service.root_id && health.renderer === service.renderer && health.generation === service.generation && health.kind === "fx-design-inspector";
  } catch { return false; }
}

/** The descriptor keeps port and capability stable across process restarts. */
async function startService(root: string, detached: boolean): Promise<Server> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const previous = await identity(root);
  const service: ServiceIdentity = { version: 1, port: previous?.port ?? 0, capability: previous?.capability ?? randomUUID(), root_id: hash(resolve(root)), renderer: service_version, pid: process.pid, generation: randomUUID() };
  let last_activity = Date.now();
  let idle: ReturnType<typeof setInterval>;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "close");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (request.headers.host !== endpoint(service).slice(7) || (request.headers.origin && request.headers.origin !== endpoint(service))) { response.writeHead(403).end(); return; }
    const url = new URL(request.url ?? "/", endpoint(service)), parts = url.pathname.split("/");
    if (parts[1] !== service.capability) { response.writeHead(404).end(); return; }
    if (parts.length === 3 && parts[2] === "shutdown" && request.method === "POST" && request.headers.origin === endpoint(service)) {
      if (request.headers["x-fx-generation"] !== service.generation) { response.writeHead(409).end(); return; }
      response.writeHead(202).end(); server.close(); return;
    }
    if (request.method !== "GET") { response.writeHead(403).end(); return; }
    last_activity = Date.now();
    response.setHeader("Content-Type", "application/json");
    if (parts.length === 3 && parts[2] === "health") { response.end(JSON.stringify({ kind: "fx-design-inspector", root_id: service.root_id, renderer: service.renderer, generation: service.generation })); return; }
    if (parts.length !== 4 || !/^[a-f0-9]{64}$/.test(parts[2]!) || !["view", "snapshot"].includes(parts[3]!)) { response.writeHead(404).end(); return; }
    try {
      const route = JSON.parse(await readFile(join(root, "routes", parts[2]!, "route.json"), "utf8"));
      if (hash(resolve(route.directory)) !== parts[2]) throw new Error("Invalid route identity");
      if (parts[3] === "view") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(inspectorHtml); return; }
      const capture = url.searchParams.get("capture") || route.active;
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(capture) || !route.captures.some((item: any) => item.id === capture)) { response.writeHead(404).end(); return; }
      const snapshot = JSON.parse(await readFile(join(route.directory, "inspector", capture, "snapshot.json"), "utf8"));
      response.end(JSON.stringify({ ...snapshot, captures: route.captures, renderer: service.renderer }));
    } catch { response.writeHead(503).end(); }
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(service.port, "127.0.0.1", accept); });
  service.port = (server.address() as { port: number }).port;
  try {
    if (previous) await atomic(join(root, "service.json"), service);
    else await writeFile(join(root, "service.json"), JSON.stringify(service), { mode: 0o600, flag: "wx" });
  } catch (error) { server.close(); throw error; } // A concurrent winner owns its port; never kill it.
  idle = setInterval(() => { if (Date.now() - last_activity > 30 * 60 * 1000) server.close(); }, 30000);
  idle.unref();
  server.on("close", () => clearInterval(idle));
  if (!detached) server.unref();
  return server;
}

/** One reusable profile service, independent session routes and no arbitrary file API. */
export class Inspector {
  private local_servers: Server[] = [];
  constructor(private readonly persistent = false) {}
  async close() { await Promise.all(this.local_servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
  private async service(root: string): Promise<ServiceIdentity> {
    let existing = await identity(root);
    if (existing && await healthy(existing)) {
      if (existing.renderer === service_version) return existing;
      // Upgrade only an authenticated fx service. Preserve endpoint and route identities.
      await fetch(`${endpoint(existing)}/${existing.capability}/shutdown`, { method: "POST", headers: { Origin: endpoint(existing), "X-Fx-Generation": existing.generation ?? "" }, signal: AbortSignal.timeout(1000) });
      await pause(100);
    }
    if (this.persistent) {
      const child = spawn(process.execPath, [import.meta.filename, "--serve", root], { detached: true, windowsHide: true, stdio: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot } });
      child.on("error", () => undefined);
      child.unref();
    } else {
      try { this.local_servers.push(await startService(root, false)); } catch (error: any) { if (!["EADDRINUSE", "EEXIST"].includes(error.code)) throw error; }
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      existing = await identity(root);
      if (existing && existing.renderer === service_version && await healthy(existing)) return existing;
      await pause(50);
    }
    throw new Error("Inspector service unavailable or saved port is occupied; no unrelated process was stopped");
  }
  async publish(directory: string, snapshot: VerificationSnapshot) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(snapshot.capture_id)) throw new Error("Invalid inspector capture identity");
    const target = join(directory, "inspector", snapshot.capture_id);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const temporary = join(target, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(target, "snapshot.json"));
    const sessions = dirname(dirname(directory));
    const root = basename(sessions) === "sessions" ? join(dirname(sessions), "design-inspector") : join(directory, "inspector-service");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const service = await this.service(root), key = hash(resolve(directory));
    const route_directory = join(root, "routes", key);
    await mkdir(route_directory, { recursive: true, mode: 0o700 });
    const path = join(route_directory, "route.json");
    let route: { directory: string; active: string; captures: { id: string; label: string }[] };
    try { route = JSON.parse(await readFile(path, "utf8")); } catch { route = { directory: resolve(directory), active: snapshot.capture_id, captures: [] }; }
    if (!route.captures.some(item => item.id === snapshot.capture_id)) route.captures.push({ id: snapshot.capture_id, label: snapshot.source_url });
    route.active = snapshot.capture_id;
    await atomic(path, route);
    let auto_open = false;
    if (snapshot.source_image && snapshot.canvas_image) {
      try { await writeFile(join(route_directory, "opened"), "1", { mode: 0o600, flag: "wx" }); auto_open = true; } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    }
    return { state: snapshot.state, phase: snapshot.phase, message: snapshot.message, url: `${endpoint(service)}/${service.capability}/${key}/view`, auto_open, checked_at: snapshot.checked_at };
  }
}

export const inspectorHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fx · Design verification</title>
<style>
:root{color-scheme:light dark;--bg:#f5f3ee;--ink:#232725;--line:#d0d3ca;--muted:#636b65;--red:#ce3434;--green:#087a49}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-monospace,Consolas,monospace}main{max-width:1800px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;gap:20px;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:18px}h1{font:500 30px/1.1 Georgia,serif;margin:0}h2{font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.12em}p{margin:10px 0}.muted{color:var(--muted)}#state{padding:5px 10px;border:1px solid currentColor}nav{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:20px 0}button,select{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);padding:7px 12px;cursor:pointer}button:hover,button:focus-visible,select:focus-visible{border-color:var(--ink)}.views{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}figure{margin:0;min-width:0}canvas{width:100%;height:auto;border:1px solid var(--line);background:#fff}#findings,#token-findings{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.red{color:var(--red)}.green{color:var(--green)}#provenance{font-size:11px;overflow-wrap:anywhere;border-top:1px solid var(--line);padding-top:16px}label{cursor:pointer}@media(prefers-color-scheme:dark){:root{--bg:#171b19;--ink:#e4e9e2;--line:#424a44;--muted:#a5afa5;--red:#ff7575;--green:#60d399}}@media(max-width:760px){main{padding:16px}.views{grid-template-columns:1fr}header{display:block}#state{display:inline-block;margin-top:16px}h1{font-size:26px}}
details{margin-top:20px;font-size:12px}summary{cursor:pointer;color:var(--muted)}#findings:empty,#finding-detail:empty{display:none}#capture-choice{max-width:min(60vw,480px)}dialog{width:min(96vw,1800px);height:92vh;max-width:none;max-height:none;padding:20px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}dialog::backdrop{background:rgb(0 0 0 / .7)}.lightbox-shell{display:flex;flex-direction:column;height:100%;gap:12px}.lightbox-shell header{align-items:center;padding:0 0 12px}.lightbox-shell h2{margin:0}.lightbox-shell nav{margin:0;gap:8px}.lightbox-views{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;flex:1;min-height:0}.lightbox-views figure{display:flex;flex-direction:column;gap:8px;min-height:0}.lightbox-viewport{position:relative;flex:1;min-height:0;overflow:hidden;border:1px solid var(--line);background:repeating-conic-gradient(var(--line) 0% 25%,transparent 0% 50%) 50%/16px 16px;touch-action:none;cursor:grab}.lightbox-viewport:active{cursor:grabbing}.lightbox-viewport canvas{position:absolute;left:50%;top:50%;width:auto;max-width:none;height:auto;border:0;transform-origin:center}.lightbox-viewport:focus-visible{outline:2px solid var(--ink);outline-offset:2px}#zoom-value{min-width:5ch;text-align:center}.lightbox-note{margin:0;font-size:11px;color:var(--muted)}@media(max-width:760px){dialog{padding:12px;width:98vw;height:96vh}.lightbox-views{grid-template-columns:1fr;grid-template-rows:repeat(3,minmax(0,1fr));gap:8px}.lightbox-shell header{display:flex;gap:8px}.lightbox-shell header h2{font-size:11px}.lightbox-shell nav{gap:6px}.lightbox-shell button{padding:6px 9px}}
</style><main><header><div><h1>Source → Paper</h1></div><span id="state" role="status">Connecting</span></header>
<p id="message" aria-live="polite" hidden></p><nav><label>Capture <select id="capture-choice"><option value="">Latest in this session</option></select></label><button id="full">Full surface</button><label><input id="pixels" type="checkbox" checked> Pixel diff</label><span class="red">− Source</span><span class="green">+ Paper</span></nav>
<div class="views"><figure><h2>Source</h2><canvas id="source"></canvas></figure><figure><h2>Paper</h2><canvas id="paper"></canvas></figure><figure><h2>Diff</h2><canvas id="diff"></canvas></figure></div>
<div id="findings"></div><pre id="finding-detail" style="white-space:pre-wrap;overflow-wrap:anywhere" aria-live="polite"></pre><details id="diagnostics"><summary>Details</summary><p class="muted">Pixel diff is approximate.</p><div id="token-findings"></div><p id="provenance" class="muted"></p></details></main>
<dialog id="lightbox" aria-labelledby="lightbox-title" aria-describedby="lightbox-help"><div class="lightbox-shell"><header><h2 id="lightbox-title">Comparison lightbox</h2><button id="lightbox-close" aria-label="Close comparison lightbox">Close · Esc</button></header><nav aria-label="Image zoom"><button id="zoom-out" aria-label="Zoom out">−</button><output id="zoom-value" aria-live="polite">100%</output><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-native">100%</button><button id="zoom-fit">Fit / reset</button></nav><div class="lightbox-views"><figure><h2>Source</h2><div class="lightbox-viewport" tabindex="0" aria-label="Source capture, drag or use arrow keys to pan"><canvas id="lightbox-source"></canvas></div></figure><figure><h2>Paper</h2><div class="lightbox-viewport" tabindex="0" aria-label="Paper capture, drag or use arrow keys to pan"><canvas id="lightbox-paper"></canvas></div></figure><figure><h2>Difference</h2><div class="lightbox-viewport" tabindex="0" aria-label="Difference capture, drag or use arrow keys to pan"><canvas id="lightbox-diff"></canvas></div></figure></div><p id="lightbox-help" class="lightbox-note">Drag to pan · + / − to zoom</p></div></dialog>
<script>
const $=id=>document.getElementById(id);let snapshot,images,crop,last='';
const renderer_version=${JSON.stringify(service_version)};
const comparePixels=${comparePixelBuffers.toString()};
const load=src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=src});
function draw(){if(!images)return;const [a,b]=images;const region=crop||{x:0,y:0,width:Math.max(a.width,b.width),height:Math.max(a.height,b.height)};const width=Math.max(1,Math.ceil(region.width)),height=Math.max(1,Math.ceil(region.height));if(width*height>32000000)throw Error('Image exceeds preview limit');
for(const [id,img] of [['source',a],['paper',b],['diff',b]]){const c=$(id);c.width=width;c.height=height;c.getContext('2d').drawImage(img,region.x,region.y,width,height,0,0,width,height)}
if($('pixels').checked){const x=$('source').getContext('2d').getImageData(0,0,width,height).data,y=$('paper').getContext('2d').getImageData(0,0,width,height).data,ctx=$('diff').getContext('2d'),out=ctx.getImageData(0,0,width,height),comparison=comparePixels(x,y,snapshot?.visual?.sensitivity?.pixel_channel_epsilon??0);for(let i=0;i<x.length;i+=4){if(!comparison.mask[i/4])continue;const removed=x[i]+x[i+1]+x[i+2]<y[i]+y[i+1]+y[i+2];out.data[i]=removed?225:20;out.data[i+1]=removed?45:175;out.data[i+2]=removed?45:95;out.data[i+3]=255}ctx.putImageData(out,0,0)}if($('lightbox').open)syncLightbox()}
$('full').onclick=()=>{crop=undefined;draw()};$('pixels').onchange=draw;
const lightbox=$('lightbox');let lightbox_scale=1,pan_x=0,pan_y=0,lightbox_opener,prior_overflow='',drag;
function transformLightbox(){for(const id of ['source','paper','diff'])$('lightbox-'+id).style.transform='translate(calc(-50% + '+pan_x+'px),calc(-50% + '+pan_y+'px)) scale('+lightbox_scale+')';$('zoom-value').value=Math.round(lightbox_scale*100)+'%'}
function syncLightbox(){for(const id of ['source','paper','diff']){const source=$(id),target=$('lightbox-'+id);target.width=source.width;target.height=source.height;target.style.width=source.width+'px';target.style.height=source.height+'px';target.getContext('2d').drawImage(source,0,0)}transformLightbox()}
function fitLightbox(){const viewport=document.querySelector('.lightbox-viewport');lightbox_scale=Math.min(1,(viewport.clientWidth-16)/$('source').width,(viewport.clientHeight-16)/$('source').height);lightbox_scale=Math.max(.01,lightbox_scale);pan_x=pan_y=0;transformLightbox()}
function zoomLightbox(factor){lightbox_scale=Math.max(.01,Math.min(16,lightbox_scale*factor));transformLightbox()}
function openLightbox(id){if(!images||lightbox.open)return;lightbox_opener=$(id);prior_overflow=document.documentElement.style.overflow;document.documentElement.style.overflow='hidden';$('lightbox-title').textContent=(crop?'Selected region':'Full surface')+' · Source / Paper / Difference';lightbox.showModal();syncLightbox();fitLightbox();$('lightbox-close').focus()}
lightbox.onclose=()=>{document.documentElement.style.overflow=prior_overflow;drag=undefined;lightbox_opener?.focus()};lightbox.oncancel=event=>{event.preventDefault();lightbox.close()};$('lightbox-close').onclick=()=>lightbox.close();$('zoom-in').onclick=()=>zoomLightbox(1.5);$('zoom-out').onclick=()=>zoomLightbox(1/1.5);$('zoom-native').onclick=()=>{lightbox_scale=1;pan_x=pan_y=0;transformLightbox()};$('zoom-fit').onclick=fitLightbox;
lightbox.onkeydown=event=>{if(event.key==='+'||event.key==='='){event.preventDefault();zoomLightbox(1.5)}if(event.key==='-'){event.preventDefault();zoomLightbox(1/1.5)}};
for(const viewport of document.querySelectorAll('.lightbox-viewport')){viewport.onpointerdown=event=>{if(event.button!==0)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY};viewport.setPointerCapture(event.pointerId);viewport.focus()};viewport.onpointermove=event=>{if(!drag||drag.id!==event.pointerId)return;pan_x+=event.clientX-drag.x;pan_y+=event.clientY-drag.y;drag.x=event.clientX;drag.y=event.clientY;transformLightbox()};viewport.onpointerup=viewport.onpointercancel=()=>{drag=undefined};viewport.onkeydown=event=>{const delta={ArrowLeft:[32,0],ArrowRight:[-32,0],ArrowUp:[0,32],ArrowDown:[0,-32]}[event.key];if(delta){event.preventDefault();pan_x+=delta[0];pan_y+=delta[1];transformLightbox()}}}
for(const id of ['source','paper','diff']){const canvas=$(id);canvas.tabIndex=0;canvas.setAttribute('role','button');canvas.setAttribute('aria-haspopup','dialog');canvas.setAttribute('aria-label','Open '+id+' comparison lightbox');canvas.onclick=()=>openLightbox(id);canvas.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openLightbox(id)}}}
let refresh_timer;$('capture-choice').onchange=()=>{crop=undefined;last='';clearTimeout(refresh_timer);refresh()};
async function refresh(){try{if(document.hidden)return;const response=await fetch('snapshot'+($('capture-choice').value?'?capture='+encodeURIComponent($('capture-choice').value):''),{cache:'no-store'});if(!response.ok)throw Error('Inspector unavailable');const next=await response.json();if(next.renderer&&next.renderer!==renderer_version){location.reload();return}const choice=$('capture-choice'),selected=choice.value;choice.replaceChildren(new Option('Latest in this session',''),...(next.captures||[]).map(capture=>new Option(capture.label,capture.id)));choice.value=selected;const stamp=JSON.stringify(next);if(snapshot&&snapshot.capture_id!==next.capture_id){crop=undefined;$('finding-detail').textContent='';pan_x=0;pan_y=0}snapshot=next;const expired=['verified','needs-repair'].includes(next.state)&&Date.now()-Date.parse(next.checked_at)>30000;$('state').textContent=expired?'outdated · last checkpoint':next.state;$('message').textContent='';$('message').hidden=true;$('provenance').textContent='Captured source: '+next.source_url+' · phase: '+next.phase+' · checked: '+next.checked_at+' · source revision: '+next.source_revision+' · canvas revision: '+(next.canvas_revision||'not checked')+'. Snapshots are not continuous surveillance; external Paper edits require a new checkpoint.';
if(stamp!==last){last=stamp;$('findings').replaceChildren();$('token-findings').replaceChildren();for(const finding of next.findings){const button=document.createElement('button');const computed=finding.provenance==='computed-properties';button.textContent=(computed?'Computed · ':'')+(finding.change==='removed'?'− ':finding.change==='added'?'+ ':'')+finding.kind+(finding.property?' · '+finding.property:'');if(computed&&finding.change==='removed')button.className='red';if(computed&&finding.change==='added')button.className='green';button.onclick=()=>{const r=finding.rect;if(r)crop={x:Math.max(0,r.x-12),y:Math.max(0,r.y-12),width:r.width+24,height:r.height+24};$('finding-detail').textContent=(computed?'Computed property evidence; separate from pixel residuals.':'Source capture finding.')+'\\n'+JSON.stringify({property:finding.property,change:finding.change,expected:finding.expected,actual:finding.actual},null,2);draw()};(finding.kind.startsWith('binding-')||finding.kind==='property-unverified'?$('token-findings'):$('findings')).append(button)}if(next.source_image&&next.canvas_image){images=await Promise.all([load(next.source_image),load(next.canvas_image)]);draw()}}
}catch(error){$('state').textContent='outdated · disconnected';$('message').hidden=false;$('message').textContent='Reconnect fx to refresh.'}finally{refresh_timer=setTimeout(refresh,2000)}}refresh();
</script></html>`;

if (import.meta.main && process.argv[2] === "--serve" && process.argv[3]) {
  try { await startService(resolve(process.argv[3]), true); } catch { process.exitCode = 1; }
}
