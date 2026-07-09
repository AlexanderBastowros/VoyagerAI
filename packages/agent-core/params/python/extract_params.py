#!/usr/bin/env python3
"""
extract_params.py — deterministic extraction of a script's PARAMS block into
manifest.json (architecture doc §7: "a trivial parse - no LLM").

Grammar (documented in full in the printable-cad skill's SKILL.md Phase 4):

    # --- PARAMS ---
    NAME = VALUE   # unit=UNIT label="Human label" [min=MIN] [max=MAX] [brief=path.to.field]
    ...
    # --- END PARAMS ---

  - NAME:  ^[A-Z][A-Z0-9_]*$ (no expressions - one bare numeric literal per line).
  - VALUE: an int or float literal, optional leading '-'.
  - Trailing comment holds space-separated key=value annotations; a value may be
    double-quoted to contain spaces (only `label` needs this in practice).
  - `unit` and `label` are required; `min`/`max`/`brief` are optional.

Usage:
  python extract_params.py script.py [--out manifest.json]

With no --out, the manifest JSON is printed to stdout. Exits non-zero with a clear
message on any malformed PARAMS line - this is a hard failure, not a best-effort scan,
since a silently-wrong manifest would be worse than none (verification layer 3 and the
parameter panel both trust this file as ground truth).
"""
import argparse
import json
import re
import sys

PARAMS_START = re.compile(r"^\s*#\s*---\s*PARAMS\s*---\s*$")
PARAMS_END = re.compile(r"^\s*#\s*---\s*END PARAMS\s*---\s*$")

ASSIGNMENT = re.compile(
    r"^\s*(?P<name>[A-Z][A-Z0-9_]*)\s*=\s*(?P<value>-?\d+(?:\.\d+)?)\s*"
    r"(?:#\s*(?P<comment>.*))?$"
)

# A bare token (unit=mm, min=10) or a double-quoted one (label="Mounting hole").
ANNOTATION = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S+)')

REQUIRED_ANNOTATIONS = ("unit", "label")
OPTIONAL_NUMERIC_ANNOTATIONS = ("min", "max")


class ParamsError(Exception):
    pass


def find_block(lines):
    start = end = None
    for i, line in enumerate(lines):
        if PARAMS_START.match(line):
            if start is not None:
                raise ParamsError(f"line {i + 1}: duplicate '# --- PARAMS ---' marker")
            start = i
        elif PARAMS_END.match(line):
            if start is None:
                raise ParamsError(f"line {i + 1}: '# --- END PARAMS ---' with no opening marker")
            end = i
            break
    if start is None:
        raise ParamsError("no '# --- PARAMS ---' block found")
    if end is None:
        raise ParamsError("no matching '# --- END PARAMS ---' marker found")
    return start, end


def parse_annotations(comment, line_no):
    found = {}
    for key, raw in ANNOTATION.findall(comment):
        value = raw[1:-1] if raw.startswith('"') and raw.endswith('"') else raw
        found[key] = value

    missing = [k for k in REQUIRED_ANNOTATIONS if k not in found]
    if missing:
        raise ParamsError(f"line {line_no}: missing required annotation(s): {', '.join(missing)}")

    entry = {"unit": found["unit"], "label": found["label"]}
    for key in OPTIONAL_NUMERIC_ANNOTATIONS:
        if key in found:
            try:
                entry[key] = float(found[key])
            except ValueError as exc:
                raise ParamsError(f"line {line_no}: {key}=\"{found[key]}\" is not a number") from exc
    if "brief" in found:
        entry["brief"] = found["brief"]
    return entry


def extract(script_text):
    lines = script_text.splitlines()
    start, end = find_block(lines)

    params = []
    seen_names = set()
    for offset, raw_line in enumerate(lines[start + 1 : end]):
        line_no = start + 2 + offset
        if not raw_line.strip():
            continue
        match = ASSIGNMENT.match(raw_line)
        if not match:
            raise ParamsError(
                f"line {line_no}: does not match 'NAME = VALUE  # unit=... label=\"...\"': {raw_line!r}"
            )
        name = match.group("name")
        if name in seen_names:
            raise ParamsError(f"line {line_no}: duplicate parameter name {name!r}")
        seen_names.add(name)

        value = float(match.group("value"))
        annotations = parse_annotations(match.group("comment") or "", line_no)

        entry = {"name": name, "value": value, **annotations}
        params.append(entry)

    return {"params": params, "featureBindings": []}


def main():
    ap = argparse.ArgumentParser(description="Extract the PARAMS block into manifest.json.")
    ap.add_argument("script", help="path to the generated parametric script")
    ap.add_argument("-o", "--out", default=None, help="write manifest JSON here instead of stdout")
    args = ap.parse_args()

    try:
        with open(args.script, "r", encoding="utf-8") as f:
            script_text = f.read()
    except OSError as exc:
        sys.exit(f"Could not read {args.script}: {exc}")

    try:
        manifest = extract(script_text)
    except ParamsError as exc:
        sys.exit(f"{args.script}: {exc}")

    text = json.dumps(manifest, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"wrote {len(manifest['params'])} parameter(s) to {args.out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
