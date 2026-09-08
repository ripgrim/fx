import subprocess
import unittest
from unittest.mock import patch

from scripts.ci_binary_smoke import smoke


class BinarySmokeTests(unittest.TestCase):
    @patch('scripts.ci_binary_smoke.subprocess.run')
    def test_checks_both_commands(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, b'ok', b'')
        smoke('./zig-out/bin/fx')
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.kwargs['timeout'], 15)

    @patch('scripts.ci_binary_smoke.subprocess.run')
    def test_rejects_signal_exit(self, run):
        run.return_value = subprocess.CompletedProcess([], -4, b'', b'')
        with self.assertRaisesRegex(RuntimeError, 'exit=-4'):
            smoke('./zig-out/bin/fx')
        self.assertEqual(run.call_count, 1)

    @patch('scripts.ci_binary_smoke.subprocess.run')
    def test_rejects_hang(self, run):
        run.side_effect = subprocess.TimeoutExpired('fx', 15)
        with self.assertRaisesRegex(RuntimeError, 'startup failed'):
            smoke('./zig-out/bin/fx')


if __name__ == '__main__':
    unittest.main()
