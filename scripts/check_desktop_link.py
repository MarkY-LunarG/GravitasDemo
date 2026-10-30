#!/usr/bin/env python3
"""Check that Premium-GFXR can capture the desktop executable.

Premium-GFXR captures WebGPU on the desktop by interposing the Dawn shared library with
LD_PRELOAD. That works only if:

1. The executable loads Dawn as a shared library (libwebgpu_dawn.so is a DT_NEEDED entry).
2. The executable does not use the dawn::native C++ API, which makes objects that the capture
   library never sees.
3. The source does not include dawn/native headers or call dawnProcSetProcs.

Linux only: the check uses readelf and nm.
"""

import argparse
import pathlib
import re
import subprocess
import sys

DAWN_LIBRARY = "libwebgpu_dawn.so"
FORBIDDEN_SOURCE = re.compile(r"dawn/native|dawn::native|dawnProcSetProcs")
SOURCE_SUFFIXES = {".h", ".hpp", ".cpp", ".cc", ".mm"}


def run(command: list[str]) -> str:
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout


def check_needed(executable: pathlib.Path) -> list[str]:
    needed = re.findall(r"\(NEEDED\)\s+Shared library: \[([^\]]+)\]", run(["readelf", "-dW", str(executable)]))
    if DAWN_LIBRARY not in needed:
        return [f"{executable.name} does not load {DAWN_LIBRARY} (NEEDED: {', '.join(needed)})"]
    return []


def check_symbols(executable: pathlib.Path) -> list[str]:
    symbols = run(["nm", "-C", "--undefined-only", str(executable)]).splitlines()
    native = [line.split(maxsplit=1)[-1] for line in symbols if "dawn::native" in line]
    return [f"{executable.name} uses dawn::native: {symbol}" for symbol in native]


def check_source(source: pathlib.Path) -> list[str]:
    errors = []
    for path in sorted(source.rglob("*")):
        if path.suffix not in SOURCE_SUFFIXES:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if FORBIDDEN_SOURCE.search(line):
                errors.append(f"{path}:{number}: uses the dawn::native API: {line.strip()}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--executable", type=pathlib.Path, required=True)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    arguments = parser.parse_args()

    errors = check_needed(arguments.executable) + check_symbols(arguments.executable)
    errors += check_source(arguments.source)
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        return 1
    print(f"{arguments.executable.name}: loads {DAWN_LIBRARY}, and uses only webgpu.h")
    return 0


if __name__ == "__main__":
    sys.exit(main())
