# ripgrim/fx releases

This fork defaults to Linux x86_64 CI and release binaries. Native Linux/macOS
test matrices remain available through manual Full CI dispatch. Upstream remains
available through the `upstream` Git remote. `origin` is `ripgrim/fx`.

## Workflow schedule

Binary Size and Full CI run automatically on pull requests for Linux x86_64.
CI (including SDK tests), Benchmarks, and the standalone PGSO candidate are
manual-only. Full CI also runs on pushes to `main`, or manually on a selected
feature branch. Set `all_platforms: true` on manual Full CI dispatch to include
Linux ARM64 and both macOS architectures. Wait for exact-commit evidence before
declaring a PR ready. Normal runs retain the native tests and all four Linux E2E shards.
Bug-report issue templates are unchanged.

Prepare Release remains manual. Release still requires successful main-branch
Full CI, including the Linux x86_64 aggregate. macOS PGSO is not a Linux release gate.

## Release flow

1. Run **Prepare Release** on `main`, select a version bump and supply Markdown
   release notes. Use the existing format, for example:
   `- **Design verification:** Compare imported designs with their source.`
   An optional `AI_GATEWAY_API_KEY` can draft notes when the input is empty.
2. Review the generated draft release PR and its Full CI run.
   Full CI must pass for its exact commit.
3. Merge the reviewed release PR. Full CI runs again on `main`.
4. Successful main-branch Full CI starts **Release**. The release gate independently
   requires that exact current main commit and a successful Linux x86_64
   aggregate. Manual Release dispatch uses the same gate.
5. Release builds Linux x86_64. The workflow creates the version tag and publishes
   `fx-linux-x86_64.tar.gz`, its SHA-256 file and `latest.txt` to GitHub Releases.
   Release notes state that prebuilt binaries are Linux x86_64 only. Existing
   release assets are not removed.

Do not create version tags manually. An existing version tag means no new release.
No release is considered verified until its actual workflow succeeds.

## Credentials and optional services

GitHub Releases use the repository's `GITHUB_TOKEN`. Enable GitHub Actions and
allow workflows to create pull requests in repository Actions settings. Create
the `type: release` label for the preparation workflow.

Apple signing is inactive while this fork publishes Linux-only releases.
Existing signing credentials need not be changed.

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
