# Live Design evaluation in WSL

This is a credentialed, opt-in agent evaluation, not deterministic CI. It uses
the account already configured in fx. Submitting a task consumes model usage
and may modify Paper. Smoke mode does not submit a model task.

## Run controls

Run from the Linux-local checkout with native Bun and Node on PATH:

```sh
cd /home/grim/fx
bun tests/evals/design-live.ts start
bun tests/evals/design-live.ts start --submit
bun tests/evals/design-live.ts status <run-id>
bun tests/evals/design-live.ts stop <run-id>
```

`start` builds this checkout's `zig-out/bin/fx`, checks the Comp route and active
Paper page, checks both MCP connections, launches an isolated tmux session,
switches to Design mode, and checks MCP health inside the running app.
`--submit` additionally sends the minimal import task. It does not include
instructions about tokens, SVGs, verification, or fallback behavior.

The default workspace is `/home/grim/comp-v2-design-system`; the default route
is `http://127.0.0.1:3000/fullscreen/demo`. Override with `FX_DESIGN_WORKSPACE`
and `FX_DESIGN_URL`. `FX_DESIGN_ZIG` selects the native Zig executable; its
default is `~/zig-x86_64-linux-0.16.0/zig`.

The harness requires Paper's `Zod For Design (Test)` file and `e2e` page to be
active before launch. It never deletes existing artboards, clears shared
tokens, changes permission mode, or resets a workspace to make a test pass.
Normal fx permission and managed-operation checks still govern agent writes;
this harness is not an additional Paper authorization sandbox.

## Evidence and verdicts

Each run creates a private directory under `~/.fx/design-evals/<run-id>/`:

- `run.json`: exact prompt, paths, tmux identity, and submission status.
- `build.json`: executed binary path and SHA-256 hash.
- `mcp.txt`: pre-run runtime connection health.
- `terminal.ansi` and `terminal.fxtape`: terminal recording and fx replay tape.
- `screen.txt`: latest captured transcript, refreshed by `status`.
- `paper-before.json` and `paper-current.json`: independent Paper observations.
- `stop.json`: process-exit state before the owned tmux session is removed.

These artifacts can contain private source, prompts, or model output. Do not
commit or publish them. `stop` preserves evidence and stops only the session
named in that run. It leaves Comp's server and the user's other sessions alone.

`status` deliberately reports `unverified`. An idle composer, successful tool
call, or agent claim is not proof of a correct import. Before assigning a pass,
inspect actual Paper structure, tokens, exact source assets, and screenshots;
check for changes outside the test page. Record concrete mismatches and rerun
the same minimal task after fixing them. Do not repair the test result manually
and attribute that repair to the agent.

This script lives under `tests/evals/` because it needs a live model, local
application, and Paper Desktop. It adds no root deterministic E2E owner to the
PGSO corpus. Full CI remains a separate shipping requirement.
