# WebGPU Hackathon 2026

A WebGPU benchmark with a sequence of scenes: terrain, asteroids, an atmospheric entry, and a city.
The benchmark is being ported from TypeScript to C++.

- `ts/`: the TypeScript version, which is complete.
  See `ts/README.md` for how to run it and for a description of the scenes.
  It stays until the C++ version has the same output, and then it is removed.
- The rest of the repository: the C++ version, for the desktop and for the browser.
  It now opens a window and clears it to a color that changes over time (milestone 1).
  See "Status" below.

The C++ version has two targets from one source:

- Desktop: a native executable with [Dawn](https://dawn.googlesource.com/dawn) as a shared library,
  and [GLFW](https://www.glfw.org) for the window and the input.
- Browser: WebAssembly from [Emscripten](https://emscripten.org), with emdawnwebgpu
  (`external/emdawnwebgpu/`).
  The default is wasm64 (Memory64).

GFXReconstruct Premium can capture both targets (see "Capture" below).

## Requirements

- CMake 3.28 or later, and Ninja.
- A C++20 compiler: Clang on Linux and macOS, or Visual Studio 2022 on Windows.
  The Linux presets select `clang` and `clang++`, as Premium-GFXR does.
  GCC 16 does not compile Tint at the Dawn commit that this project uses.
- Python 3.
- Desktop target on Linux: the X11 development libraries (libx11, libxrandr, libxinerama,
  libxcursor, libxi, libxext), the Wayland development libraries (wayland, wayland-protocols,
  libxkbcommon), or both.
- Desktop target: a GPU and driver that Dawn supports (Vulkan on Linux, D3D12 on Windows, Metal on
  macOS).
- Browser target: [emsdk](https://emscripten.org/docs/getting_started/downloads.html), with
  Emscripten 4.0.10 or later.
  Emscripten 6.0.5 is tested.
  `build.sh` finds emsdk from `-e <path>`, `$EMSDK`, or `~/emsdk` (see "Build").
  For the CMake presets directly, run `source <emsdk>/emsdk_env.sh` first.
- Browser: a browser with WebGPU.
  The wasm64 build also needs Memory64 (Chrome or Firefox).
  Use the `emscripten-wasm32-*` presets for other browsers.

## Build

`build.sh` configures and builds one target with the presets below.

```sh
./build.sh                 # Desktop, debug
./build.sh -b release      # Desktop, release
./build.sh -w              # Browser, wasm64, debug
./build.sh -w -3           # Browser, wasm32, debug
./build.sh -c              # Clean build
./build.sh -d <dawn>       # Desktop, with a Dawn checkout that you already have
./build.sh -w -e <emsdk>   # Browser, with emsdk in <emsdk>
```

For the browser target, the script finds emsdk in `-e <path>`, then in `$EMSDK`, then in
`~/emsdk`.
If emsdk is in another directory, set `EMSDK` in your shell profile, for example
`export EMSDK=~/dev/others/emsdk`.

The output directories:

| Command              | Output                                                    |
| -------------------- | --------------------------------------------------------- |
| `./build.sh`         | `build/debug/hackathon`                                   |
| `./build.sh -w`      | `build/emscripten/debug/index.{html,js,wasm,data}`        |
| `./build.sh -w -3`   | `build/emscripten-wasm32/debug/index.{html,js,wasm,data}` |

With `-b release`, `release` replaces `debug` in the directory names.

### Desktop

```sh
cmake --workflow --preset linux-release
```

The workflow configures, builds, and runs the tests.
The executable is `build/release/hackathon`.
Other presets: `linux-debug`, `macos-debug`, `macos-release`, and `windows` (with the
`windows-debug` and `windows-release` build presets).

The first configure downloads and builds Dawn and GLFW, which takes some time.
To use a Dawn checkout that you already have, add
`-DFETCHCONTENT_SOURCE_DIR_DAWN=<path to dawn>` to the configure command.
The checkout must be at the Dawn commit in `cmake/dependencies.cmake`.

### Browser

```sh
source <emsdk>/emsdk_env.sh
cmake --workflow --preset emscripten-release
python3 -m http.server -d build/emscripten/release 8000
```

Then open `http://localhost:8000/index.html`.
The page shows errors on the canvas, and the log lines go to the console of the browser.
Browsers do not load the page from `file://` URLs, so you must use a web server.
The `emscripten-wasm32-release` preset builds wasm32 into `build/emscripten-wasm32/release`.

The browser build writes two warnings that you can ignore:

- CMake 4.3.0 does not support Emscripten shared libraries.
  The browser target has no shared libraries.
- `MEMORY64 is deprecated`.
  The build uses `-sMEMORY64=1`, as Premium-GFXR does, because older Emscripten versions do not
  accept the newer `-m64` flag.

## Run

```sh
build/release/hackathon [options]
```

| Option             | URL query        | Effect                                                    |
| ------------------ | ---------------- | --------------------------------------------------------- |
| `--scene=<n>`      | `?scene=<n>`     | Start at a benchmark scene. Not used yet.                 |
| `--fixed-step=<s>` | `?fixedStep=<s>` | Advance the animation by `s` seconds in each frame.       |
| `--frames=<n>`     | `?frames=<n>`    | Stop after `n` frames.                                    |
| `--exit-on-finish` | `?exitOnFinish`  | Stop at the results page with no click. Not used yet.     |

In the browser, give the options in the URL, for example `index.html?frames=120&fixedStep=0.016667`.
An unknown or incorrect option stops the run, and the page shows the error.

`Esc` or the window close button stops the desktop target.
In milestone 1, a click writes `Click at (x, y) pixels` to stdout or to the browser console.
The position is in pixels of the surface, from the upper left.

## Capture

The desktop executable loads Dawn as a shared library and uses only `webgpu.h`.
Thus the GFXReconstruct Premium WebGPU capture library can interpose it.
The `desktop_link` test (`scripts/check_desktop_link.py`) checks this on Linux.

```sh
LD_PRELOAD=<premium>/lib64/libwebgpu_gfxrecon.so \
WEBGPU_DAWN_ORIGINAL_LIBPATH=build/release/external_deps_bin/dawn/src/dawn/native \
GFXRECON_CAPTURE_FILE=hackathon.gfxr \
build/release/hackathon --fixed-step=0.016667 --frames=300
```

The Dawn library is at `build/<type>/external_deps_bin/dawn/src/dawn/native/libwebgpu_dawn.so`.

To capture the browser target, use the GFXReconstruct WebGPU Capture Chrome extension.

Known problem: the screenshots of `gfxrecon-replay --screenshots` are black for a desktop capture.
The application configures the surface with `RenderAttachment` usage only, and the replay copies
from the surface texture with no `CopySrc` usage.
The replay writes this validation error:
`usage (TextureUsage::RenderAttachment) doesn't include TextureUsage::CopySrc`.
The fix belongs in the Premium-GFXR replay, which must add `CopySrc` when it takes screenshots.
The replay plays all of the frames with no other error.

## Status

The port has six milestones: the skeleton, the core objects and the terrain scene, scenes 2 to 4,
the intro and the results page, parity with the TypeScript version, and the removal of `ts/`.

Milestone 1 (skeleton) is verified on Linux (Wayland, AMD Radeon 890M, Mesa 26.2.5):

- Desktop: the build has no warnings, and the `desktop_link` test passes.
  The application reads the ship model from the copied assets.
  `--frames`, `--fixed-step`, and an incorrect option work, and the exit is clean.
- Desktop capture: a 120-frame Premium-GFXR capture has 120 frames and replays.
  The clear colors in the capture are the colors that the application calculates.
- Browser (wasm64, Chrome): the canvas shows the changing clear color.
  The ship model loads from the preloaded data.
  Clicks write their position, and `?frames=<n>` stops the run.

Not verified yet:

- The desktop window and the replay window, by eye.
- Browser capture with the Chrome extension.
- The size of the canvas in device pixels on a high-density display.
- The wasm32 build in a browser. It builds.
- Windows and macOS.

## Source files

| File                          | Contents                                                     |
| ----------------------------- | ------------------------------------------------------------ |
| `src/main.cpp`                | The entry point and the main loop of both targets.           |
| `src/app/app.cpp`             | The application. It draws a frame into a texture view.      |
| `src/platform/platform.h`     | The interface between the application and the platform.     |
| `src/platform/platform_glfw.cpp` | Window, surface configuration, keys, time, and asset files. |
| `src/platform/platform_native.cpp` | Desktop: native surface, pointer, main loop, assets.     |
| `src/platform/platform_web.cpp` | Browser: canvas surface, pointer, main loop, URL options.   |
| `src/platform/gpu_init.cpp`   | Gets the adapter and the device with no blocking call.       |
| `src/platform/options.cpp`    | Parses the options.                                          |
| `web/shell.html`              | The page of the browser target.                              |
| `build.sh`                    | Builds the desktop target, or the browser target with `-w`.  |
| `CMakePresets.json`           | The configure, build, test, and workflow presets.            |
| `cmake/dependencies.cmake`    | Dawn and GLFW for the desktop target, at fixed versions.     |
| `cmake/emscripten.cmake`      | The compile and link options of the browser target.          |
| `external/emdawnwebgpu/`      | The emdawnwebgpu version of the browser target.              |
| `assets/`                     | The ship model and the intro images, for both versions.      |
| `scripts/check_desktop_link.py` | The check that Premium-GFXR can capture the desktop target. |
