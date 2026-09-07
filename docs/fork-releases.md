# ripgrim/fx releases

This fork retains upstream CI, native Linux/macOS test matrices, E2E shards,
binary-size checks and macOS arm64 PGSO release qualification. Upstream remains
available through the `upstream` Git remote. `origin` is `ripgrim/fx`.

## Workflow schedule

Binary Size runs automatically on pull requests. CI (including SDK tests),
Benchmarks, and the standalone PGSO candidate are manual-only. Full CI runs
automatically on pushes to `main`, or manually on a selected feature branch.
Before declaring a PR ready, dispatch Full CI for its current branch and wait
for exact-commit evidence. Feature pushes do not launch duplicate test matrices.
Bug-report issue templates are unchanged.

Prepare Release remains manual. Release still requires successful main-branch
Full CI and invokes PGSO qualification itself; neither release gate is removed.

## Release flow

1. Run **Prepare Release** on `main`, select a version bump and supply Markdown
   release notes. Use the existing format, for example:
   `- **Design verification:** Compare imported designs with their source.`
   An optional `AI_GATEWAY_API_KEY` can draft notes when the input is empty.
2. Review the generated draft release PR and manually run Full CI on its branch.
   Full CI must pass for its exact commit.
3. Merge the reviewed release PR. Full CI runs again on `main`.
4. Successful main-branch Full CI starts **Release**. The release gate independently
   requires that exact current main commit and all four successful platform
   aggregates. Manual Release dispatch uses the same gate.
5. Release builds and package checks run, including upstream macOS arm64 PGSO
   qualification. The workflow creates the version tag and publishes platform
   archives, SHA-256 files and `latest.txt` to GitHub Releases.

Do not create version tags manually. An existing version tag means no new release.
No release is considered verified until its actual workflow succeeds.

## Credentials and optional services

GitHub Releases use the repository's `GITHUB_TOKEN`. Enable GitHub Actions and
allow workflows to create pull requests in repository Actions settings. Create
the `type: release` label for the preparation workflow.

Apple signing is opt-in: set repository variable `MACOS_SIGNING_ENABLED=true`
and configure the five `APPLE_*` secrets referenced in the release workflow,
in the `apple-signing` environment. Without that setting, macOS artifacts are
unsigned/unnotarized and may require explicit local trust before running.
Enabling signing without valid credentials fails the release; it never silently
falls back to unsigned artifacts.

CDN uploads and backfills require `CDN_PUBLISH_ENABLED=true` and your own
`BLOB_READ_WRITE_TOKEN`. They are off by default. Upstream npm publishing and
the Vercel dev-channel publisher are intentionally disabled for this fork.
The fork does not currently publish a `dev` upgrade channel.

Stable self-updates use only `ripgrim/fx` GitHub release assets, not Vercel's CDN.
Before the first fork release exists, update checks cannot discover an update.
For local development, `fx-dev` remains a link to the latest local build.
Default Debug builds show `fx [dev] v<version>` in the welcome header. This badge
does not change the stable self-update channel. Optimized stable release builds
omit the badge; dev-channel builds retain their commit-qualified version.

The upstream website installer still installs upstream fx. For this fork, build
from this checkout or download the matching archive from this repository's
GitHub Releases and verify its accompanying checksum.
