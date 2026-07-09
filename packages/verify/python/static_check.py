#!/usr/bin/env python3
"""
static_check.py — verification layer 1 (architecture doc §5): does the generated script parse,
and does it stick to an import allowlist / avoid I/O outside the project sandbox?

Unlike `validate_stl.py` (human-readable CLI, run by the skill itself in Phase 5), this is
consumed by the TS orchestration in `packages/verify/src/layer1StaticScript.ts` and prints one
JSON object to stdout: `{"findings": [{"severity": ..., "message": ...}, ...]}`.

`ast.parse` never executes the script - it only builds a syntax tree - so this is safe to run
on untrusted/agent-authored code.

Usage:
  python static_check.py script.py
"""
import argparse
import ast
import json
import sys

# Everything the printable-cad skill's own reference docs (build123d.md/cadquery.md) teach the
# agent to import, plus the standard library modules a pure-geometry script has a legitimate
# reason to need. Deliberately excludes anything that can reach outside the project directory
# (os, subprocess, socket, shutil, urllib, requests, ctypes) - "no I/O outside sandbox" per the
# architecture doc.
ALLOWED_MODULES = {
    "build123d",
    "cadquery",
    "math",
    "numpy",
    "np",
    "pathlib",
    "dataclasses",
    "typing",
    "itertools",
    "functools",
    "enum",
}

DISALLOWED_MODULES = {
    "os",
    "subprocess",
    "socket",
    "shutil",
    "urllib",
    "requests",
    "ctypes",
    "sys",
    "importlib",
    "multiprocessing",
    "threading",
}


def top_level_module(name):
    return name.split(".")[0]


def scan_imports(tree):
    """Returns (disallowed, unknown) - two lists of module names. `disallowed` names are ones we
    explicitly forbid; `unknown` names are neither allowed nor forbidden (flagged as a suggestion,
    not a blocker, since the allowlist above can't anticipate every legitimate helper library)."""
    disallowed = []
    unknown = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [top_level_module(alias.name) for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.module is None:  # relative import, e.g. `from . import x` - not expected here
                continue
            names = [top_level_module(node.module)]
        else:
            continue

        for name in names:
            if name in DISALLOWED_MODULES:
                disallowed.append(name)
            elif name not in ALLOWED_MODULES:
                unknown.append(name)

    return sorted(set(disallowed)), sorted(set(unknown))


def main():
    ap = argparse.ArgumentParser(description="Layer 1 static checks on a generated CAD script.")
    ap.add_argument("script", help="path to the script")
    args = ap.parse_args()

    findings = []

    try:
        with open(args.script, "r", encoding="utf-8") as f:
            source = f.read()
    except (OSError, UnicodeDecodeError) as exc:
        findings.append({"severity": "blocking", "message": f"Could not read {args.script}: {exc}"})
        print(json.dumps({"findings": findings}))
        return

    try:
        tree = ast.parse(source, filename=args.script)
    except (SyntaxError, ValueError) as exc:
        message = f"{exc.msg} (line {exc.lineno})" if isinstance(exc, SyntaxError) else str(exc)
        findings.append({
            "severity": "blocking",
            "message": f"Script does not parse: {message}"
        })
        print(json.dumps({"findings": findings}))
        return

    disallowed, unknown = scan_imports(tree)
    if disallowed:
        findings.append({
            "severity": "blocking",
            "message": f"Disallowed import(s) outside the sandbox: {', '.join(disallowed)}"
        })
    if unknown:
        findings.append({
            "severity": "suggestion",
            "message": f"Import(s) not on the known allowlist (review before trusting): {', '.join(unknown)}"
        })

    if not findings:
        findings.append({"severity": "info", "message": "Script parses; imports are within the allowlist."})

    print(json.dumps({"findings": findings}))


if __name__ == "__main__":
    main()
