/** Property evidence is independent of screenshot encoding and model opinions. */
import { comparisonSensitivity } from "./comparison";
export type Rect = { x: number; y: number; width: number; height: number };
export type Border = { width: number; style: string; rgba: number[] };
export type PropertyEvidence = {
  width: number;
  height: number;
  borders: Record<"top" | "right" | "bottom" | "left", Border>;
};
export type PropertyFinding = {
  kind: "property-mismatch" | "property-unverified";
  provenance: "computed-properties";
  key: string;
  property: string;
  change?: "removed" | "added" | "changed";
  expected?: unknown;
  actual?: unknown;
  rect?: Rect;
};
export type PropertyComparison = {
  status: "match" | "different" | "unverified";
  scope: "dimensions-and-borders";
  checked_properties: number;
  findings: PropertyFinding[];
  fidelity_claim: false;
};

export type SourceManifestEntry = { key: string; label: string; name: string; styles: Record<string, string>; width: number; height: number; rect?: Rect };
export type SourceBinding = { key: string; node_id: string; capture_id: string; artboard_id: string; file_id?: string; source_revision: string; operation_hash: string; provenance: "import-receipt" };

/** Only the host calls this with the actual admitted write_html receipt.
 * Temporary labels are exact identities, not fuzzy names or visual matches.
 * Return renames for normal permission-checked Paper dispatch, never mutate here.
 */
export function bindImportReceipt(manifest: SourceManifestEntry[], receipt: { createdNodes?: { id: string; name: string }[] }, scope: Omit<SourceBinding, "key" | "node_id" | "provenance">) {
  const bindings: SourceBinding[] = [], renames: { nodeId: string; name: string }[] = [], findings: PropertyFinding[] = [];
  const keys = new Set<string>(), labels = new Set<string>(), ids = new Set<string>();
  if (!scope.capture_id || !scope.artboard_id || !scope.source_revision || !scope.operation_hash) throw new Error("Import mapping requires host scope");
  for (const entry of manifest) {
    if (keys.has(entry.key) || labels.has(entry.label)) throw new Error("Duplicate source identity in import manifest");
    keys.add(entry.key); labels.add(entry.label);
    const candidates = (receipt.createdNodes ?? []).filter(node => node.name === entry.label && typeof node.id === "string" && node.id);
    if (candidates.length !== 1 || ids.has(candidates[0]!.id)) {
      findings.push({ kind: "property-unverified", provenance: "computed-properties", key: entry.key, property: "import-mapping", rect: entry.rect });
      continue;
    }
    const node_id = candidates[0]!.id;
    ids.add(node_id);
    bindings.push({ ...scope, key: entry.key, node_id, provenance: "import-receipt" });
    renames.push({ nodeId: node_id, name: entry.name });
  }
  return { bindings, renames, findings };
}

/** Reject cross-capture, stale-source or duplicate bindings before any readback. */
export function validateBindings(bindings: SourceBinding[], scope: { capture_id: string; artboard_id: string; file_id?: string; source_revision: string }) {
  const keys = new Set<string>(), ids = new Set<string>();
  for (const binding of bindings) {
    if (binding.provenance !== "import-receipt" || !binding.operation_hash || !binding.node_id || binding.capture_id !== scope.capture_id || binding.artboard_id !== scope.artboard_id || binding.file_id !== scope.file_id || binding.source_revision !== scope.source_revision || keys.has(binding.key) || ids.has(binding.node_id)) throw new Error("Untrusted or stale source-to-Paper binding");
    keys.add(binding.key); ids.add(binding.node_id);
  }
}

/** Read-only, bounded live readback. Caller must check canvas revision around
 * this operation before presenting it as current checkpoint evidence.
 */
