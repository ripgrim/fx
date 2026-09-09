/** Instance intent is persistent; Paper edits never redefine its reference. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export type Rect = { x: number; y: number; width: number; height: number };
export type ComponentReference = {
  node_id: string;
  component_file: string;
  export_name: string;
  props: Record<string, unknown>;
  theme: string;
  state: string;
  sizing: "intrinsic" | "stretch";
  preview: { url: string; selector: string; width: number; height: number; ready_selector?: string; container_selector?: string };
};
export type InstanceResult = {
  node_id: string; label: string; status: "consistent" | "drift" | "unlinked" | "unavailable";
  reference?: ComponentReference;
  reference_size?: { width: number; height: number };
  rect?: Rect; message?: string; different_pixels?: number; reference_image?: string; paper_image?: string; backdrop?: string;
};
export type ComponentReport = {
  instances: InstanceResult[]; checked: number; linked: number; unlinked_regions: number;
  overlay_image: string; source_revision: string;
};
const key = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validateReference(value: ComponentReference, files: Record<string, string>) {
  if (!value || typeof value.component_file !== "string" || !/\.[cm]?[jt]sx?$/.test(value.component_file) || !Object.hasOwn(files, value.component_file) || typeof value.export_name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(value.export_name)) throw Error("Select an existing component file and export");
  if (typeof value.node_id !== "string" || !value.node_id.trim() || typeof value.theme !== "string" || !value.theme.trim() || typeof value.state !== "string" || !value.state.trim() || !value.props || typeof value.props !== "object" || Array.isArray(value.props)) throw Error("Record the instance props, theme and state explicitly");
  if (!["intrinsic", "stretch"].includes(value.sizing)) throw Error("Choose intrinsic or stretch sizing");
  const preview = value.preview;
  if (!preview || !/^https?:$/.test(new URL(preview.url).protocol) || !preview.selector?.trim() || ![preview.width, preview.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw Error("Provide the real rendered example URL, selector and viewport");
  if (value.sizing === "stretch" && !preview.container_selector?.trim()) throw Error("Stretch references require an isolated container selector");
  if (JSON.stringify(value).length > 65536) throw Error("Component reference exceeds limit");
}

export class InstanceRegistry {
  readonly directory: string;
  constructor(root: string, workspace: string, file: string, artboard: string) {
    this.directory = join(root, key([workspace, file, artboard]));
  }
  async list(): Promise<ComponentReference[]> {
    const entries = await readdir(this.directory).catch((error: any) => { if (error.code === "ENOENT") return []; throw error; });
    const names = entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    if (names.length > 100) throw Error("Design exceeds 100 linked instances");
    return Promise.all(names.map(async name => {
      const text = await readFile(join(this.directory, name), "utf8");
      if (text.length > 65536) throw Error("Component reference exceeds limit");
      const value = JSON.parse(text);
      if (key(value.node_id) + ".json" !== name) throw Error("Component link identity mismatch");
      return value;
    }));
  }
  async link(reference: ComponentReference, replace = false) {
    const existing = await this.list();
    if (existing.length >= 100 && !existing.some(item => item.node_id === reference.node_id)) throw Error("Design exceeds 100 linked instances");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, key(reference.node_id) + ".json");
    const data = JSON.stringify(reference);
    try { await writeFile(path, data, { flag: "wx", mode: 0o600 }); return; }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
    if (await readFile(path, "utf8") === data) return;
    if (!replace) throw Error("Instance already linked. Change its intended reference explicitly with replace: true");
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
}

export function localRect(node: any, board: any): Rect {
  const values = [node.worldX, node.worldY, node.width, node.height, board.worldX, board.worldY];
  if (values.some(n => typeof n !== "number" || !Number.isFinite(n)) || node.width <= 0 || node.height <= 0) throw Error("Paper geometry unavailable");
  return { x: node.worldX - board.worldX, y: node.worldY - board.worldY, width: node.width, height: node.height };
}

/** Browser-side composition: compare local images, project only residuals onto the design. */
export async function renderComponentOverlay(boardImage: string, instances: InstanceResult[], compare: Function, boardSize?: { width: number; height: number }) {
  const load = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
  const board = await load(boardImage);
  if (board.width * board.height > 32000000) throw Error("Design exceeds pixel limit");
  if (boardSize && (board.width !== Math.ceil(boardSize.width) || board.height !== Math.ceil(boardSize.height))) throw Error("Paper export geometry does not match the design");
  const overlay = document.createElement("canvas"); overlay.width = board.width; overlay.height = board.height;
  const ink = overlay.getContext("2d")!;
  for (const instance of instances) {
    if (!instance.rect || !instance.reference_image) continue;
    const rect = instance.rect, left = Math.round(rect.x), top = Math.round(rect.y);
    const crop = document.createElement("canvas"); crop.width = Math.max(1, Math.round(rect.width)); crop.height = Math.max(1, Math.round(rect.height));
    if (left < 0 || top < 0 || left + crop.width > board.width || top + crop.height > board.height) {
      instance.status = "unavailable"; instance.message = "Instance is clipped by the artboard"; continue;
    }
    // Node-only Paper exports can lose ancestor layout and clip text. The one
    // full-design PNG is authoritative for every instance and its placement.
    crop.getContext("2d")!.drawImage(board, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
    instance.paper_image = crop.toDataURL("image/png");
    const [a, b] = await Promise.all([load(instance.reference_image), load(instance.paper_image)]);
    const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
    if (width * height > 32000000) throw Error("Instance exceeds pixel limit");
    const pixels = (image: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = width; c.height = height; const ctx = c.getContext("2d")!; ctx.fillStyle = instance.backdrop ?? "white"; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, width, height).data; };
    const x = pixels(a), y = pixels(b), diff = compare(x, y, 0, width);
    instance.different_pixels = diff.different_pixels;
    const dimensionsMatch = instance.reference_size
      ? Math.abs(instance.reference_size.width - rect.width) <= 1 / 32 && Math.abs(instance.reference_size.height - rect.height) <= 1 / 32
      : a.width === b.width && a.height === b.height;
    instance.status = diff.different_pixels === 0 && dimensionsMatch ? "consistent" : "drift";
    const mask = document.createElement("canvas"); mask.width = width; mask.height = height;
    const ctx = mask.getContext("2d")!, data = ctx.createImageData(width, height);
    for (let i = 0; i < diff.mask.length; i++) if (diff.mask[i]) {
      const p = i * 4, removed = x[p] + x[p + 1] + x[p + 2] < y[p] + y[p + 1] + y[p + 2];
      data.data.set(removed ? [195, 56, 65, 240] : [30, 142, 99, 240], p);
    }
    ctx.putImageData(data, 0, 0);
    // Never stretch a reference to fit the design. That would hide size drift.
    ink.drawImage(mask, Math.round(instance.rect.x), Math.round(instance.rect.y));
    if (!dimensionsMatch) {
      ink.strokeStyle = "rgb(195 56 65)";
      ink.strokeRect(Math.round(instance.rect.x) + .5, Math.round(instance.rect.y) + .5, a.width - 1, a.height - 1);
      ink.strokeStyle = "rgb(30 142 99)";
      ink.strokeRect(Math.round(instance.rect.x) + .5, Math.round(instance.rect.y) + .5, b.width - 1, b.height - 1);
    }
  }
  return { instances, overlay_image: overlay.toDataURL("image/png") };
}
