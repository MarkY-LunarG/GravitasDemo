#!/usr/bin/env python3
"""Compare frames of the C++ version with the same frames of the TypeScript version.

For each run, the script starts the C++ executable at a scene with a fixed time step of exactly
1/60 s and writes screenshots of the frames. Then it renders the same frames with the TypeScript
version offscreen (ts_reference.mts) at the same size, and compares the images pixel by pixel.

A run is <scene>:<frame>,<frame>,... Scene 0 starts with the intro, and scene n (from 1) starts at
benchmark scene n. The frames count from the start of the run.

Example:
    scripts/parity/run_parity.py --executable build/debug/hackathon --output /tmp/parity \\
        0:120,360 1:300,900 4:600

Requirements: the desktop build, ts/node_modules (npm install in ts/), and Pillow. The C++ version
opens a window, so it needs a desktop session.
"""

import argparse
import pathlib
import subprocess
import sys

try:
    from PIL import Image, ImageChops
except ImportError:
    sys.exit("This script needs Pillow: pip install pillow")

REPOSITORY = pathlib.Path(__file__).resolve().parents[2]
FIXED_STEP = "0.016666666666666666"


def parse_run(text: str) -> tuple[int, list[int]]:
    scene, frames = text.split(":")
    return int(scene), [int(frame) for frame in frames.split(",")]


def render_cpp(executable: pathlib.Path, scene: int, frames: list[int], directory: pathlib.Path) -> None:
    command = [
        str(executable),
        f"--scene={scene}",
        f"--fixed-step={FIXED_STEP}",
        f"--frames={max(frames)}",
        "--screenshot=" + ",".join(str(frame) for frame in frames),
    ]
    subprocess.run(command, cwd=directory, check=True, capture_output=True, text=True)
    for frame in frames:
        (directory / f"screenshot_{frame}.png").rename(directory / f"cpp_{frame}.png")


def render_ts(scene: int, frames: list[int], directory: pathlib.Path, size: tuple[int, int]) -> None:
    command = [
        "npx", "tsx", str(REPOSITORY / "scripts/parity/ts_reference.mts"),
        str(scene), ",".join(str(frame) for frame in frames), str(directory),
        str(size[0]), str(size[1]),
    ]
    result = subprocess.run(command, cwd=REPOSITORY / "ts", capture_output=True, text=True)
    errors = [line for line in result.stderr.splitlines() if "WebGPU error" in line]
    if result.returncode != 0 or errors:
        sys.exit(f"The TypeScript renderer failed (exit {result.returncode}):\n{result.stderr[-2000:]}")


def compare(cpp: pathlib.Path, ts: pathlib.Path, diff: pathlib.Path) -> tuple[int, int, float]:
    """Returns the number of different pixels, the largest difference, and the mean brightness."""
    a = Image.open(cpp).convert("RGB")
    b = Image.open(ts).convert("RGB")
    if a.size != b.size:
        sys.exit(f"{cpp.name} and {ts.name} have different sizes: {a.size} and {b.size}")
    difference = ImageChops.difference(a, b)
    histogram = difference.convert("L").histogram()
    different = sum(histogram[1:])
    largest = max(high for _, high in difference.getextrema())
    if different > 0:
        difference.point(lambda value: min(255, value * 4)).save(diff)
    gray = a.convert("L").histogram()
    mean = sum(value * count for value, count in enumerate(gray)) / (a.size[0] * a.size[1])
    return different, largest, mean


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--executable", type=pathlib.Path, default=REPOSITORY / "build/debug/hackathon")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("runs", nargs="+", type=parse_run, help="<scene>:<frame>,<frame>,...")
    arguments = parser.parse_args()
    executable = arguments.executable.resolve()

    failures = 0
    print(f"{'scene':>5} {'frame':>6} {'size':>11} {'brightness':>10} {'different px':>12} {'largest':>7}")
    for scene, frames in arguments.runs:
        directory = (arguments.output / f"scene{scene}").resolve()
        directory.mkdir(parents=True, exist_ok=True)
        render_cpp(executable, scene, frames, directory)
        size = Image.open(directory / f"cpp_{frames[0]}.png").size
        render_ts(scene, frames, directory, size)
        for frame in frames:
            different, largest, mean = compare(directory / f"cpp_{frame}.png",
                                               directory / f"ts_{frame}.png",
                                               directory / f"diff_{frame}.png")
            failures += different > 0
            print(f"{scene:>5} {frame:>6} {size[0]:>5}x{size[1]:<5} {mean:>10.1f} {different:>12} {largest:>7}")
    print("All frames are the same." if failures == 0 else f"{failures} frames are different.")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
