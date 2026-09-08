import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./helper";
import { Inspector, type VerificationSnapshot } from "./inspector";
import { comparisonSensitivity } from "./comparison";

test("inspector renders actual snapshots, focuses findings and fits narrow viewports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fx-inspector-browser-"));
  const browser = new Browser(`fx-inspector-${crypto.randomUUID()}`);
  const inspector = new Inspector();
  try {
    await browser.call("open", "about:blank");
    const images = await browser.evaluate(`(()=>{const c=document.createElement('canvas');c.width=240;c.height=120;const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,240,120);const paper=c.toDataURL();ctx.fillStyle='#f7f7f7';ctx.fillRect(1,1,1,1);ctx.strokeStyle='#777';ctx.lineWidth=1;ctx.strokeRect(15.5,15.5,28,28);return {paper,source:c.toDataURL()}})()`);
    const snapshot: VerificationSnapshot = { version: 1, capture_id: "fixture", phase: "import", state: "needs-repair", source_url: "http://localhost/fixture", source_revision: "a".repeat(64), checked_at: new Date().toISOString(), message: "Isolated fixture comparison", source_image: images.source, canvas_image: images.paper, findings: [{ kind: "Fixture border evidence", rect: { x: 15, y: 15, width: 28, height: 28 } }] };
    snapshot.findings.push({ kind: "binding-ambiguous", property: "font-family" }, { kind: "binding-unverified", property: "color" });
    const view = await inspector.publish(directory, snapshot);
    await browser.call("open", view.url);
    await browser.evaluate(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(document.querySelector('#source').width===240){clearInterval(timer);resolve(true)}else if(++attempts>100){clearInterval(timer);reject(Error('Preview did not load'))}},50)})`);
    expect(await browser.evaluate(`document.querySelector('#overlay-mode').value`)).toBe("regions");
    expect(await browser.evaluate(`(()=>{const p=document.querySelector('#diff').getContext('2d').getImageData(16,15,1,1).data;return p[0]>p[1]})()`)).toBe(true);
    await browser.evaluate(`document.querySelector('#overlay-mode').value='pixels';document.querySelector('#overlay-mode').dispatchEvent(new Event('change'))`);
    expect(await browser.evaluate(`document.querySelector('#diagnostics').open`)).toBe(false);
    expect(await browser.evaluate(`document.querySelector('#token-findings').children.length`)).toBe(2);
    expect(await browser.evaluate(`document.querySelector('#findings').children.length`)).toBe(1);
    expect(await browser.evaluate(`document.querySelector('#token-findings button').checkVisibility()`)).toBe(false);
    await browser.evaluate(`document.querySelector('#diagnostics summary').click()`);
    expect(await browser.evaluate(`document.querySelector('#token-findings button').checkVisibility()`)).toBe(true);
    await browser.evaluate(`document.querySelector('#diagnostics summary').click()`);
    // A preview without comparison metadata uses the current default tolerance;
    // rendering it does not change the stored verification result.
    expect(await browser.evaluate(`document.querySelector('#diff').getContext('2d').getImageData(1,1,1,1).data[0]`)).toBe(255);
    snapshot.visual = { sensitivity: comparisonSensitivity, different_pixels: 112, total_pixels: 28800, dimensions_match: true, match: false };
    await inspector.publish(directory, snapshot);
    await browser.evaluate(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(document.querySelector('#diff').getContext('2d').getImageData(1,1,1,1).data[0]===255){clearInterval(timer);resolve(true)}else if(++attempts>100){clearInterval(timer);reject(Error('Sensitivity did not update'))}},50)})`);
    expect(await browser.evaluate(`document.querySelector('#diff').getContext('2d').getImageData(1,1,1,1).data[0]`)).toBe(255);
    expect(await browser.evaluate(`document.querySelector('#diff').getContext('2d').getImageData(16,15,1,1).data[0]`)).toBe(195);
    await browser.evaluate(`document.querySelector('#findings button').click()`);
    expect(await browser.evaluate(`document.querySelector('#source').width`)).toBe(52);
    await browser.evaluate(`document.querySelector('#source').focus();document.querySelector('#source').click()`);
    expect(await browser.evaluate(`document.querySelector('#lightbox').open`)).toBe(true);
    expect(await browser.evaluate(`document.querySelector('#lightbox-source').width`)).toBe(52);
    await browser.evaluate(`document.querySelector('#zoom-native').click();const v=document.querySelector('.lightbox-viewport'),r=v.getBoundingClientRect();v.dispatchEvent(new WheelEvent('wheel',{deltaY:-200,clientX:r.left+r.width/2,clientY:r.top+r.height/2,cancelable:true}))`);
    expect(await browser.evaluate(`document.querySelector('#zoom-value').value`)).toBe("149%");
    expect(await browser.evaluate(`document.querySelector('#zoom-in')===null&&document.querySelector('#zoom-out')===null`)).toBe(true);
    await browser.evaluate(`document.querySelector('#zoom-native').click();document.querySelector('.lightbox-viewport').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}))`);
    expect(await browser.evaluate(`(()=>{const transforms=['source','paper','diff'].map(id=>document.querySelector('#lightbox-'+id).style.transform);return transforms[0].includes('32px')&&transforms.every(value=>value===transforms[0])})()`)).toBe(true);
    // Synthetic touch pointers exercise centroid pan and pinch scale together.
    await browser.evaluate(`(()=>{document.querySelector('#zoom-native').click();const v=document.querySelector('.lightbox-viewport');v.setPointerCapture=()=>{};const send=(type,id,x)=>v.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:100}));send('pointerdown',1,100);send('pointerdown',2,200);send('pointermove',2,300);send('pointerup',2,300);send('pointercancel',1,100)})()`);
    expect(await browser.evaluate(`document.querySelector('#zoom-value').value`)).toBe("200%");
    expect(await browser.evaluate(`(()=>{const v=document.querySelector('.lightbox-viewport'),send=(type,id,x)=>v.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:100}));const before=pan_x;send('pointerdown',1,100);send('pointerdown',2,300);send('pointermove',1,120);send('pointermove',2,320);send('pointerup',1,120);send('pointerup',2,320);return Math.abs(pan_x-before-20)<.001&&Math.abs(lightbox_scale-2)<.001})()`)).toBe(true);
    expect(await browser.evaluate(`(()=>{const transforms=['source','paper','diff'].map(id=>document.querySelector('#lightbox-'+id).style.transform);return transforms.every(value=>value===transforms[0])})()`)).toBe(true);
    await browser.call("press", "Escape");
    expect(await browser.evaluate(`!document.querySelector('#lightbox').open&&document.activeElement.id==='source'&&document.querySelector('#source').width===52`)).toBe(true);
    await browser.evaluate(`document.querySelector('#full').click();document.querySelector('#pixels').click()`);
    expect(await browser.evaluate(`document.querySelector('#source').width`)).toBe(240);
    expect(await browser.evaluate(`document.querySelector('#diff').getContext('2d').getImageData(16,15,1,1).data[0]`)).toBe(255);
    await browser.evaluate(`document.querySelector('#source').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`);
    expect(await browser.evaluate(`document.querySelector('#lightbox-source').width`)).toBe(240);
    await browser.evaluate(`document.querySelector('#lightbox-close').click()`);
    await browser.evaluate(`document.querySelector('#full').click()`);
    for (const width of [1024, 736, 360]) {
      await browser.call("set", "viewport", String(width), "900");
      expect(await browser.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true);
      await browser.evaluate(`document.querySelector('#diff').click()`);
      expect(await browser.evaluate(`document.querySelector('#lightbox').scrollWidth<=document.querySelector('#lightbox').clientWidth`)).toBe(true);
      await browser.evaluate(`document.querySelector('#zoom-fit').click();document.querySelector('#lightbox-close').click()`);
    }
    if (process.env.FX_INSPECTOR_SCREENSHOT) await browser.call("screenshot", "body", process.env.FX_INSPECTOR_SCREENSHOT);
  } finally { await browser.call("close").catch(() => undefined); await inspector.close(); await rm(directory, { recursive: true, force: true }); }
}, 120000);
