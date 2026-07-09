"""
Shared DFM numbers sourced from `resources/skills/printable-cad/references/design-for-printing.md`
- the single source of truth for both generation and verification (see the CLAUDE.md convention
this repo follows: "never invent thresholds"). A sibling import (`import dfm_constants`) works
from any script here since Python adds a script's own directory to `sys.path` when it's run
directly - no packaging needed.

Do not add a number here without a matching line in that doc.
"""

# design-for-printing.md §1: "Absolute minimum wall = 2 x nozzle (two perimeters)."
ABSOLUTE_MIN_WALL_MULTIPLIER = 2
