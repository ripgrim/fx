"""Require exact-commit, four-platform Full CI before publishing this fork."""
import json
import re
import subprocess
import sys

PLATFORMS = ("linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64")


def github(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def pages(path, api):
    result = []
    for page in range(1, 101):
        value = api(f"{path}&per_page=100&page={page}")
        entries = value.get("workflow_runs", value.get("jobs", []))
        result.extend(entries)
        if len(entries) < 100:
            return result
    raise RuntimeError("CI evidence exceeds pagination limit")


def require_full_ci(repository, sha, api=github):
    if repository != "ripgrim/fx" or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("Release must target ripgrim/fx and an exact commit")
    prefix = f"repos/{repository}"
    if api(f"{prefix}/git/ref/heads/main")["object"]["sha"] != sha:
        raise RuntimeError("Release commit is no longer the head of main")
    runs = pages(f"{prefix}/actions/workflows/full-ci.yml/runs?head_sha={sha}&event=push&branch=main", api)
    runs = [run for run in runs if run.get("head_sha") == sha and run.get("event") == "push" and run.get("head_branch") == "main" and run.get("head_repository", {}).get("full_name") == repository]
    if not runs:
        raise RuntimeError("No Full CI push run for this exact main commit")
    # A newer retry/run invalidates older green evidence until it succeeds.
    run = max(runs, key=lambda item: (item["id"], item.get("run_attempt", 1)))
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise RuntimeError("Latest exact-commit Full CI is not successful")
    jobs = pages(f"{prefix}/actions/runs/{run['id']}/jobs?filter=latest", api)
    expected = {f"Full suite ({platform})" for platform in PLATFORMS}
    selected = [job for job in jobs if job.get("name") in expected]
    if len(selected) != 4 or {job["name"] for job in selected} != expected or any(job.get("conclusion") != "success" for job in selected):
        raise RuntimeError("All four Full suite aggregates must succeed")
    return run["id"]


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise RuntimeError("Usage: fork_release_gate.py owner/repo commit")
        print(f"Full CI proof: run {require_full_ci(*sys.argv[1:])}")
    except (RuntimeError, KeyError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Release blocked: {error}", file=sys.stderr)
        sys.exit(1)
