import { expect, test } from "bun:test";
import { comparePixelBuffers, comparisonSensitivity, differenceRegions } from "./comparison";
import { Browser, compareImages } from "./helper";

test("balanced pixel comparison ignores low-intensity noise and preserves exact diagnostics", () => {
  const source = [255, 255, 255, 255, 100, 100, 100, 255];
  const result = comparePixelBuffers(source, [239, 250, 255, 255, 101, 100, 100, 255], comparisonSensitivity.pixel_channel_epsilon);
  expect(result.different_pixels).toBe(0);
  expect(result.raw_different_pixels).toBe(2);
  expect(result.ignored_pixels).toBe(2);
  expect(Array.from(result.mask)).toEqual([0, 0]);
  expect(comparePixelBuffers(source, source, 0).raw_different_pixels).toBe(0);
});

test("one missing pixel or a thin low-contrast border is not hidden by image area", () => {
  const source = new Uint8Array(40000).fill(255), canvas = source.slice();
  // Same gray-green contrast as the live avatar ring, only one pixel wide.
  for (let offset = 0; offset < 400; offset += 4) source.set([211, 218, 215, 255], offset);
  const result = comparePixelBuffers(source, canvas, comparisonSensitivity.pixel_channel_epsilon);
  expect(result.different_pixels).toBe(100);
  expect(result.mask[99]).toBe(1);
  canvas.set(source);
  canvas[1000] = 0;
  expect(comparePixelBuffers(source, canvas, comparisonSensitivity.pixel_channel_epsilon).different_pixels).toBe(1);
});

test("threshold boundary and invalid evidence fail predictably", () => {
  expect(comparePixelBuffers([0, 0, 0, 255], [17, 0, 0, 255], 16).different_pixels).toBe(1);
  expect(() => comparePixelBuffers([1], [1], 16)).toThrow();
  expect(() => comparePixelBuffers([NaN, 0, 0, 255], [0, 0, 0, 255], 16)).toThrow();
  expect(() => comparePixelBuffers([], [], 255)).toThrow();
});

test("region highlights group displaced edges without erasing thin borders", () => {
  const source = new Uint8Array(32 * 24 * 4).fill(255), canvas = source.slice();
  for (let y = 2; y < 20; y++) {
    source.set([0, 0, 0, 255], (y * 32 + 10) * 4);
    canvas.set([0, 0, 0, 255], (y * 32 + 12) * 4);
  }
  const result = comparePixelBuffers(source, canvas, comparisonSensitivity.pixel_channel_epsilon);
  expect(result.different_pixels).toBe(36);
  const regions = differenceRegions(result.mask, source, canvas, 32);
  expect(regions).toHaveLength(9);
  expect(regions[0]).toEqual({ x: 10, y: 2, width: 4, height: 2, kind: "changed" });
  expect(() => differenceRegions(result.mask, source, canvas, 0)).toThrow();
});

test("antialias filtering preserves geometry and only removes shared edge shades", () => {
  const source = new Uint8Array(5 * 5 * 4).fill(255);
  for (let y = 0; y < 5; y++) {
    source.set([0,0,0,255], (y * 5 + 1) * 4);
    source.set([100,100,100,255], (y * 5 + 2) * 4);
  }
  const canvas = source.slice();
  for (let y = 0; y < 5; y++) canvas.set([150,150,150,255], (y * 5 + 2) * 4);
  expect(comparePixelBuffers(source, canvas, 24).different_pixels).toBe(5);
  expect(comparePixelBuffers(source, canvas, 24, 5).antialiased_pixels).toBe(5);
  canvas.set([150,180,150,255], 2 * 4);
  expect(comparePixelBuffers(source, canvas, 24, 5).mask[2]).toBe(1);
  canvas.set([150,150,150,180], 2 * 4);
  expect(comparePixelBuffers(source, canvas, 24, 5).mask[2]).toBe(1);
  for (let y = 0; y < 5; y++) canvas.set([255,255,255,255], (y * 5 + 1) * 4);
  expect(comparePixelBuffers(source, canvas, 24, 5).different_pixels).toBeGreaterThanOrEqual(5);
  expect(() => comparePixelBuffers(source, canvas, 24, 3)).toThrow();
});

test("antialias filtering does not erase a one-pixel stroke shift", () => {
  const source = new Uint8Array(8 * 8 * 4).fill(255), canvas = source.slice();
  for (let y = 0; y < 8; y++) {
    source.set([0,0,0,255], (y * 8 + 2) * 4);
    canvas.set([0,0,0,255], (y * 8 + 3) * 4);
  }
  const result = comparePixelBuffers(source, canvas, 24, 8);
  expect(result.different_pixels).toBe(16);
  expect(result.antialiased_pixels).toBe(0);
});

test("fine regions leave hollow shapes and neighboring whitespace clear", () => {
  const source = new Uint8Array(32 * 32 * 4).fill(255), canvas = source.slice();
  for (let y = 2; y < 30; y++) for (let x = 2; x < 30; x++) if (x === 2 || x === 29 || y === 2 || y === 29) source.set([0,0,0,255], (y * 32 + x) * 4);
  const result = comparePixelBuffers(source, canvas, 24, 32);
  const regions = differenceRegions(result.mask, source, canvas, 32);
  expect(regions.some(r => r.x <= 16 && r.x + r.width > 16 && r.y <= 16 && r.y + r.height > 16)).toBe(false);
  expect(result.different_pixels).toBe(108);
});

test("new threshold removes faint residuals but retains a missing border", () => {
  expect(comparePixelBuffers([255,255,255,255], [232,232,232,255], comparisonSensitivity.pixel_channel_epsilon).different_pixels).toBe(0);
  expect(comparePixelBuffers([211,218,215,255], [255,255,255,255], comparisonSensitivity.pixel_channel_epsilon).different_pixels).toBe(1);
});

test("host image comparison applies sensitivity while mismatched image sizes cannot pass", async () => {
  const browser = new Browser(`fx-sensitivity-${crypto.randomUUID()}`);
  let images: string[];
  try {
    await browser.call("open", "about:blank");
    images = await browser.evaluate(`['#ffffff','#f7f7f7','#d3dad7'].map(color=>{const c=document.createElement('canvas');c.width=c.height=28;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,28,28);return c.toDataURL()}).concat((()=>{const c=document.createElement('canvas');c.width=29;c.height=28;const ctx=c.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,29,28);return c.toDataURL()})())`);
  } finally { await browser.call("close").catch(() => undefined); }
  const noise = await compareImages(images![0]!, images![1]!);
  expect(noise.match).toBe(true);
  expect(noise.raw_different_pixels).toBe(784);
  expect(noise.ignored_pixels).toBe(784);
  expect(noise.sensitivity).toEqual(comparisonSensitivity);
  expect((await compareImages(images![0]!, images![2]!)).match).toBe(false);
  expect((await compareImages(images![0]!, images![3]!)).dimensions_match).toBe(false);
}, 60000);
