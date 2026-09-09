import { createServer, type Server } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { comparePixelBuffers, comparisonSensitivity, differenceRegions } from "./comparison";

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

export const inspectorHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fx · Compare</title>
<style>
:root{color-scheme:light;--bg:oklch(96.5% .005 155);--surface:oklch(99% .003 155);--subtle:oklch(93% .006 155);--ink:oklch(25% .01 155);--muted:oklch(49% .012 155);--line:oklch(87% .008 155);--accent:oklch(43% .07 155);--red:oklch(49% .18 25);--green:oklch(43% .12 155);--warning:oklch(47% .09 75)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI Variable Text","Segoe UI",sans-serif}main{max-width:1800px;margin:auto;padding:28px 32px 40px}header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding-bottom:24px}.identity{display:flex;gap:18px;align-items:center}.wordmark{font:italic 600 29px Georgia,serif;letter-spacing:-3px;padding-right:6px}.divider{color:var(--line);font-size:24px;font-weight:300}h1{font-size:17px;letter-spacing:-.4px;font-weight:550;margin:0}h2{font-size:12px;font-weight:550;margin:0;letter-spacing:.02em}p{margin:10px 0}.muted{color:var(--muted)}#state{display:inline-flex;gap:8px;align-items:center;font-size:12px;font-weight:550;background:var(--subtle);padding:6px 12px;border-radius:100px}#state:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}#state[data-kind=verified]{color:var(--green)}#state[data-kind=needs-repair],#state[data-kind=blocked]{color:var(--warning)}#state[data-kind=disconnected]{color:var(--red)}#state[data-kind=building]:before,#state[data-kind=checking]:before{animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.25}}nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 22px}.capture-label{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px}.spacer{flex:1}button,select{font:inherit;font-size:12px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:9px;min-height:36px;padding:7px 12px;cursor:pointer;transition:background .15s ease-out,border-color .15s ease-out}button:hover,select:hover{background:var(--subtle)}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.45;cursor:default}#expand{background:var(--ink);color:var(--surface);border-color:var(--ink)}#expand:hover{opacity:.85}#capture-choice{max-width:min(42vw,440px)}.toggle{display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer}.toggle input{accent-color:var(--accent);width:15px;height:15px;margin:0}.legend{display:flex;gap:12px;font-size:11px;color:var(--muted)}.red{color:var(--red)}.green{color:var(--green)}.views{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{margin:0;min-width:0}.views h2{display:flex;align-items:center;justify-content:space-between;color:var(--muted);margin:0 2px 10px}.views h2 span{font-size:10px;letter-spacing:.08em;color:var(--muted)}canvas{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface);cursor:zoom-in}.views[aria-busy=true] canvas{min-height:240px;background:var(--subtle);cursor:wait}.views[aria-busy=true] canvas{animation:pulse 1.5s ease-in-out infinite}#message{padding:12px 16px;background:var(--subtle);border-radius:10px;font-size:13px}#findings,#token-findings{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}#findings:empty,#finding-detail:empty{display:none}#finding-detail{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}details{margin-top:24px;padding-top:18px;border-top:1px solid var(--line);font-size:12px}summary{cursor:pointer;color:var(--muted);width:fit-content}#provenance{font-size:11px;overflow-wrap:anywhere;color:var(--muted);line-height:1.8;max-width:90ch}dialog{width:min(96vw,1800px);height:92vh;max-width:none;max-height:none;padding:20px;border:1px solid var(--line);border-radius:18px;background:var(--bg);color:var(--ink)}dialog::backdrop{background:rgb(12 18 15 / .72)}.lightbox-shell{display:flex;flex-direction:column;height:100%;gap:14px}.lightbox-shell header{padding:0;align-items:center}.lightbox-shell h2{margin:0}.lightbox-shell nav{margin:0;gap:8px}#expand{display:inline-flex;align-items:center;gap:8px}#expand svg{width:16px;height:16px}.lightbox-views{display:flex;flex:1;min-height:0}.reveal-layer{position:absolute;inset:0;pointer-events:none}#reveal-diff{clip-path:inset(0 0 0 var(--split,50%))}#reveal-source{display:none}.reveal-labels{position:absolute;inset:14px 16px auto;display:flex;justify-content:space-between;pointer-events:none;z-index:3}.reveal-labels span{background:var(--surface);border:1px solid var(--line);border-radius:7px;padding:4px 9px;font-size:11px}#reveal-slider{position:absolute;inset:0 auto 0 var(--split,50%);width:44px;transform:translateX(-50%);z-index:4;cursor:ew-resize;touch-action:none}#reveal-slider:before{content:"";position:absolute;left:21px;top:0;bottom:0;width:2px;background:var(--ink)}#reveal-slider:after{content:"↔";position:absolute;left:4px;top:50%;transform:translateY(-50%);width:36px;height:44px;display:grid;place-items:center;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px}#compare-viewport[data-source=true] #reveal-source{display:block;background:var(--subtle)}#compare-viewport[data-source=true] #reveal-diff,#compare-viewport[data-source=true] #reveal-slider,#compare-viewport[data-source=true] .reveal-labels{display:none}#source-toggle[aria-pressed=true]{background:var(--ink);color:var(--surface)}.lightbox-viewport{position:relative;flex:1;min-height:0;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--subtle);touch-action:none;cursor:grab}.lightbox-viewport:active{cursor:grabbing}.lightbox-viewport canvas{position:absolute;left:50%;top:50%;width:auto;max-width:none;height:auto;border:0;border-radius:0;transform-origin:center;cursor:inherit}#zoom-value{min-width:5ch;text-align:center;font-variant-numeric:tabular-nums;font-size:12px}.lightbox-note{margin:0;font-size:11px;color:var(--muted)}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:oklch(19% .006 155);--surface:oklch(23% .008 155);--subtle:oklch(27% .008 155);--ink:oklch(93% .006 155);--muted:oklch(70% .01 155);--line:oklch(34% .009 155);--accent:oklch(78% .08 155);--red:oklch(76% .13 25);--green:oklch(77% .12 155);--warning:oklch(79% .1 75)}}
@media(max-width:760px){main{padding:20px 16px}.views{grid-template-columns:1fr;gap:22px}header{padding-bottom:20px}.identity{gap:12px}nav{gap:10px}.capture-label{width:100%}#capture-choice{max-width:calc(100vw - 100px);flex:1}.legend{order:5;width:100%}dialog{padding:14px;width:98vw;height:96vh;border-radius:14px}.lightbox-shell header h2{font-size:12px}.lightbox-shell button{padding:6px 9px}}
@media(prefers-reduced-motion:reduce){*,*:before{animation:none!important;transition:none!important}}
</style><main><header><div class="identity"><span class="wordmark" aria-label="fx">fx</span><span class="divider" aria-hidden="true">/</span><h1>Compare</h1></div><span id="state" role="status" data-kind="building">Connecting</span></header>
<p id="message" aria-live="polite" hidden></p><nav aria-label="Comparison controls"><label class="capture-label">Capture <select id="capture-choice"><option value="">Latest capture</option></select></label><span class="spacer"></span><label class="toggle"><input id="pixels" type="checkbox" checked> Show changes</label><div class="legend"><span class="red">− Source</span><span class="green">+ Paper</span></div><button id="full" disabled>Reset crop</button><button id="expand" disabled>Expand <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" aria-hidden="true"><rect width="256" height="256" fill="none"/><line x1="64" y1="192" x2="192" y2="64" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><polyline points="88 64 192 64 192 168" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg></button></nav>
<div class="views" aria-busy="true"><figure><h2>Source <span>01</span></h2><canvas id="source"></canvas></figure><figure><h2>Paper <span>02</span></h2><canvas id="paper"></canvas></figure><figure><h2>Changes <span>03</span></h2><canvas id="diff"></canvas></figure></div>
<div id="findings"></div><pre id="finding-detail" style="white-space:pre-wrap;overflow-wrap:anywhere" aria-live="polite"></pre><details id="diagnostics"><summary>Details</summary><p class="muted">Pixel diff is approximate.</p><div id="token-findings"></div><p id="provenance" class="muted"></p></details></main>
<dialog id="lightbox" aria-labelledby="lightbox-title" aria-describedby="lightbox-help"><div class="lightbox-shell"><header><h2 id="lightbox-title">Paper / Changes</h2><button id="lightbox-close" aria-label="Close comparison lightbox">Close · Esc</button></header><nav aria-label="Image zoom"><output id="zoom-value" aria-live="polite">100%</output><button id="zoom-native">100%</button><button id="zoom-fit">Fit / reset</button><span class="spacer"></span><button id="source-toggle" aria-pressed="false" aria-controls="reveal-source">Source</button></nav><div class="lightbox-views"><div id="compare-viewport" class="lightbox-viewport" tabindex="0" aria-label="Comparison, drag or use arrow keys to pan"><div class="reveal-layer"><canvas id="lightbox-paper"></canvas></div><div class="reveal-layer" id="reveal-diff"><canvas id="lightbox-diff"></canvas></div><div class="reveal-layer" id="reveal-source"><canvas id="lightbox-source"></canvas></div><div class="reveal-labels" aria-hidden="true"><span>Paper</span><span>Changes</span></div><div id="reveal-slider" role="slider" tabindex="0" aria-label="Paper and changes reveal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" aria-orientation="horizontal"></div></div></div><p id="lightbox-help" class="lightbox-note">Drag divider to compare · Scroll or pinch to zoom</p></div></dialog>
<script>
const $=id=>document.getElementById(id);let snapshot,images,crop,last='';
const renderer_version=${JSON.stringify(service_version)};
const comparePixels=${comparePixelBuffers.toString()};
const regionsFor=${differenceRegions.toString()};
const overlayMode=document.createElement('select');overlayMode.id='overlay-mode';overlayMode.setAttribute('aria-label','Highlight style');overlayMode.append(new Option('Detail','detail'),new Option('Regions','regions'),new Option('Pixels','pixels'));$('pixels').closest('label').after(overlayMode);overlayMode.onchange=draw;const changedLegend=document.createElement('span');changedLegend.textContent='~ Changed';changedLegend.style.color='oklch(65% .13 75)';document.querySelector('.legend').append(changedLegend);
const load=src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=src});
function draw(){if(!images)return;$('expand').disabled=false;$('full').disabled=!crop;document.querySelector('.views').setAttribute('aria-busy','false');const [a,b]=images;const region=crop||{x:0,y:0,width:Math.max(a.width,b.width),height:Math.max(a.height,b.height)};const width=Math.max(1,Math.ceil(region.width)),height=Math.max(1,Math.ceil(region.height));if(width*height>32000000)throw Error('Image exceeds preview limit');
for(const [id,img] of [['source',a],['paper',b],['diff',b]]){const c=$(id);c.width=width;c.height=height;c.getContext('2d').drawImage(img,region.x,region.y,width,height,0,0,width,height)}
if($('pixels').checked){const x=$('source').getContext('2d').getImageData(0,0,width,height).data,y=$('paper').getContext('2d').getImageData(0,0,width,height).data,ctx=$('diff').getContext('2d'),policy=snapshot?.visual?.sensitivity,comparison=comparePixels(x,y,policy?.pixel_channel_epsilon??${comparisonSensitivity.pixel_channel_epsilon},!policy||policy.antialias?width:undefined);if(overlayMode.value==='regions'){const overlay=document.createElement('canvas');overlay.width=width;overlay.height=height;const ink=overlay.getContext('2d');for(const r of regionsFor(comparison.mask,x,y,width)){const color=r.kind==='changed'?'184,120,28':r.kind==='source'?'195,56,65':'30,142,99';ink.fillStyle='rgba('+color+',.65)';ink.fillRect(r.x,r.y,r.width,r.height)}ctx.save();ctx.filter='blur(0.4px)';ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(overlay,0,0);ctx.restore()}else{const detail=overlayMode.value==='detail',out=detail?ctx.createImageData(width,height):ctx.getImageData(0,0,width,height);for(let i=0;i<x.length;i+=4){if(!comparison.mask[i/4])continue;const removed=x[i]+x[i+1]+x[i+2]<y[i]+y[i+1]+y[i+2];out.data[i]=removed?195:30;out.data[i+1]=removed?56:142;out.data[i+2]=removed?65:99;out.data[i+3]=detail?240:255}if(detail){const overlay=document.createElement('canvas');overlay.width=width;overlay.height=height;overlay.getContext('2d').putImageData(out,0,0);ctx.save();ctx.filter='blur(0.25px)';ctx.drawImage(overlay,0,0);ctx.restore()}else ctx.putImageData(out,0,0)}}if($('lightbox').open)syncLightbox()}
$('full').onclick=()=>{crop=undefined;draw()};$('pixels').onchange=draw;$('expand').onclick=()=>openLightbox('expand');
const lightbox=$('lightbox');let lightbox_scale=1,pan_x=0,pan_y=0,lightbox_opener,prior_overflow='';const pointers=new Map();
function transformLightbox(){for(const id of ['source','paper','diff'])$('lightbox-'+id).style.transform='translate(calc(-50% + '+pan_x+'px),calc(-50% + '+pan_y+'px)) scale('+lightbox_scale+')';$('zoom-value').value=Math.round(lightbox_scale*100)+'%'}
function syncLightbox(){for(const id of ['source','paper','diff']){const source=$(id),target=$('lightbox-'+id);target.width=source.width;target.height=source.height;target.style.width=source.width+'px';target.style.height=source.height+'px';target.getContext('2d').drawImage(source,0,0)}transformLightbox()}
function fitLightbox(){const viewport=document.querySelector('.lightbox-viewport');lightbox_scale=Math.min(1,(viewport.clientWidth-16)/$('source').width,(viewport.clientHeight-16)/$('source').height);lightbox_scale=Math.max(.01,lightbox_scale);pan_x=pan_y=0;transformLightbox()}
function zoomLightbox(factor,x=0,y=0){const next=Math.max(.01,Math.min(16,lightbox_scale*factor)),ratio=next/lightbox_scale;pan_x=x-(x-pan_x)*ratio;pan_y=y-(y-pan_y)*ratio;lightbox_scale=next;transformLightbox()}
function openLightbox(id){if(!images||lightbox.open)return;lightbox_opener=$(id);prior_overflow=document.documentElement.style.overflow;document.documentElement.style.overflow='hidden';$('lightbox-title').textContent=(crop?'Selected region':'Full surface')+' · Paper / Changes';setSource(false);lightbox.showModal();syncLightbox();fitLightbox();$('lightbox-close').focus()}
lightbox.onclose=()=>{document.documentElement.style.overflow=prior_overflow;pointers.clear();lightbox_opener?.focus()};lightbox.oncancel=event=>{event.preventDefault();lightbox.close()};$('lightbox-close').onclick=()=>lightbox.close();$('zoom-native').onclick=()=>{lightbox_scale=1;pan_x=pan_y=0;transformLightbox()};$('zoom-fit').onclick=fitLightbox;
let reveal=50;
function setReveal(value){reveal=Math.max(0,Math.min(100,value));$('compare-viewport').style.setProperty('--split',reveal+'%');$('reveal-slider').setAttribute('aria-valuenow',String(Math.round(reveal)));$('reveal-slider').setAttribute('aria-valuetext',Math.round(reveal)+'% Paper');}
function setSource(active){$('compare-viewport').dataset.source=String(active);$('source-toggle').setAttribute('aria-pressed',String(active));$('lightbox-title').textContent=active?'Source':'Paper / Changes';$('lightbox-help').textContent=active?'Scroll or pinch to zoom · Drag to pan':'Drag divider to compare · Scroll or pinch to zoom';}
$('source-toggle').onclick=()=>setSource($('source-toggle').getAttribute('aria-pressed')!=='true');
const divider=$('reveal-slider');let divider_pointer;
const revealAt=event=>{const bounds=$('compare-viewport').getBoundingClientRect();setReveal((event.clientX-bounds.left)/bounds.width*100)};
divider.onpointerdown=event=>{if(event.button!==0||divider_pointer!==undefined)return;event.preventDefault();event.stopPropagation();divider_pointer=event.pointerId;divider.setPointerCapture(event.pointerId);divider.focus();revealAt(event)};
divider.onpointermove=event=>{if(event.pointerId!==divider_pointer)return;event.stopPropagation();revealAt(event)};
divider.onpointerup=divider.onpointercancel=divider.onlostpointercapture=event=>{if(event.pointerId===divider_pointer){event.stopPropagation();divider_pointer=undefined}};
divider.onkeydown=event=>{const delta={ArrowLeft:-2,ArrowRight:2,ArrowDown:-2,ArrowUp:2}[event.key];if(delta!==undefined||event.key==='Home'||event.key==='End'){event.preventDefault();event.stopPropagation();setReveal(event.key==='Home'?0:event.key==='End'?100:reveal+delta)}};
setReveal(50);
lightbox.onkeydown=event=>{if(event.key==='+'||event.key==='='){event.preventDefault();zoomLightbox(1.5)}if(event.key==='-'){event.preventDefault();zoomLightbox(1/1.5)}};
for(const viewport of document.querySelectorAll('.lightbox-viewport')){
const point=event=>{const rect=viewport.getBoundingClientRect();return {x:event.clientX-rect.left-rect.width/2,y:event.clientY-rect.top-rect.height/2}};
const gesture=()=>{const points=[...pointers.values()].filter(p=>p.viewport===viewport);if(!points.length)return;const [a,b]=points;return b?{x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.hypot(a.x-b.x,a.y-b.y)}:{x:a.x,y:a.y,distance:0}};
viewport.addEventListener('wheel',event=>{event.preventDefault();const p=point(event),unit=event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1;zoomLightbox(Math.exp(-Math.max(-600,Math.min(600,event.deltaY*unit))*.002),p.x,p.y)},{passive:false});
viewport.onpointerdown=event=>{if(event.button!==0||pointers.size>=2)return;pointers.set(event.pointerId,{...point(event),viewport});viewport.setPointerCapture(event.pointerId);viewport.focus()};
viewport.onpointermove=event=>{if(!pointers.has(event.pointerId))return;const before=gesture();pointers.set(event.pointerId,{...point(event),viewport});const after=gesture();if(before.distance>0&&after.distance>0)zoomLightbox(after.distance/before.distance,before.x,before.y);pan_x+=after.x-before.x;pan_y+=after.y-before.y;transformLightbox()};
viewport.onpointerup=viewport.onpointercancel=viewport.onlostpointercapture=event=>pointers.delete(event.pointerId);
viewport.onkeydown=event=>{const delta={ArrowLeft:[32,0],ArrowRight:[-32,0],ArrowUp:[0,32],ArrowDown:[0,-32]}[event.key];if(delta){event.preventDefault();pan_x+=delta[0];pan_y+=delta[1];transformLightbox()}}}
for(const id of ['source','paper','diff']){const canvas=$(id);canvas.tabIndex=0;canvas.setAttribute('role','button');canvas.setAttribute('aria-haspopup','dialog');canvas.setAttribute('aria-label','Open '+id+' comparison lightbox');canvas.onclick=()=>openLightbox(id);canvas.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openLightbox(id)}}}
let refresh_timer;$('capture-choice').onchange=()=>{crop=undefined;last='';clearTimeout(refresh_timer);refresh()};
async function refresh(){try{if(document.hidden)return;const response=await fetch('snapshot'+($('capture-choice').value?'?capture='+encodeURIComponent($('capture-choice').value):''),{cache:'no-store'});if(!response.ok)throw Error('Inspector unavailable');const next=await response.json();if(next.renderer&&next.renderer!==renderer_version){location.reload();return}const choice=$('capture-choice'),selected=choice.value;choice.replaceChildren(new Option('Latest capture',''),...(next.captures||[]).map(capture=>new Option(capture.label,capture.id)));choice.value=selected;const stamp=JSON.stringify(next);if(snapshot&&snapshot.capture_id!==next.capture_id){crop=undefined;$('finding-detail').textContent='';pan_x=0;pan_y=0}snapshot=next;const states={verified:'Verified','needs-repair':'Differences',building:'Preparing',checking:'Comparing',blocked:'Needs attention',outdated:'Snapshot changed'};$('state').textContent=states[next.state]||'Waiting';$('state').dataset.kind=next.state;$('state').title=next.checked_at?'Captured '+new Date(next.checked_at).toLocaleString():'';$('message').textContent='';$('message').hidden=true;$('provenance').textContent='Captured source: '+next.source_url+' · phase: '+next.phase+' · checked: '+next.checked_at+' · source revision: '+next.source_revision+' · canvas revision: '+(next.canvas_revision||'not checked')+'. Snapshots are not continuous surveillance; external Paper edits require a new checkpoint.';
if(stamp!==last){last=stamp;$('findings').replaceChildren();$('token-findings').replaceChildren();for(const finding of next.findings){const button=document.createElement('button');const computed=finding.provenance==='computed-properties';button.textContent=(computed?'Computed · ':'')+(finding.change==='removed'?'− ':finding.change==='added'?'+ ':'')+finding.kind+(finding.property?' · '+finding.property:'');if(computed&&finding.change==='removed')button.className='red';if(computed&&finding.change==='added')button.className='green';button.onclick=()=>{const r=finding.rect;if(r)crop={x:Math.max(0,r.x-12),y:Math.max(0,r.y-12),width:r.width+24,height:r.height+24};$('finding-detail').textContent=(computed?'Computed property evidence; separate from pixel residuals.':'Source capture finding.')+'\\n'+JSON.stringify({property:finding.property,change:finding.change,expected:finding.expected,actual:finding.actual},null,2);draw()};(finding.kind.startsWith('binding-')||finding.kind==='property-unverified'?$('token-findings'):$('findings')).append(button)}if(next.source_image&&next.canvas_image){images=await Promise.all([load(next.source_image),load(next.canvas_image)]);draw()}}
}catch(error){$('state').textContent='Connection lost';$('state').dataset.kind='disconnected';document.querySelector('.views').setAttribute('aria-busy','false');$('message').hidden=false;$('message').textContent=images?'Showing the last capture. Reconnect fx to update.':'Open a diff in fx to connect.'}finally{refresh_timer=setTimeout(refresh,2000)}}refresh();
</script></html>`;

if (import.meta.main && process.argv[2] === "--serve" && process.argv[3]) {
  try { await startService(resolve(process.argv[3]), true); } catch { process.exitCode = 1; }
}
