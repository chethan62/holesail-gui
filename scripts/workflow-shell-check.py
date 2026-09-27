#!/usr/bin/env python3
"""Fail on the CI shell trap: a variable assigned from a command substitution
that can exit non-zero, piped into head, with no guard.

GitHub runs `run:` blocks under `bash -e -o pipefail`. When the lookup fails
(a glob matching nothing, an `ls` on a path that is not there) the ASSIGNMENT is
non-zero, `-e` aborts the step right there, and the FAIL branch written below it
never prints. The job then reports only "Process completed with exit code 2",
with nothing naming what it was looking for. Seven of these shipped at once, and
one of them is why the first Windows failure took a whole CI round trip to read.

The rule: if the substitution pipes into `head`, it must carry a guard on the
same line (`|| true`).

ponytail: line-based on purpose. A general shell-semantics analyser would be
guesswork that cries wolf; the shape that actually bit us is narrow. A second
shape, if it ever appears, gets added as a second pattern with its own self-test.

Usage:  scripts/workflow-shell-check.py [--self-test] [workflow.yml ...]
"""
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("needs pyyaml: pip install pyyaml")

ASSIGN = re.compile(r'[A-Za-z_]\w*\s*=\s*"?\$\(')
PIPE_HEAD = re.compile(r"\|\s*head\b")


def check_text(name, text):
    """Return a list of '<where>: <line>' problems in one workflow's YAML."""
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        return [f"{name}: unparseable YAML: {exc}"]
    problems = []
    for job_id, job in (doc.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            run = step.get("run")
            if not run:
                continue
            where = f"{name}:{job_id}/{step.get('name', '?')}"
            for line in run.splitlines():
                if not (ASSIGN.search(line) and PIPE_HEAD.search(line)):
                    continue
                if "|| true" in line:
                    continue
                problems.append(f"{where}: {line.strip()}")
    return problems


def main(argv):
    if "--self-test" in argv:
        # The self-test PROVES the rule fires, and that a guarded line passes.
        bad = (
            "jobs:\n  j:\n    steps:\n      - name: bad\n        run: |\n"
            "          EXE=$(ls /nope/*.exe | head -1)\n          echo \"$EXE\"\n"
        )
        good = (
            "jobs:\n  j:\n    steps:\n      - name: good\n        run: |\n"
            "          EXE=$(ls /nope/*.exe 2>/dev/null | head -1 || true)\n"
            "          echo \"$EXE\"\n"
        )
        assert check_text("bad", bad), "self-test: the trap was NOT detected"
        assert not check_text("good", good), "self-test: a guarded line was flagged"
        print("self-test OK: the trap fires and the guard is accepted")
        return 0

    paths = [Path(a) for a in argv if not a.startswith("-")]
    if not paths:
        paths = [Path(".github/workflows/build.yml")]
    problems = []
    for p in paths:
        problems += check_text(str(p), p.read_text())
    if problems:
        print("FAIL: unguarded command substitution piped into head")
        print("      (bash -e -o pipefail aborts the step before its FAIL branch)")
        for line in problems:
            print("  " + line)
        return 1
    print(f"OK: no unguarded substitution over {len(paths)} workflow file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
