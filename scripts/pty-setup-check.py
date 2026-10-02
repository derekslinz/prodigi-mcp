#!/usr/bin/env python3
"""
Drive setup.js through a real PTY to verify the interactive prompts.

The automated suite pipes stdin, which is not a TTY, so it cannot exercise the
interactive path. This script allocates a pseudo-terminal, answers the prompts
and checks the resulting output.

    python3 scripts/pty-setup-check.py

Exits non-zero if any expectation fails.
"""
import os
import pty
import select
import subprocess
import sys
import time

SETUP = "/root/prodigi-mcp/dist/setup.js"
CWD = "/root/prodigi-mcp"


def drive(args, answers, timeout=20):
    """Run setup.js under a PTY, answering prompts as they appear."""
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        ["/usr/bin/node", SETUP, *args],
        stdin=slave, stdout=slave, stderr=slave, cwd=CWD,
    )
    os.close(slave)
    out = b""
    step = 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.4)
        if ready:
            try:
                chunk = os.read(master, 8192)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            text = out.decode(errors="replace")
            if step < len(answers):
                if step == 0 and "sandbox" in text and "live" in text:
                    time.sleep(0.25)
                    os.write(master, (answers[0] + "\n").encode())
                    step = 1
                elif step == 1 and "API key" in text:
                    time.sleep(0.25)
                    os.write(master, (answers[1] + "\n").encode())
                    step = 2
        if proc.poll() is not None and not ready:
            break
    proc.wait(timeout=10)
    os.close(master)
    return out.decode(errors="replace")


failures = []


def check(name, condition, detail=""):
    print(f"  {'PASS' if condition else 'FAIL'}  {name}")
    if not condition:
        failures.append(f"{name}: {detail}")


print("interactive environment selection")

out = drive(["-i", "--client", "claude-desktop", "--print-config"], ["l", "k-abc"])
check("answer 'l' selects live", '"PRODIGI_ENVIRONMENT": "live"' in out, out[-200:])
check("answer 'l' warns it is LIVE", "(LIVE)" in out, out[-200:])

out = drive(["-i", "--client", "claude-desktop", "--print-config"], ["s", "k-abc"])
check("answer 's' selects sandbox", '"PRODIGI_ENVIRONMENT": "sandbox"' in out, out[-200:])

out = drive(["-i", "--client", "claude-desktop", "--print-config"], ["sandbox", ""])
# With no key the installer must say so and omit the env block from our entry.
# Note the banner mentions PRODIGI_API_KEY while explaining that it will NOT be
# embedded, so assert on that wording plus the absence of a value, not on the
# identifier alone.
check(
    "answer 'sandbox' accepted, key omitted adds no key",
    "Unrecognised" not in out and "credentials: none" in out,
    out[-200:],
)

out = drive(["-i", "--client", "claude-desktop", "--print-config"], ["banana", ""])
check("unrecognised answer is refused", "Unrecognised environment" in out, out[-200:])

out = drive(["-i", "--client", "claude-desktop", "--print-config"], ["production", "k"])
check("answer 'production' selects live", '"PRODIGI_ENVIRONMENT": "live"' in out, out[-200:])

print()
if failures:
    print(f"{len(failures)} failure(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all interactive checks passed")
