# Parity of the C++ and TypeScript versions

These tools compare frames of the C++ version with the same frames of the TypeScript version in
`ts/`.
They are removed together with `ts/` in milestone 6.

- `run_parity.py` runs the C++ executable with `--fixed-step=0.016666666666666666` and
  `--screenshot=<frames>`, renders the same frames with `ts_reference.mts`, and compares the images
  pixel by pixel.
  A frame that is different gets a `diff_<frame>.png` image (the difference times 4).
- `ts_reference.mts` renders frames of the TypeScript `App` offscreen with `@kmamal/gpu`, with no
  window.

## Use

```sh
(cd ts && npm install)
./build.sh
scripts/parity/run_parity.py --output /tmp/parity 0:120,360,620 2:600 4:600,1100
```

Each argument is `<scene>:<frame>,<frame>,...`.
Scene 0 starts with the intro, and scene `n` starts at benchmark scene `n`, as `--scene=n` does.

Requirements: Python 3 with Pillow, Node.js 24 or later, and a desktop session, because the C++
version opens a window.
The TypeScript renderer uses the size of the C++ window, so the two images have the same size.

## Limits

- Only the desktop targets are compared.
  The browser targets are not.
- The frame rates are not compared: the fixed time step makes them meaningless.
- The results page shows frames per second.
  With `--fixed-step`, the C++ version calculates them from the real time, and the TypeScript
  version from the fixed time step, so the numbers are different.
