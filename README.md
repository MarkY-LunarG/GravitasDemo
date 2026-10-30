# WebGPU Hackathon 2026

A WebGPU benchmark with a sequence of scenes: terrain, asteroids, an atmospheric entry, and a city.
The benchmark is being ported from TypeScript to C++.

- `ts/`: the TypeScript version, which is complete.
  See `ts/README.md` for how to run it and for a description of the scenes.
  It stays until the C++ version has the same output, and then it is removed.
- The rest of the repository: the C++ version, for the desktop and for the browser.
  It now has all of the parts of the TypeScript version (milestone 4): the intro, the four
  benchmark scenes (the terrain, the asteroids, the atmospheric entry, and the city), and the
  results page.
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
| `--scene=<n>`      | `?scene=<n>`     | Start at benchmark scene `n` (from 1).                    |
| `--fixed-step=<s>` | `?fixedStep=<s>` | Advance the animation by `s` seconds in each frame.       |
| `--frames=<n>`     | `?frames=<n>`    | Stop after `n` frames.                                    |
| `--exit-on-finish` | `?exitOnFinish`  | Stop after the last scene, when its result is written.    |
| `--screenshot=<n>` |                  | Desktop: write frame `n` (from 1) to `screenshot_<n>.png`. |

In the browser, give the options in the URL, for example `index.html?frames=120&fixedStep=0.016667`.
An unknown or incorrect option stops the run, and the page shows the error.

With `--fixed-step`, the animation is the same in each run, so frame `n` shows the same image.
That makes `--screenshot` and capture frame ranges repeatable.
`--screenshot` writes the PNG file in the current directory.
It adds the `CopySrc` usage to the surface, so do not use it in a capture that must match a normal
run.

| Key   | Action                                          |
| ----- | ----------------------------------------------- |
| `W`   | Toggle between the solid and wireframe terrain. |
| `N`   | Go to the next scene.                           |
| `Esc` | Exit the application (desktop only).            |

The window close button also exits the desktop application.

At the end of each scene, the application writes the benchmark result of the scene to stdout, or
to the browser console:

```text
Scene "Terrain and ship": 2438 frames in 20.0 s, 121.9 fps, GPU render pass 7.59 ms
```

The GPU time is the time of the main render pass, from timestamp queries, when the adapter has
the `timestamp-query` feature.
In the browser, the animation advances at most 0.1 s in one frame, for example after the tab was
hidden, but the result uses the real time.
First, a 14-second intro shows the LunarG logo, and the ship takes the place of the G.
The intro is not part of the benchmark results, and `--scene=<n>` starts after it.
After the last scene, the window shows the results page: a table with the frames and the frames per
second of each scene, and an Exit button.
A click on Exit stops the application.
In the browser, the page then shows "The benchmark has stopped. You can close this page."

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

Milestone 4 (the intro and the results page) is verified on the same Linux system:

- Desktop: the whole sequence plays: the intro, the four scenes, and the results page.
  `--exit-on-finish` stops at the results page.
- Parity: five intro frames (at 2, 6, 9, 10.3, and 12 seconds) are the same as the TypeScript
  frames, pixel for pixel.
  The results page is the same as the TypeScript results page, pixel for pixel, for the same
  results.
- Known behavior of both versions: the results page selects its text scale from the height of the
  view. In a view that is wide for its height, for example 2560 x 1508, the table is wider than the
  view, and its sides are cut off.
- Browser: the wasm64 build passes. It is not run in a browser yet.
- Not verified: the click on Exit, which needs a person at the window.

Milestone 3 (scenes 2 to 4) is verified on the same Linux system:

- Desktop: all four scenes play in order, with no WebGPU errors, and each scene writes its result.
- Parity: at a fixed step of exactly 1/60 s, the C++ version and the TypeScript version give the
  same image, pixel for pixel, for frames of all four scenes (scene 1 frame 300, scene 2 frame 600,
  scene 3 frames 600 and 1500, and scene 4 frames 600 and 1100).
  The TypeScript frames come from an offscreen renderer with `@kmamal/gpu`, on the same GPU.
- Browser: the wasm64 build passes. It is not run in a browser yet.

Milestone 2 (core objects and the terrain scene) is verified on the same Linux system:

