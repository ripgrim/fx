import { expect, test } from "bun:test";
import { Adapter, PaperReader } from "./helper";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in read-only connectivity proof for the actual desktop, not a CI fixture.
test.skipIf(process.env.FX_DESIGN_LIVE !== "1")("managed reader reaches the live Paper desktop", async () => {
  const paper = new PaperReader();
  await paper.initialize();
  const result = await paper.read("get_basic_info", {});
  const text = result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
  const info = JSON.parse(text);
  expect(typeof info.fileName).toBe("string");
  console.log(`Connected: ${info.fileName}, page ${info.pageName}`);
}, 60000);

test.skipIf(!process.env.FX_DESIGN_COMP_WORKSPACE)("managed helper captures the live Comp demo", async () => {
  const session_directory = await mkdtemp(join(tmpdir(), "fx-comp-capture-"));
  try {
    const result = await new Adapter().call("capture_source", {
      workspace: process.env.FX_DESIGN_COMP_WORKSPACE,
      session_directory, url: "http://127.0.0.1:3000/fullscreen/demo", selector: "body", width: 1440, height: 900,
    });
    expect(result.status).toBe("captured");
    console.log(`Captured Comp; ${result.findings.length} findings remain for import verification`);
  } finally { await rm(session_directory, { recursive: true }); }
}, 120000);
