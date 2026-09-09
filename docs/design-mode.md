# Design mode implementation status

This integration is experimental and does not yet implement the complete
codebase → editable Paper design → verified codebase workflow.

## Implemented foundation

- Design-mode entry materializes a bundled, content-addressed helper and registers
  `fx_design` alongside the existing Paper MCP. A stable launcher selects the
  helper version bundled with the binary. Existing named configurations are not
  overwritten.
- The helper uses Bun and native agent-browser, which must already be installed.
  `FX_DESIGN_BROWSER` can select an exact browser executable.
- fx binds helper storage to the current saved session. Captures, source hashes,
  screenshots, operations, and import baselines persist under its `design/`
  directory. Multiple captures are independent of process lifetime.
- Capture records rendered geometry, styles, source SVG markup, image data, and
  CSS token evidence. Vector paint styles are copied from the browser without
  generating new geometry.
- Empty, absolutely positioned `::before` and `::after` decorations are captured
  as editable inline-styled layers, including borders, corner radii, stacking,
  and box-sizing conversion. Supported decorations do not require user action.
  Generated text/counters, image content, masks, and other unsupported effects
  remain unresolved findings rather than being treated as preserved.
- Capture hides known Next.js developer overlay hosts (`nextjs-portal`) before
  DOM measurement and screenshots. The exclusion remains active for late-mounted
  hosts in the disposable capture browser. Ordinary application portals and
  iframes are preserved; old capture-policy cache entries are not reused.
- Proven simple token references produce token-seeding operations. Scoped values
  receive distinct canvas bindings. Conflicting existing token names receive
  deterministic import aliases, preserving shared definitions and source identity.
  Equivalent CSS spellings are not yet normalized. Unresolved bindings remain findings.
- Source-tree inspection returns paginated component outlines rather than raw
  asset payloads; import still uses the full persisted capture.
- Font capture reads the internal family from referenced WOFF2 or OpenType font
  bytes, retains the browser alias and asset hash as evidence, and checks Paper's
  family availability before import. Unsupported formats and ambiguous identities
  remain findings; font collections and WOFF1 are not yet supported.
- Imports expose operation handles. fx resolves the stored payload, validates the
  underlying Paper tool, checks its permission, and records its actual result.
  Assistant-supplied receipts are rejected. Preflight checks the operation hash
  and source revision. Interrupted operations remain
  visibly unresolved instead of being blindly replayed.
- Verification reads Paper through a read-only transport and compares screenshots.
  New imports also use temporary source labels and actual import receipts to
  persist source-to-Paper node bindings, then queue normal layer renames to restore
  readable names. Dimension and border readback checks use those IDs, not visual
  similarity. Missing/ambiguous bindings remain unverified. SVG nodes are not yet
  covered by this property mapping. Equivalent CSS colors are compared after
  browser normalization; these scoped checks do not replace screenshot verification.
  Balanced sensitivity ignores dimension rounding up to 1/32 CSS px and pixel
  channel differences up to 24/255. Border presence and border-width checks remain
  independent, so a missing 1px border still fails. There is no whole-image area
  allowance: even one above-threshold pixel remains a visual difference. The host
  gate and inspector use the same pixel comparator. Checkpoints retain the policy,
  raw difference count and ignored noise count; older checkpoints without a policy
  use the current preview tolerance until checked again; stored results are unchanged.
  Anti-alias filtering suppresses only intermediate edge shades between unchanged
  neighboring color anchors. Solid strokes, alpha changes, and missing borders
  remain differences. Stored policies preserve earlier comparison behavior.
  Paper captures use PNG image exports rather than JPEG screenshots. Failed PNG
  exports fail explicitly instead of silently falling back to compressed evidence.
  A verified import records a baseline and enters the design phase, where
  intentional edits are reported as changes. Layer names are not source IDs.
- The host checkpoints every recorded managed mutation against its admitted
  capture. Incomplete groups remain `building`; the completed group receives a
  whole-artboard check automatically. A clean host proof satisfies the completion
  gate without requiring the agent to remember a separate verification call.
- Verification states and actual source/Paper screenshots persist per capture.
  Inline host notices show the state and a reopen link. The first meaningful
  comparison opens one read-only local browser inspector; subsequent checkpoints
  update that surface without stealing focus. One reusable loopback service per
  profile persists its endpoint and capability under `.fx/design-inspector/`.
  Sessions have independent stable routes with a capture selector. The service
  survives helper reconnects and exits after 30 minutes without viewer or helper
  activity; a restart reuses its saved port and routes. An occupied saved port is
  reported without stopping the unrelated listener. No arbitrary file API exists.
- Clicking a source, Paper, or difference image opens a comparison lightbox.
  Zoom, native 100% scale, reset, dragging, and keyboard panning stay synchronized
  across all three views. Escape or Close restores focus and the selected finding.
  Zoom uses the stored capture resolution and does not manufacture image detail.
- The inspector separates source findings from approximate directional pixel
  residuals. Detail is the default: pixel-level, near-opaque color preserves text
  shapes without blurring the overlay. Regions is optional
  and follows differences with fine 2px tiles and smoothed overlay
  edges, leaving hollow interiors clear rather than filling bounding boxes.
  Pixels reveals the comparison mask. Amber denotes mixed residuals, not a
  confirmed semantic move. Grouping changes presentation, never verification
  results. Red and green pixels are not claims of confirmed semantic removals
  or additions. Selecting a located source finding focuses its measured region.
  Token-binding warnings, unverified mappings and technical provenance are tucked
  into collapsed Details, keeping the default view focused on the images.
  It shows disconnected or expired evidence as outdated, not continuously verified.
  External Paper changes are observed at the next host checkpoint, not polled
  continuously in the background.
