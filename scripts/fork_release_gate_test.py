import copy
import json
from pathlib import Path
import re
import unittest
from fork_release_gate import PLATFORMS, require_full_ci


class GateTests(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.main = self.sha
        self.runs = [dict(id=1, head_sha=self.sha, event="push", head_branch="main", head_repository=dict(full_name="ripgrim/fx"), status="completed", conclusion="success")]
        self.jobs = [dict(name=f"Full suite ({platform})", conclusion="success") for platform in PLATFORMS]

    def api(self, path):
        if "/git/ref/" in path:
            return {"object": {"sha": self.main}}
        return {"jobs": self.jobs} if "/jobs?" in path else {"workflow_runs": self.runs}

    def check(self):
        return require_full_ci("ripgrim/fx", self.sha, self.api)

    def test_exact_proof(self):
        self.assertEqual(PLATFORMS, ("linux-x86_64",))
        self.assertEqual(self.check(), 1)

    def test_other_platform_cannot_replace_linux(self):
        self.jobs = [dict(name="Full suite (macos-aarch64)", conclusion="success")]
        with self.assertRaises(RuntimeError):
            self.check()

    def test_stale_main(self):
        self.main = "b" * 40
        with self.assertRaises(RuntimeError):
            self.check()

    def test_wrong_source(self):
        for field, value in [("head_sha", "b" * 40), ("event", "pull_request"), ("head_branch", "other"), ("head_repository", {"full_name": "other/fx"})]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.runs)
                self.runs[0][field] = value
                with self.assertRaises(RuntimeError):
                    self.check()
                self.runs = original

    def test_incomplete_or_failed_jobs(self):
        for conclusion in ("skipped", "failure", "cancelled", None):
            self.jobs[0]["conclusion"] = conclusion
            with self.assertRaises(RuntimeError):
                self.check()
        self.jobs = self.jobs[1:]
        with self.assertRaises(RuntimeError):
            self.check()

    def test_newer_failure_invalidates_old_success(self):
        self.runs.append(dict(self.runs[0], id=2, conclusion="failure"))
        with self.assertRaises(RuntimeError):
            self.check()

    def test_duplicate_aggregate_is_not_proof(self):
        self.jobs.append(self.jobs[0])
        with self.assertRaises(RuntimeError):
            self.check()

    def test_workflow_platform_contract(self):
        workflows = Path(__file__).resolve().parents[1] / ".github/workflows"
        full = (workflows / "full-ci.yml").read_text()
        choices = re.findall(r"fromJSON\(inputs.all_platforms == true && '([^']+)' \|\| '([^']+)'\)", full)
        self.assertEqual(len(choices), 4)
        for expanded, default in choices:
            names = lambda value: [item["name"] if isinstance(item, dict) else item for item in json.loads(value)]
            self.assertEqual(names(default), list(PLATFORMS))
            self.assertEqual(names(expanded), ["linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64"])
        self.assertIn("  pull_request:\n", full)
        self.assertIn("github.head_ref || github.ref_name", full)
        e2e = full.split("  e2e:\n", 1)[1].split("  full-suite:\n", 1)[0]
        self.assertIn("needs: build", e2e)
        self.assertNotIn("zig build", e2e)
        self.assertIn("actions/download-artifact@v4", e2e)
        self.assertIn("--retry 1", e2e)
        self.assertEqual(e2e.count('bun test --max-concurrency'), 1)
        self.assertIn("e2e-timings.tsv", e2e)
        self.assertEqual(full.count("name: fx-ci-${{ matrix.platform.name }}-${{ matrix.optimize }}-${{ github.sha }}"), 2)
        self.assertIn('"Build (ReleaseSafe, " + $target + ")",', full)
        release = (workflows / "release.yml").read_text()
        self.assertEqual(re.findall(r"            target: (.+)", release), ["x86_64-linux"])
        self.assertIn("needs: [check-version, build-linux]", release)
        self.assertNotIn("pgso-macos-arm64.yml", release)
        size = (workflows / "binary-size.yml").read_text()
        self.assertEqual(re.findall(r"            target: (.+)", size), ["x86_64-linux"])


if __name__ == "__main__":
    unittest.main()
