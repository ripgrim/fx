/** One sensitivity contract for host verification and the inspector overlay.
 * No area allowance or neighbor matching: small missing details still count.
 */
export const comparisonSensitivity = Object.freeze({
  version: 1,
  name: "balanced",
  dimension_epsilon_px: 1 / 32,
  pixel_channel_epsilon: 16,
});

/** Dependency-free so the same implementation can run in capture and inspector
 * browsers. The mask uses one byte per pixel. Callers own its lifetime.
 */
export function comparePixelBuffers(source: ArrayLike<number>, canvas: ArrayLike<number>, channel_epsilon: number) {
  if (source.length !== canvas.length || source.length % 4 || !Number.isInteger(channel_epsilon) || channel_epsilon < 0 || channel_epsilon > 32) throw new Error("Invalid pixel comparison inputs");
  const mask = new Uint8Array(source.length / 4);
  let different_pixels = 0, raw_different_pixels = 0;
  for (let offset = 0; offset < source.length; offset += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) {
      const before = source[offset + channel]!, after = canvas[offset + channel]!;
      if (!Number.isInteger(before) || !Number.isInteger(after) || before < 0 || before > 255 || after < 0 || after > 255) throw new Error("Invalid pixel channel");
      delta = Math.max(delta, Math.abs(before - after));
    }
    if (delta > 0) raw_different_pixels++;
    if (delta > channel_epsilon) { mask[offset / 4] = 1; different_pixels++; }
  }
  return { mask, different_pixels, raw_different_pixels, ignored_pixels: raw_different_pixels - different_pixels };
}