- Comparison reads the current Paper artboard and reports source-file changes
  plus component search candidates. Candidates are explicitly not verified source
  mappings. The helper does not edit application files.
- Prepared design edits require an explicit linked `file_id` from import and
  matching `fileId` arguments. Live subtree membership is checked during
  preparation and again at admission. Foreign targets and structural edits to
  the artboard root are rejected.

## Remaining work

- Install and pin the helper's native runtime and browser dependencies, and make
  helper connection lazy. Profile registration currently causes normal MCP
  startup to attempt a connection on subsequent launches.
- Replace conservative CSS evidence collection with complete cascade and token
  provenance, including inherited values, conditional styles, fonts, and
  unsupported Paper property handling.
- Establish verified component/source-to-Paper-node mappings. Simplify redundant
  wrappers with layout proof; the current serializer retains DOM nesting.
- Implement complete recovery/reconciliation for interrupted operations.
- Implement verified application of selected Paper changes to existing source
  components, including source conflicts, behavior tests, and baseline advancement.
- Add deterministic product E2E coverage and its PGSO corpus classification,
  helper CI coverage, and live Paper acceptance against the Comp product demo.

## Stateful captures

Capture uses a fresh isolated browser, not the user's existing tab. For a
stateful route, identify the intended screen first. `capture_source` accepts
`state_label`, `ready_selector`, and explicit string-valued `session_storage`
and `local_storage` maps. Storage is applied only on the requested origin,
then the page is reopened. No existing cookies or browser profiles are copied.
Only a label and fingerprint of the supplied state are saved in capture metadata.

Capture observes DOM mutations and checks matching snapshots around its screenshot,
retrying at most three times. A quiet interval is not an application-specific
readiness signal: use `ready_selector` for delayed data or hydration-dependent UI.
An unstable page is rejected before import. Captures created before these checks
must be recaptured; they cannot establish import fidelity.

## Managed execution

Managed execution resolves the underlying Paper tool without a separate model
selection step. Its schema, MCP access scope and exact-action permission checks
still apply. Complete Paper receipts have a bounded 32 MiB host budget and are
saved per capture and operation before acknowledgement; model output keeps its
configured text limit. Check/verify can finish recording a retained receipt after
interruption without reissuing the Paper mutation. Old truncated receipts cannot
be reconstructed by this recovery path and remain explicitly blocked.

The completion gate does not force another call after verification has already
been attempted for the current mutation. If verification was omitted, it supplies
at most one reminder per turn. A blocked turn may end without claiming fidelity.

## Diff shortcut

Use `/diff` to compare a linked artboard with its saved source capture, without
an AI turn or edits to Paper or application code. Select one imported artboard
in Paper first; with no selection, the most recently verified linked capture
in the current session is used when unique. Explicit targets are
`/diff node:ID`, `/diff capture:ID`, or `/diff /route` for a previously linked route.
Ambiguous targets require an explicit capture. The result is a generic
`Diff: ready · Open viewer ↗` notice with a clickable link and Ctrl+D support.

This first command version compares linked artboards, not arbitrary child nodes
or unlinked source components. Changed source requires a fresh state-consistent
capture. The helper must be connected, and configured MCP restrictions still apply.

When a checkpoint preview is available, the footer shows `Diff ready · ctrl+d to open`.
Press Ctrl+D to open that checkpoint in your browser without changing your draft.
Inside the lightbox, scroll or pinch to zoom, and drag or use two fingers to pan.
Keyboard zoom and arrow-key panning remain available, alongside Fit and 100% reset.
Building/checking checkpoints do not enable the shortcut. Without a ready preview,
Ctrl+D retains its normal delete-forward/exit behavior. Safety notices take priority
over the footer hint. The latest host checkpoint in the current transcript owns the link.

## Local checks

```sh
zig build
zig build test -Dtest-filter=esign
bun test src/core/design/helper.test.ts
bun test src/core/design/helper.browser.test.ts
bun test src/core/design/property_diff.test.ts
bun test src/core/design/comparison.test.ts
bun test src/core/design/inspector.test.ts src/core/design/inspector.browser.test.ts
```

The browser test owns an isolated local fixture and does not start the Comp
project's development server. Live acceptance requires a running Comp app and
Paper Desktop with a file open. The native Windows binary currently rejects
interactive mode; a supported Linux or macOS runtime is required to exercise
Design-mode entry.

On Linux, helper setup prefers native Bun under `~/.bun/bin` and checks the
runtime platform before registering it. Under WSL, the read-only Paper transport
uses Windows `curl.exe` for a loopback desktop endpoint, keeping Paper off the
LAN. Use a Linux-local application server and Linux workspace paths for captures.
The optional `FX_DESIGN_LIVE=1 bun test src/core/design/helper.live.test.ts` checks
the actual desktop connection without modifying the canvas.

Passing these checks is not a shipping decision. Full CI and the ship gate must
pass on the exact commit, and the complete workflow must be exercised with the
freshly built binary before it is described as ready.

Managed execution resolves the target Paper tool's current definition separately
from the wrapper's definition, while retaining schema, permission, and access
checks. If the helper blocks an operation, its diagnostic is returned to the
agent. A started operation without a recorded result still requires reconciliation;
do not repeat the Paper write merely because the previous session exited.