- Desktop: the terrain scene plays for its 20 seconds, writes its result, and stops with
  `--exit-on-finish`.
  Screenshots show the terrain with craters and shadows, the stars, and the ship with its engine
  glow, and at 18.5 s the ship flies off with the boost.
  Two runs with `--fixed-step` give the same screenshot, byte for byte.
- Desktop capture: a 300-frame Premium-GFXR capture has 300 frames and replays with no error.
- Browser: the wasm64 build passes. It is not run in a browser yet.

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
| `src/app/app.cpp`             | The scenes, the camera path, the sun, the ship placement, and the frames. |
| `src/app/scenes/scene.h`      | The `Scene` interface, and the shared objects that scenes can use. |
| `src/app/scenes/scenes.cpp`   | The list of scenes, in the order that they play.             |
| `src/app/scenes/terrain_scene.cpp` | Scene 1: the terrain and the ship.                      |
| `src/app/scenes/asteroid_scene.cpp` | Scene 2: the asteroids and the ship.                   |
| `src/app/scenes/entry_scene.cpp` | Scene 3: the atmospheric entry.                           |
| `src/app/scenes/city_scene.cpp` | Scene 4: the city flyover.                                 |
| `src/app/asteroids.cpp`       | The asteroids: shape, update, and cull compute shaders, and indirect draws. |
| `src/app/ship_path.cpp`       | A smooth ship path from sine waves, in C++ and in WGSL.      |
| `src/app/clouds.cpp`          | Blended cloud sprites, sorted far to near, drawn with `DrawIndexedIndirect`. |
| `src/app/rain.cpp`            | Rain on the camera lens, in the post pass.                   |
| `src/app/lightning.cpp`       | Lightning flashes at the edges of the screen, with a blend constant. |
| `src/app/reentry.cpp`         | The re-entry fire around the ship, and its smoke.            |
| `src/app/buildings.cpp`       | Reflective towers, two cube maps of reflections, and render bundles. |
| `src/app/lens_flare.cpp`      | The lens flare of the sun, with occlusion queries.           |
| `src/app/scenes/intro_scene.cpp` | The intro: the LunarG logo, and the ship in the place of the G. |
| `src/app/intro_logo.cpp`      | The logo of the intro: the three logo images and the tube flicker. |
| `src/app/bloom.cpp`           | The bloom filter of the intro.                               |
| `src/app/results_page.cpp`    | The results page: a table of the scene results and an Exit button. |
| `src/util/format.cpp`         | Number text that matches the TypeScript version.             |
| `src/util/image.cpp`          | The PNG decoder (stb_image) for the intro images.            |
| `src/app/terrain.cpp`         | The terrain grid: pipelines, and the solid and wireframe modes. |
| `src/app/ship.cpp`            | The ship: pipelines, the engine animations, and the engine state. |
| `src/app/sky.cpp`             | The background: stars, and as options a nebula, a planet, and an atmosphere. |
| `src/app/light.cpp`           | The directional light that all objects share.                |
| `src/app/fade.cpp`            | The fade to black between scenes.                            |
| `src/app/blit.cpp`            | Copies the scene image to the output in the post pass.       |
| `src/app/gpu_timer.cpp`       | GPU time of the render pass, from a timestamp query set.     |
| `src/util/mat4.cpp`           | 4x4 matrix and quaternion functions.                         |
| `src/util/gltf.cpp`           | The glTF loader (with cgltf) and the animation sampler.      |
| `src/util/shader_builder.cpp` | WGSL constants and placeholders for the shaders.             |
| `src/util/screenshot.cpp`     | Writes a texture to a PNG file, for `--screenshot`.          |
| `shaders/`                    | The WGSL shaders. The build puts them into the executable.   |
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
| `cmake/embed_shaders.cmake`   | Puts `shaders/*.wgsl` into the generated header `shaders.h`. |
| `external/emdawnwebgpu/`      | The emdawnwebgpu version of the browser target.              |
| `external/cgltf/`, `external/stb/` | The glTF parser, and the PNG reader and writer.         |
| `.clang-format`               | The C++ format of `src/`.                                    |
| `assets/`                     | The ship model and the intro images, for both versions.      |
| `scripts/check_desktop_link.py` | The check that Premium-GFXR can capture the desktop target. |
