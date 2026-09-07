import { expect, test } from "bun:test";
import { compareProperties, normalizePropertyStyles, bindImportReceipt, validateBindings, readBoundProperties, type PropertyEvidence } from "./property_diff";
import { Browser, serialize, type DesignNode } from "./helper";

test("receipt mapping survives readable duplicate names without using geometry", () => {
  const root: DesignNode = { key: "0", name: "avatar", tag: "div", text: "", styles: {}, bindings: {}, rect: { x: 0, y: 0, width: 28, height: 28 }, children: [] };
  root.children.push({ ...root, key: "0/0", children: [] });
  const output = serialize(root, {}, "capture");
  expect(output.manifest).toHaveLength(2);
  expect(output.manifest[0]!.label).not.toBe(output.manifest[1]!.label);
  const scope = { capture_id: "capture", artboard_id: "artboard", source_revision: "source", operation_hash: "admitted-operation" };
  const result = bindImportReceipt(output.manifest, { createdNodes: output.manifest.map((entry, index) => ({ id: `paper-${index}`, name: entry.label })) }, scope);
  expect(result.findings).toEqual([]);
  expect(result.renames).toEqual([{ nodeId: "paper-0", name: "avatar" }, { nodeId: "paper-1", name: "avatar" }]);
  expect(() => validateBindings(result.bindings, scope)).not.toThrow();
  expect(() => validateBindings(result.bindings, { ...scope, source_revision: "changed" })).toThrow();
  const ambiguous = bindImportReceipt(output.manifest, { createdNodes: [{ id: "one", name: output.manifest[0]!.label }, { id: "two", name: output.manifest[0]!.label }] }, scope);
  expect(ambiguous.bindings).toEqual([]);
  expect(ambiguous.findings).toHaveLength(2);
});

const evidence = (): PropertyEvidence => ({ width: 28, height: 28, borders: Object.fromEntries(["top", "right", "bottom", "left"].map(side => [side, { width: 1, style: "solid", rgba: [211, 218, 215, 255] }])) as PropertyEvidence["borders"] });

test("dimension sensitivity ignores measured 1/64px rounding but retains real size changes", () => {
  const source = evidence(), paper = evidence();
  source.width = 137.28125; paper.width = 137.265625;
  paper.height += 1 / 32;
  expect(compareProperties("workspace", source, paper).status).toBe("match");
  paper.height += 1 / 64;
  expect(compareProperties("workspace", source, paper).findings.map(item => item.property)).toEqual(["height"]);
  paper.width += 1;
  expect(compareProperties("workspace", source, paper).findings.map(item => item.property)).toEqual(["width", "height"]);
});

test("missing 1px border is a removal independent of image noise", () => {
  const actual = evidence();
  for (const border of Object.values(actual.borders)) { border.width = 0; border.style = "none"; }
  const result = compareProperties("avatar/::after", evidence(), actual);
  expect(result.status).toBe("different");
  expect(result.findings).toHaveLength(4);
  expect(result.findings.every(finding => finding.change === "removed")).toBe(true);
  expect(result.fidelity_claim).toBe(false);
});

test("added border, changed width, color and dimensions are distinct evidence", () => {
  const before = evidence(), after = evidence();
  before.borders.top.width = 0;
  after.borders.left.width = 2;
  after.borders.right.rgba = [100, 100, 100, 255];
  after.width = 29;
  const result = compareProperties("avatar", before, after);
  expect(result.findings.map(finding => [finding.property, finding.change])).toEqual([["width", "changed"], ["border-top", "added"], ["border-right", "changed"], ["border-left", "changed"]]);
});

test("unmapped or invalid evidence cannot pass", () => {
  expect(compareProperties("unknown", evidence(), undefined).status).toBe("unverified");
  const bad = evidence(); bad.width = NaN; bad.borders.top.rgba = [];
  const result = compareProperties("invalid", evidence(), bad);
  expect(result.status).toBe("unverified");
  expect(result.findings.map(finding => finding.property)).toEqual(["width", "border-top"]);
});

test("property match is scoped, not a whole-design fidelity claim", () => {
  const result = compareProperties("avatar", evidence(), evidence());
  expect(result.status).toBe("match");
  expect(result.checked_properties).toBe(6);
  expect(result.scope).toBe("dimensions-and-borders");
  expect(result.fidelity_claim).toBe(false);
});

test("readback uses bound IDs after rename, flags removed nodes and refuses incomplete membership", async () => {
  const scope = { capture_id: "capture", artboard_id: "board", source_revision: "revision", file_id: "file" };
  const entry = { key: "avatar", label: "temporary", name: "avatar", styles: {}, width: 28, height: 28 };
  const bound = bindImportReceipt([entry], { createdNodes: [{ id: "node", name: "temporary" }] }, { ...scope, operation_hash: "receipt" });
  let present = true;
  const response = (value: unknown) => ({ structuredContent: value });
  const read = async (tool: string, args: Record<string, unknown>) => {
    expect(args.fileId).toBe("file");
    if (tool === "get_children") return response({ children: args.nodeId === "board" && present ? [{ id: "node" }] : [] });
    if (tool === "get_node_info") return response({ id: "node", name: "User renamed me", width: 28, height: 28 });
    return response({ styles: { node: {} } });
  };
  const normalize = async () => [evidence(), evidence()];
  expect((await readBoundProperties([entry], bound.bindings, scope, read, normalize)).status).toBe("match");
  present = false;
  const removed = await readBoundProperties([entry], bound.bindings, scope, read, normalize);
  expect(removed.findings[0]?.change).toBe("removed");
  expect(removed.findings[0]?.property).toBe("mapped-node");
  await expect(readBoundProperties([entry], bound.bindings, scope, async () => response({}), normalize)).rejects.toThrow("Incomplete");
  expect((await readBoundProperties([entry], [], scope, read, normalize)).status).toBe("unverified");
});

test("CSS color spellings normalize equally while absent and unsupported borders do not pass", async () => {
  const browser = new Browser(`fx-properties-${crypto.randomUUID()}`);
  try {
    await browser.call("open", "about:blank");
    const rows = [
      { styles: { border: "1px solid rgb(211, 218, 215)" }, width: 28, height: 28 },
      { styles: { borderWidth: "1px", borderStyle: "solid", borderColor: "#d3dad7" }, width: 28, height: 28 },
      { styles: {}, width: 28, height: 28 },
      { styles: { borderColor: "var(--unknown)" }, width: 28, height: 28 },
      { styles: { border: "not-valid" }, width: 28, height: 28 },
    ];
    const normalized = await browser.evaluate(`(${normalizePropertyStyles.toString()})(${JSON.stringify(rows)})`);
    expect(compareProperties("ring", normalized[0], normalized[1]).status).toBe("match");
    expect(compareProperties("ring", normalized[0], normalized[2]).findings.every(finding => finding.change === "removed")).toBe(true);
    expect(normalized[3]).toBeNull();
    expect(normalized[4]).toBeNull();
  } finally { await browser.call("close").catch(() => undefined); }
}, 60000);
