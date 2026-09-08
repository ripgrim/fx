"""Reject unusable shared binaries before starting expensive E2E shards."""

import pathlib
import subprocess
import sys


def smoke(binary):
    for arguments in (("help",), ("status", "--json")):
        try:
            result = subprocess.run(
                [str(pathlib.Path(binary).resolve()), *arguments],
                capture_output=True,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError(f"Binary startup failed: {error}") from error
        if result.returncode != 0 or not result.stdout or result.stderr:
            raise RuntimeError(
                f"Binary startup failed for {arguments}: exit={result.returncode}; "
                f"stderr={result.stderr.decode(errors='replace')[:2000]}"
            )


if __name__ == "__main__":
    smoke(sys.argv[1])
