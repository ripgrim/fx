import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class PrivateCiTests(unittest.TestCase):
    def test_dispatcher_never_checks_out_pr_code(self):
        workflow = (ROOT / '.github/workflows/private-ci.yml').read_text()
        self.assertIn('pull_request_target:', workflow)
        self.assertNotIn('actions/checkout', workflow)
        self.assertNotIn('run:', workflow)
        self.assertIn("pr.user.login !== 'ripgrim'", workflow)
        self.assertIn("pr.head.repo?.full_name !== 'ripgrim/fx'", workflow)
        self.assertIn("pr.state !== 'open'", workflow)
        self.assertIn('expected_sha:pr.head.sha', workflow)
        self.assertIn("context.actor !== 'ripgrim'", workflow)

    def test_hosted_fallback_is_explicit_and_pr_only(self):
        workflow = (ROOT / '.github/workflows/full-ci.yml').read_text()
        for job in ('build', 'native', 'full-suite'):
            section = workflow.split(f'  {job}:\n', 1)[1].split('    runs-on:', 1)[0]
            self.assertIn("vars.PRIVATE_CI_ENABLED == 'true'", section)
            self.assertIn("github.event_name == 'pull_request'", section)
            self.assertIn("github.event.pull_request.user.login == 'ripgrim'", section)
            self.assertIn("github.event.pull_request.head.repo.full_name == 'ripgrim/fx'", section)


if __name__ == '__main__':
    unittest.main()