export async function readBoundProperties(manifest: SourceManifestEntry[], bindings: SourceBinding[], scope: { capture_id: string; artboard_id: string; source_revision: string; file_id: string }, read: (name: string, args: Record<string, unknown>) => Promise<any>, normalize: (rows: { styles: Record<string, string>; width: number; height: number }[]) => Promise<(PropertyEvidence | null)[]>) {
  validateBindings(bindings, scope);
  if (!scope.file_id || manifest.length > 1000 || bindings.length > 1000) throw new Error("Property readback requires a bounded linked artboard");
  const object = (response: any) => {
    if (response?.isError) throw new Error("Paper readback failed");
    const value = response?.structuredContent ?? JSON.parse((response?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing Paper property evidence");
    return value;
  };
  const members = new Set([scope.artboard_id]), queue = [scope.artboard_id];
  for (let index = 0; index < queue.length; index++) {
    const current = object(await read("get_children", { nodeId: queue[index], fileId: scope.file_id }));
    if (!Array.isArray(current.children)) throw new Error("Incomplete Paper membership evidence");
    for (const node of current.children) {
      if (typeof node.id !== "string" || !node.id || members.has(node.id)) throw new Error("Invalid Paper membership evidence");
      members.add(node.id); queue.push(node.id);
      if (members.size > 2000) throw new Error("Property readback exceeds artboard limit");
    }
  }
  const findings: PropertyFinding[] = [];
  let checked_properties = 0;
  for (const entry of manifest) {
    const binding = bindings.find(item => item.key === entry.key);
    if (!binding) { findings.push({ kind: "property-unverified", provenance: "computed-properties", key: entry.key, property: "import-mapping", rect: entry.rect }); continue; }
    if (!members.has(binding.node_id)) { findings.push({ kind: "property-mismatch", provenance: "computed-properties", key: entry.key, property: "mapped-node", change: "removed", expected: "present in linked artboard", actual: "absent from linked artboard", rect: entry.rect }); continue; }
    const info = object(await read("get_node_info", { nodeId: binding.node_id, fileId: scope.file_id }));
    if (info.id !== binding.node_id) throw new Error("Paper returned another node identity");
    const styles = object(await read("get_computed_styles", { nodeIds: [binding.node_id], fileId: scope.file_id })).styles?.[binding.node_id];
    if (!styles || typeof styles !== "object") throw new Error("Missing computed styles");
    const values = await normalize([{ styles: entry.styles, width: entry.width, height: entry.height }, { styles, width: info.width, height: info.height }]);
    const comparison = compareProperties(entry.key, values[0] ?? undefined, values[1] ?? undefined, entry.rect);
    findings.push(...comparison.findings); checked_properties += comparison.checked_properties;
  }
  if (!manifest.length) findings.push({ kind: "property-unverified", provenance: "computed-properties", key: "", property: "import-mapping" });
  return { status: findings.some(finding => finding.kind === "property-mismatch") ? "different" : findings.length ? "unverified" : "match", scope: "dimensions-and-borders", findings, checked_properties, fidelity_claim: false } as PropertyComparison;
}

/** Inputs must come from a host-bound source identity and current Paper readback.
 * No matching by geometry: doing so would hide the geometry regression itself.
 * A match covers only the listed properties, never whole-design fidelity.
 */
export function compareProperties(key: string, expected: PropertyEvidence | undefined, actual: PropertyEvidence | undefined, rect?: Rect): PropertyComparison {
  const findings: PropertyFinding[] = [];
  let checked_properties = 0;
  const unresolved = (property: string) => findings.push({ kind: "property-unverified", provenance: "computed-properties", key, property, rect });
  const mismatch = (property: string, before: unknown, after: unknown, change: PropertyFinding["change"] = "changed") => findings.push({ kind: "property-mismatch", provenance: "computed-properties", key, property, change, expected: before, actual: after, rect });
  if (!expected || !actual) unresolved("mapped-node");
  else {
    for (const property of ["width", "height"] as const) {
      const before = expected[property], after = actual[property];
      if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < 0) { unresolved(property); continue; }
      checked_properties++;
      if (Math.abs(before - after) > comparisonSensitivity.dimension_epsilon_px) mismatch(property, before, after);
    }
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const before = expected.borders?.[side], after = actual.borders?.[side];
      const valid = (border: Border | undefined): border is Border => Boolean(border && Number.isFinite(border.width) && border.width >= 0 && ["none", "hidden", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"].includes(border.style) && border.rgba?.length === 4 && border.rgba.every(value => Number.isFinite(value) && value >= 0 && value <= 255));
      if (!valid(before) || !valid(after)) { unresolved(`border-${side}`); continue; }
      const visible = (border: Border) => border.width > 0 && !["none", "hidden"].includes(border.style) && border.rgba[3]! > 0;
      checked_properties++;
      if (!visible(before) && !visible(after)) continue;
      if (!visible(after)) { mismatch(`border-${side}`, before, after, "removed"); continue; }
      if (!visible(before)) { mismatch(`border-${side}`, before, after, "added"); continue; }
      if (Math.abs(before.width - after.width) > 0.01 || before.style !== after.style || before.rgba.some((value, index) => value !== after.rgba[index])) mismatch(`border-${side}`, before, after);
    }
  }
  return { status: findings.some(finding => finding.kind === "property-mismatch") ? "different" : findings.length ? "unverified" : "match", scope: "dimensions-and-borders", checked_properties, findings, fidelity_claim: false };
}

/** Runs in an isolated browser page. All dependencies intentionally local.
 * Browser color conversion makes equivalent CSS spellings comparable in sRGB.
 * Reject unsupported declarations rather than silently comparing defaults.
 */
export function normalizePropertyStyles(rows: { styles: Record<string, string>; width: number; height: number }[]): (PropertyEvidence | null)[] {
  return rows.map(row => {
    const element = document.createElement("div");
    element.style.cssText = "all:initial;position:absolute;box-sizing:border-box;color:black";
    for (const [name, value] of Object.entries(row.styles)) {
      const property = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      if (!(property.startsWith("border") || property === "color")) continue;
      if (!CSS.supports(property, value) || /var\(|currentcolor/i.test(value)) return null;
      element.style.setProperty(property, value);
    }
    document.body.append(element);
    try {
      const computed = getComputedStyle(element);
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const borders = {} as PropertyEvidence["borders"];
      for (const side of ["top", "right", "bottom", "left"] as const) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = computed.getPropertyValue(`border-${side}-color`);
        context.fillRect(0, 0, 1, 1);
        borders[side] = { width: parseFloat(computed.getPropertyValue(`border-${side}-width`)), style: computed.getPropertyValue(`border-${side}-style`), rgba: Array.from(context.getImageData(0, 0, 1, 1).data) };
      }
      return { width: row.width, height: row.height, borders };
    } finally { element.remove(); }
  });
}
