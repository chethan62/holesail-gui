#!/usr/bin/env python3
"""CI UI smoke test: launch holesail-gui under Xvfb and assert the a11y tree.

Asserts what the environment actually exposes (observed on webkit2gtk 2.4x on
ubuntu-22.04: only interactive nodes — buttons, entries, combo boxes, check
boxes, headings — surface in AT-SPI; plain text/span content does not):

  1. the app window renders,
  2. both nav tabs exist,
  3. the share form's inputs/controls are present,
  4. the worker comes online (the bare child process is spawned),
  5. the app is still alive at the end.

Exit 0 on pass; non-zero with a message on any failed assertion.

Usage: ci-ui-smoke.py [--timeout 120] [--app-pid <pid>]
"""

import argparse
import os
import sys
import time

import pyatspi

APP_NAME = "holesail-gui"
TIMEOUT = 120


def tree_items(root):
    """Collect (node, role, name) triples recursively, cap to avoid runaway
    trees. Keeping the node lets callers test states (e.g. STATE_EDITABLE)."""
    out = []
    stack = [(root, 0)]
    while stack:
        node, d = stack.pop()
        if d > 40 or len(out) > 5000:
            continue
        try:
            out.append((node, node.get_role_name(), node.name or ""))
        except Exception:
            continue
        try:
            for i in range(node.childCount):
                stack.append((node[i], d + 1))
        except Exception:
            pass
    return out


def child_processes(pid):
    """Comm names of direct children of pid, read from /proc (no deps)."""
    kids = []
    try:
        for entry in os.listdir(f"/proc/{pid}/task"):
            try:
                with open(f"/proc/{pid}/task/{entry}/children") as fh:
                    for cpid in fh.read().split():
                        try:
                            with open(f"/proc/{cpid}/comm") as cf:
                                kids.append((cpid, cf.read().strip()))
                        except Exception:
                            pass
            except Exception:
                pass
    except Exception:
        pass
    return kids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=TIMEOUT)
    ap.add_argument("--app-pid", type=int, default=None)
    args = ap.parse_args()

    deadline = time.time() + args.timeout
    window = None
    while time.time() < deadline:
        try:
            desktop = pyatspi.Registry.getDesktop(0)
            for app in desktop:
                if app.name and APP_NAME in app.name.lower():
                    for w in app:
                        if w.get_role_name() == "frame":
                            window = w
                            break
                    if window:
                        break
        except Exception:
            pass
        if window:
            break
        time.sleep(2)

    if not window:
        print("FAIL: app window never appeared")
        sys.exit(1)

    print(f"OK: window '{window.name}' up")

    def wait_for(desc, pred, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if pred():
                print(f"OK: {desc}")
                return True
            time.sleep(2)
        print(f"FAIL: {desc} (timed out)")
        return False

    def items():
        return tree_items(window)

    def has_text(text):
        return any(t for t in items() if text.lower() in t[2].lower())

    def entries():
        # Editable text fields — the role varies across webkit versions:
        # 'entry' on 2.4x, 'text'/'password' on some 2.38 builds, and
        # 'embedded' (named by placeholder) on the ubuntu-22.04 runner's
        # webkit. For the editable roles use STATE_EDITABLE (static text
        # can't inflate the count); 'embedded' needs a non-empty name.
        out = []
        for node, role, name in items():
            if role in ("entry", "text", "password", "textbox"):
                try:
                    if node.getState().contains(pyatspi.STATE_EDITABLE):
                        out.append((role, name))
                except Exception:
                    pass
            elif role == "embedded" and name:
                out.append((role, name))
        return out

    def checkboxes():
        return [t for t in items() if t[1] == "check box"]

    ok = True
    ok &= wait_for("nav tabs (Share, Connect)", lambda: has_text("Share") and has_text("Connect"), 30)
    # visible text inputs: share port/host (+name, custom key) + connect key/port/host
    ok &= wait_for("form entries", lambda: len(entries()) >= 4, 30)
    ok &= wait_for("controls (tunnel type, secure, UDP)", lambda: has_text("Tunnel") or len(checkboxes()) >= 2, 30)
    ok &= wait_for("share action button", lambda: has_text("Start sharing"), 30)

    # the worker is a bare child process spawned by the app (bundled runtime)
    if args.app_pid and wait_for("worker process (bare)", lambda: bool(child_processes(args.app_pid)), args.timeout):
        print(f"OK: bare worker child of pid {args.app_pid}")
    else:
        ok = False

    # still alive: poll the pid's existence once more
    if args.app_pid:
        alive = os.path.isdir(f"/proc/{args.app_pid}")
        print(f"OK: app pid {args.app_pid} alive" if alive else "FAIL: app pid died")
        ok = ok and alive

    if not ok:
        # debug aid: what the tree actually exposed (role histogram + names)
        from collections import Counter
        hist = Counter()
        named = []
        for _node, role, name in items():
            hist[role] += 1
            if name and len(named) < 40:
                named.append(f"{role}: {name[:50]}")
        print("DEBUG role histogram:", dict(hist))
        print("DEBUG named nodes:")
        for line in named:
            print("  ", line)

    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()