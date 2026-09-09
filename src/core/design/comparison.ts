/** One sensitivity contract for host verification and the inspector overlay.
 * No area allowance or shifted-pixel matching: small missing details still count.
 */
export const comparisonSensitivity = Object.freeze({
  version: 4,
  name: "lossless",
  dimension_epsilon_px: 1 / 32,
  pixel_channel_epsilon: 0,
  antialias: false,
});

/** Dependency-free so the same implementation can run in capture and inspector
 * browsers. The mask uses one byte per pixel. Callers own its lifetime.
 */
export function comparePixelBuffers(source: ArrayLike<number>, canvas: ArrayLike<number>, channel_epsilon: number, width?: number) {
  if (source.length !== canvas.length || source.length % 4 || !Number.isInteger(channel_epsilon) || channel_epsilon < 0 || channel_epsilon > 32) throw new Error("Invalid pixel comparison inputs");
  if (width !== undefined && (!Number.isInteger(width) || width <= 0 || source.length / 4 % width)) throw new Error("Invalid comparison width");
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
  const antialiased_pixels = 0;
  return { mask, different_pixels, raw_different_pixels, antialiased_pixels, ignored_pixels: raw_different_pixels - different_pixels };
}

/** Presentation only: fine connected tiles preserve the shape of differences.
 * The underlying pixel mask and verification result are never altered. */
export function differenceRegions(mask: ArrayLike<number>, source: ArrayLike<number>, canvas: ArrayLike<number>, width: number) {
  if (!Number.isInteger(width) || width <= 0 || mask.length % width || source.length !== mask.length * 4 || canvas.length !== source.length) throw new Error("Invalid region inputs");
  const size = 2, columns = Math.ceil(width / size), height = mask.length / width;
  const rows = Math.ceil(height / size), cells = new Uint8Array(columns * rows);
  for (let p = 0; p < mask.length; p++) if (mask[p]) cells[Math.floor(p / width / size) * columns + Math.floor(p % width / size)] = 1;
  const regions: { x: number; y: number; width: number; height: number; kind: string }[] = [];
  for (let cell = 0; cell < cells.length; cell++) {
    if (cells[cell] !== 1) continue;
    const queue = [cell]; cells[cell] = 2;
    let removed = 0, added = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor]!, cx = index % columns, cy = Math.floor(index / columns);
      for (let y = cy * size; y < Math.min(height, (cy + 1) * size); y++) for (let x = cx * size; x < Math.min(width, (cx + 1) * size); x++) {
        const p = y * width + x, i = p * 4;
        if (!mask[p]) continue;
        if (source[i]! + source[i + 1]! + source[i + 2]! < canvas[i]! + canvas[i + 1]! + canvas[i + 2]!) removed++; else added++;
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy, next = ny * columns + nx;
        if (nx >= 0 && nx < columns && ny >= 0 && ny < rows && cells[next] === 1) { cells[next] = 2; queue.push(next); }
      }
    }
    // Preserve the footprint, including hollow interiors, instead of filling its
    // bounding box. Coalesce horizontal tile runs for bounded drawing work.
    const kind = Math.min(removed, added) > (removed + added) * .2 ? "changed" : removed > added ? "source" : "paper";
    queue.sort((a, b) => a - b);
    for (let q = 0; q < queue.length;) {
      const start = queue[q++]!, row = Math.floor(start / columns); let end = start;
      while (q < queue.length && queue[q] === end + 1 && Math.floor(queue[q]! / columns) === row) end = queue[q++]!;
      const x = start % columns * size, y = row * size;
      regions.push({ x, y, width: Math.min(width, (end % columns + 1) * size) - x, height: Math.min(size, height - y), kind });
    }
  }
  return regions;
}
