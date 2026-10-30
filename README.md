# WebGPU Hackathon 2026

Gravitas Demo: a WebGPU benchmark in C++, with a sequence of scenes around the LunarG ship.
The window title is "Gravitas Demo".

The camera is 500 m above the ground and tilts down.
The hills and craters move toward the ship, but the ship does not move.
The camera moves around the ship on a path that repeats every 20 seconds.
First, a 14-second intro shows the LunarG logo, and the ship takes the place of the G.
The intro is not part of the benchmark results.
The times below are from the end of the intro.
After 20 seconds, the terrain goes away, and the ship flies through a field of asteroids.
After 40 seconds, the ship falls into the atmosphere of a yellow-brown planet, with re-entry
heating, clouds, rain, and lightning.
After 73 seconds, the ship flies over a dark brown land with reflective glass towers.
After 93 seconds, the benchmark is finished, and the window shows the results page.
The LunarG ship (`assets/lunarg-ship/lunarg_ship.glb`) is in the center of the view and faces away
from the camera.

The application has two targets from one source:

- Desktop: a native executable with [Dawn](https://dawn.googlesource.com/dawn) as a shared library,
  and [GLFW](https://www.glfw.org) for the window and the input.
  The window uses the `Mailbox` present mode, so the frame rate is not limited to the display
  refresh rate, and the image does not tear.
  If the surface does not support `Mailbox`, the application writes a warning and uses `Fifo`.
- Browser: WebAssembly from [Emscripten](https://emscripten.org), with emdawnwebgpu
  (`external/emdawnwebgpu/`).
  The default is wasm64 (Memory64).

GFXReconstruct Premium can capture both targets (see "Capture" below).

The application is a port of an earlier TypeScript version.
Before the TypeScript version was removed, the two versions gave the same images, pixel for pixel
(see "Verification").

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
| `--screenshot=<n>` |                  | Desktop: write frame `n` (from 1) to `screenshot_<n>.png`. A list, for example `120,240`, writes each frame. |

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

## Benchmark scenes

Each scene is in its own file in `src/app/scenes/`, and `BenchmarkScenes()` in
`src/app/scenes/scenes.cpp` gives the order of the benchmark scenes.
The App puts the intro (`intro_scene.cpp`) before them.
The intro has `benchmark = false` in its `SceneProperties`, so it has no result, no scene number,
and no GPU time.

| Scene                | File                | Duration   | Contents                         |
| -------------------- | ------------------- | ---------- | -------------------------------- |
| `Terrain and ship`   | `terrain_scene.cpp`  | 20 seconds | The terrain, the ship, and stars. |
| `Asteroids and ship` | `asteroid_scene.cpp` | 20 seconds | The ship moves around the asteroids, with a planet, a nebula, and stars. The camera does not move. |
| `Atmospheric entry`  | `entry_scene.cpp`    | 33 seconds | The ship falls into a planet atmosphere, seen from its right side. The engines are off. |
| `City flyover`       | `city_scene.cpp`     | 20 seconds | The ship flies over dark brown land with reflective glass towers, toward the sun. |

After the last scene, the application shows the results page.

Between two scenes, the image fades to black in `kTransitionFadeTime` seconds (0.5), and then
fades in from black in the same time.
At the start of each scene, the ship is at its start position, with no boost and no heat.
The engines are on, or off at once for a scene with `engines = false`.
A scene with `cameraAngle` has a camera that does not move, at that angle in degrees around the
ship: 0 is behind the ship, 90 is at its left side, and -90 is at its right side.
Other scenes use the camera path.
A scene with `cameraLookAhead` has a camera that looks that many meters in front of the ship.
A scene can also set its own sun (`sun`: the direction, the color, and the ambient color) and the
look of the shared terrain (`terrainStyle`: the colors of low and high ground, the height scale,
and the crater scale, which is 0 for no craters).
At the start of each scene, the App sets the sun and the terrain style of the scene, or the
defaults.
`App::SceneName()` gives the name of the current scene.

The App (`src/app/app.cpp`) owns the objects that all scenes share: the sun, the terrain, the ship,
the camera and its path, and the fade.
In each frame, the App moves the camera and updates the ship.
Then it calls `Update()` of the current scene, which can record compute passes.
In the render pass, it calls `Draw()` of the current scene, and then draws the ship.
Then it calls `DrawOcclusionQueries()` of the current scene, for draws in occlusion queries.
Then it calls `DrawAfterShip()` of the current scene, for blended objects that the ship can fly
through and for screen effects, and then draws the fade.
The render pass draws into a scene texture.
After the render pass, the App calls `AfterMainPass()` of the current scene, for example to
resolve the occlusion queries.
A second pass, the post pass, copies the scene texture to the output.
Then it calls `DrawPost()` of the current scene, for screen effects that read the scene image.
A scene contains only its name, its duration, its own objects, and the shared objects that it draws.
For example, the terrain scene moves and draws the shared terrain, and the asteroid scene makes and
draws its own asteroids.
A scene can move and turn the ship with `moveShip(offset, turn)` in `SharedObjects`.
The offset is in meters from the start position of the ship, along the right, up, and heading
directions.
The turn has a yaw, a pitch, and a roll in radians.

In the asteroid scene, the ship follows `AsteroidShipPath()`: wide turns to the left and right,
and smaller moves up and down and forward and back.
The path starts at the start position of the ship and eases in over 3 seconds.
The nose of the ship points along the path, and the ship banks into turns.

To add a scene:

1. Write a file in `src/app/scenes/` with a function that takes the `SharedObjects` and returns a
   `std::unique_ptr<Scene>`.
2. Declare the function in `src/app/scenes/scene.h`, and add it to `BenchmarkScenes()` in
   `src/app/scenes/scenes.cpp`.
3. Add the file to `CMakeLists.txt`.

## Terrain

The vertex shader calculates the height of each grid point from two parts:

- Hills: Perlin noise with `kNoiseOctaves` octaves.
  The first octave has a wavelength of `kNoiseWavelength` and an amplitude of `kNoiseAmplitude`.
- Craters: two layers, one of large craters and one of small craters.
  Each layer divides the plane into square cells, and each cell has one crater or no crater.
  The crater has a random position and a random radius in its cell.
  Thus the distance between craters changes.
  The maximum radius must be no more than 0.25 of the cell size, because the shader looks only at
  the 2 x 2 cells nearest to each point.

The `kLargeCrater`, `kSmallCrater`, and `kNoise` constants at the top of `src/app/terrain.cpp`
control these parts.
The shader also calculates the slope of the height, and uses it for the normal.

The grid is a sector of rings around the point below the camera, and it covers the view of the
camera.
The columns are at equal angles, and the radius of each ring is a fixed ratio larger than the
radius of the ring before it.
Thus a cell has approximately the same size on the screen at all distances, approximately 3
pixels wide at 1920 x 1080.
`kGridColumns`, `kGridRows`, `kGridNear`, `kGridHalfAngle`, and `kTerrainRadius` at the top of
`src/app/terrain.cpp` set the shape of the grid.
`Terrain::SetGridCenter()` puts the grid below the camera and turns it to the camera heading.
`src/app/app.cpp` calls it in each frame, so the grid follows the camera.

Far cells are large, so the shader removes noise octaves and craters that are smaller than
approximately 4 cells.
Without this, the small features would flicker as the terrain moves.

The grid does not move.
`Terrain::Update()` sets `worldPos`, an offset that the shader adds to each grid point before it
samples the height field.
Each frame, the terrain scene (`src/app/scenes/terrain_scene.cpp`) moves `worldPos` along the camera
heading at `kTerrainSpeed` meters per second.
Thus the terrain features come toward the camera.

## Lighting

One directional light, the sun, lights the scene.
`kSunViewPosition` in `src/app/app.cpp` sets the sun direction relative to the camera heading.
The camera pitch does not change the sun direction.
The value `{-9000, 9000 * sqrt(2), -9000}` puts the sun in front of the camera,
45 degrees to the left of the view direction, and 45 degrees above the horizon.
The solid terrain uses diffuse (Lambert) lighting with an ambient term.
The wireframe terrain does not use the light.

The terrain also casts shadows.
For each grid point, the vertex shader sends a ray toward the sun and samples the height field at
`kShadowSteps` points along the ray.
Where the terrain is above the ray, the grid point gets only ambient light.
Where the terrain is a short distance below the ray, the grid point is in the soft edge of a
shadow.
The fragment shader interpolates the result between the grid points.
To save time, the rays use only the first `kShadowOctaves` octaves of the noise.
The `kShadow` constants at the top of `src/app/terrain.cpp` control the rays.

To light a new object with the same sun:

1. Put `shaders::kLight` (`shaders/light.wgsl`) into the shader code with `JoinWgsl()`.
   Call `applyLight()` in the fragment shader, or call `applyShadowedLight()` if the object
   calculates its own shadows.
2. Put `light.BindGroupLayout()` at index `kLightBindGroup` in the pipeline layout.
3. Give the pipeline a `depthStencil` state with the format `kDepthFormat` from `src/app/app.cpp`.
4. Call `light.Bind(pass)` before the draw.

Other objects do not cast shadows on the terrain, and the terrain does not cast shadows on them.

## Intro

The intro (`src/app/scenes/intro_scene.cpp`) uses three images in `assets/textures/`:

- `2025-LunarG-Color-Logo-with-tagline.png`: the color logo, with a transparent background.
- `LunarG-Logo-Neon-Transparent.png`: the neon logo.
- `LunarG-Logo-NeonTube-Transparent.png`: the neon tube logo.

The two neon images have the same size, and their letters are at the same positions.
The color logo has the same letter size, at the offset (120, 118) in the neon images.
`src/app/intro_logo.cpp` draws the logo with one full-screen shader, which mixes the three images.

| Time (s)    | Event                                                                       |
| ----------- | --------------------------------------------------------------------------- |
| 0 to 3      | The color logo on black.                                                    |
| 3 to 4.5    | The color logo blends into the neon logo.                                   |
| 4.5 to 6.5  | The neon logo becomes brighter, with a bloom filter, and changes to the neon tube logo. |
| 6.5 to 10   | The tubes flicker on and off, as tubes that fail, and the bloom increases.  |
| 10          | A white flash. The G tube goes out, and the ship is in its place, with its front to the left. |
| 10.6 to 13.5 | The engines ignite, and the ship flies off to the left.                    |
| 12 to 12.6  | The G tube flickers and comes on again.                                     |
| 13.5 to 14  | The image fades to black, and the first benchmark scene starts.             |

Each tube (each letter, the bracket, the dot, and the tagline) flickers by itself.
The shader finds the tube of a pixel from its position in the logo.
The tubes are near white, and the glow panel behind them is blue, so the shader separates them
by color.
An unlit tube is dim gray glass.

The ship has the same height on the screen as the G.
The scene finds the ray from the camera through the G, and puts the ship on it at the distance
where the height of its solid parts (`Ship::Height()`) is the height of the G.
The ship faces to the left, so its ring is on the G.
The ring is not at the center of the ship, so `kRingOffset` moves the ship to put the ring on the G.

The bloom filter (`src/app/bloom.cpp`) runs between the main pass and the post pass
(`Scene::AfterMainPass()`).
It keeps the parts of the image that are brighter than a threshold, at half size, and makes a chain
of 6 smaller images.
Then it adds each small image back to the next larger one, so the glow is sharp near bright parts
and wide and weak farther away.
The post pass adds the result to the output.

Both targets decode the images with stb_image (`src/util/image.cpp`).

## Atmospheric entry

The camera is at the right side of the ship, so the front of the ship points to the right of the
screen.
The engines are off.
The timeline, in seconds from the start of the scene:

| Time    | Event                                                                        |
| ------- | ---------------------------------------------------------------------------- |
| 0 to 25 | The ship goes from space into the atmosphere: the horizon comes up, and haze covers the stars. |
| 1 to 26 | Re-entry fire, strongest from 6 to 16: flames around the front of the ship that trail back, and smoke. It goes out as the rain starts. The ship shakes. |
| From 10 | Clouds come past the ship.                                                   |
| From 18 | Rain on the camera lens: thin water lines move straight from the front of the ship to its back. |
| From 20 | Lightning flashes at the edges of the screen every 1.5 to 5 seconds.         |

- Heating: `Ship::SetHeat()` makes the hull surfaces that face forward glow, from orange to white.
  A heat shell, the hull moved out along its normals and drawn with additive blending, adds a faint
  glow around the front of the ship.
- Fire light: the fire lights the whole ship with a flickering orange light, strongest on the
  surfaces that face back into the flames.
- Fire (`src/app/reentry.cpp`): one quad along the flow, which turns around its axis to face the
  camera.
  Its shader makes turbulent flames that start just in front of the nose, wrap around the front of
  the ship, and trail back, wider and wider.
  The flames are white and yellow in the hot middle and near the front, and orange at the ragged
  edges.
  The ship hides the parts behind it, so the fire shows around the outline of the ship.
- Smoke (`src/app/reentry.cpp`): soft puffs start behind the fire, move back, grow, and fade.
  Young puffs have an orange light from the fire.
  The CPU sorts the puffs from far to near, and they draw with premultiplied alpha blending.
- Plasma streaks: 160 additive ribbons on the solid parts of the ship add short-lived accents.
  Each streak shows only at random times.
- Sky: the `atmosphere` option of `Sky` draws the planet below the horizon, the bright edge of its
  atmosphere, and the haze.
  The horizon is tilted (`kHorizonTilt`, 14 degrees): it is higher in front of the ship, at the
  right of the screen, so the ship seems to go down into the planet.
- Clouds (`src/app/clouds.cpp`): soft sprites that face the camera.
  The CPU sorts them from far to near in each frame, and they draw with premultiplied alpha
  blending after the ship, so the ship flies through them.
  One instanced `DrawIndexedIndirect` call draws them.
  The indirect buffer has the instance count, which the cloud density sets.
- Rain on the lens (`src/app/rain.cpp`): a separate shader in the post pass reads the scene image.
  It makes a height field of the water on the glass: thin, long, slightly wavy lines of water that
  move across the lens at a constant speed, small beads that the lines leave on their paths, and
  a few still drops.
  The back end of a line fades out.
  The slope of the water bends the view through the drops, and the dry glass is a little misted
  (`kMistBlur` and `kMistLight`).
  The lines move straight from the front of the ship to its back (right to left).
  The scene projects the ship axis to the screen for this direction, so it is correct for all
  camera positions.
  The blend uses the blend constant, and `SetBlendConstant()` sets the rain intensity.
- Lightning (`src/app/lightning.cpp`): a flash has one to three quick pulses at a random point near
  the
  edge of the screen.
  The blend uses the blend constant, and `SetBlendConstant()` sets the flash brightness.
  The flash also lights the clouds and the haze near the flash position.

The random values of the clouds and the lightning come from fixed seeds, so each run is the same.

### Dawn entry points

The scene uses these Dawn entry points from the list of the hackathon:

- `wgpuRenderPassEncoderSetBlendConstant`: the rain on the lens and the lightning.
- `wgpuRenderPassEncoderDrawIndexedIndirect`: the clouds (and the asteroids in scene 2).
- `wgpuQuerySetGetCount` and `wgpuQuerySetGetType`: `src/app/gpu_timer.cpp` calls
  `QuerySet::GetCount()` and
  `QuerySet::GetType()` to make the resolve buffer of the timestamp query set.

The scene does not use these entry points:

- `wgpuCommandEncoderWriteTimestamp`: Dawn accepts it only with an experimental feature that
  requires the `allow_unsafe_apis` toggle.
  The GPU timer uses the `timestampWrites` of the render pass instead.
- `wgpuBufferWriteMappedRange`: the application writes buffers with `Queue::WriteBuffer()`, and it
  maps buffers only to read them.

## City flyover

The camera is at the right side of the ship and looks 60 meters in front of it, so the ship is
approximately one third from the left edge of the screen.
The ship flies from left to right, so the dark brown land and the towers move from right to left.
The land has low hills and no craters.
The sky is the yellow-brown haze of the planet, with the sun at the upper right of the screen,
in front of the ship.
The sun of the scene comes from that direction, and the ambient light has the same color.

The glass towers (`src/app/buildings.cpp`) reflect their surroundings, and the reflections show the
reflections in other towers.
Two cube maps, A and B, hold the surroundings of a point among the towers:

1. Six passes, one for each cube face, render the surroundings into A.
   The towers in these passes reflect B, as it was at the end of the previous frame.
2. Six passes render the surroundings into B. The towers in these passes reflect A.
3. The main pass draws the towers, which reflect B.

Thus each frame has two levels of reflection, and the reflections continue to build up from frame to
frame.
The cube passes draw a simple sky and dark ground as their background, but not the terrain and the
ship.
The center of the cube maps is on a street with no towers.
A tower that moves through the center would hide all of the surroundings, and all reflections
would go dark for a moment.

All of these draws are in render bundles that are recorded one time: one bundle for each face of
each cube map, and one for the main pass.
The bundles use these Dawn entry points:

- `wgpuRenderBundleEncoderDrawIndirect`: the background of each cube face.
- `wgpuRenderBundleEncoderDrawIndexedIndirect`: the instanced towers.
- `wgpuRenderBundleEncoderPushDebugGroup` and `wgpuRenderBundleEncoderPopDebugGroup`: a debug group
  for each face, and for the background and the towers.
- `wgpuRenderBundleEncoderInsertDebugMarker`: the cube map that the towers reflect.

The cube maps do not contain the ship.
Thus, the towers show the ship as an exact mirror image:

1. In each frame, the CPU selects the tower walls that face the camera and the ship and are less
   than `kMirrorDistance` (900) meters from the ship.
   It keeps the `kMaxMirrors` (48) walls nearest to the ship.
2. One pass draws the solid parts of the ship one time for each wall, with instancing
   (`Ship::DrawMirrored()`).
   Each instance reflects the ship through the plane of its wall.
   The fragment shader keeps only the pixels where the line from the camera goes through the wall
   rectangle.
   The pass writes the color into a reflection image the size of the view, and the wall id into a
   second `r32uint` image.
3. In the main pass, each wall adds the reflection image at its own pixels, but only where the
   stored id is its own id.

A wall that is parallel to the flight path would show the reflection directly behind the ship,
where the ship hides it.
Thus, each tower turns 10 to 28 degrees from the heading (`kTowerTurn`), and the reflection
appears farther along the street.
A row of 12 tall glass towers (`kFrontCount`) is on the far edge of the street, near the ship, so
that most frames show a reflection.
The reflection does not show the engine flames.

A lens flare (`src/app/lens_flare.cpp`) shows when the sun is not behind the towers or the ship.
It has a glow with rays and a horizontal streak at the sun, and a line of six faint colored ghosts
from the sun through the center of the screen.
Each ghost is a hexagon, a circle, or an oval, which a seeded random value selects (`kShapeSeed`).
An oval is squashed along the line from the sun through the center of the screen.
Occlusion queries measure how much of the sun is visible:

1. In the main pass, after the opaque objects and the ship, a disk over the sun is drawn two times
   with no color writes (`Scene::DrawOcclusionQueries()`).
   Query 0 counts the samples that pass the depth test.
   Query 1 counts all of the samples, with no depth test.
2. After the main pass, `CommandEncoder::ResolveQuerySet()` writes the two counts into a storage
   buffer
   (`Scene::AfterMainPass()`).
3. In the post pass, the flare shader reads the counts.
   Its brightness is the visible part of the sun: the first count divided by the second.

The counts stay on the GPU, so the flare changes in the same frame, with no read back to the CPU.
The main pass uses the occlusion query set of the scene (`Scene::OcclusionQuerySet()`).

## Sky

`src/app/sky.cpp` draws the background of a scene with one full-screen shader.
For each pixel, the shader calculates the view direction, so the background is infinitely far
away: the camera position does not change it, but the camera rotation does.
Each scene makes its own `Sky` with the options that it needs:

- Stars, in all skies: three layers of random stars.
  Most stars are faint and white, some are blue, yellow, or red, and a few bright stars have a
  glow and four spikes.
- `nebula`: a dark blue background that is brighter near the sun, with purple and green clouds.
  Without it, the background is black.
- `planet`: a planet with swirled bands, a thin gold atmosphere at the lit edge, a tilted ring with
  bands and gaps, and two small moons.
  The shader traces a ray to the planet, the ring, and the moons, and blends them from far to near.
  The planet casts a shadow on the ring.
  `rightDegrees`, `elevationDegrees`, and `radiusDegrees` set the position and the size of the
  planet.

The planet and the moons use the shared sun.
The sun is to the left of the view and behind the camera, so a planet at the right of the view is
approximately one third lit, with the lit side at the upper left.

The sky is drawn after the opaque objects of the scene, at the far plane, and it does not write
depth.
Thus the depth test skips the sky where the terrain or the asteroids cover it.

## Asteroids

The asteroid scene has `kAsteroidCount` (4000) asteroids with a radius from 2 m to 60 m.
Small asteroids are much more common than large asteroids.
The GPU does all of the work after the start:

1. At the start, a compute shader makes `kAsteroidShapes` (8) rock shapes from an icosphere.
   The surface uses the design of the terrain in 3D: Perlin noise and small craters with the same
   bowl and rim.
   Each shape is also stretched by a random amount on each axis.
   Each shape has two levels of detail (LOD): 5120 triangles and 320 triangles.
   Both come from the same surface function, so they have the same shape.
2. In each frame, a compute shader moves and turns each asteroid.
   It removes the asteroids that are outside the view, selects the LOD from the size on the screen,
   and adds each visible asteroid to the list of its shape and LOD.
   With an atomic add, it counts the instances of each list in the indirect draw buffer.
3. The render pass draws each list with one instanced `DrawIndexedIndirect` call (16 calls).
   The vertex shader reads the shape vertices and the asteroid data from storage buffers.

The asteroids move toward the camera at `kAsteroidFlowSpeed` (150 m/s), with a small random velocity
each.
They stay in a box around the ship: an asteroid that leaves one side comes back on the other side.
No asteroid can go into two tubes along the heading:

- The ship tube (radius `kShipClearance`, 50 m) follows the ship path.
  For each asteroid, the shader calculates when the asteroid comes to the ship, and keeps the
  asteroid away from the position of the ship path at that time.
  Thus the ship flies near the asteroids, but it does not hit them.
- The camera tube (radius `kCameraClearance`, 50 m) is a straight tube through the camera.

More asteroids start near the center of the box than near its sides (`kBoxCenterBias`), so that
some asteroids are near the ship path.
The start positions come from a random number generator with a fixed seed, so each run of the
benchmark is the same.
The constants are at the top of `src/app/asteroids.cpp`.

## Camera path

The camera moves on a horizontal circle around the ship center, and it always looks at the ship
center.
The circle has the start distance and height of the camera.
The path repeats every `kCameraPathPeriod` seconds (20):

| Time (s) | Camera                                                   |
| -------- | -------------------------------------------------------- |
| 0 to 3   | At the start position, behind the ship.                  |
| 3 to 5   | Moves `kCameraOrbitAngle` (20 degrees) to the left.     |
| 5 to 9   | Stays at the left, with a view of the left of the ship.  |
| 9 to 12  | Moves to 20 degrees to the right.                        |
| 12 to 16 | Stays at the right, with a view of the right of the ship. |
| 16 to 18 | Moves back to the start position.                        |
| 18 to 20 | Stays at the start position.                             |

`kCameraPath` in `src/app/app.cpp` holds these times and angles.
Each move starts and stops smoothly.
The sun direction and the ship position use the start position of the camera, so they do not
change when the camera moves.

## Ship

The application loads `assets/lunarg-ship/lunarg_ship.glb` at startup: the desktop target reads it
from `assets/` next to the executable, and the browser target reads it from the preloaded data.
The ship is `kShipDistance` meters from the camera, on the center of the view.
The ship stays level, and its front (+Z in the model) points along the camera heading.
Thus the camera sees the engines at the back of the ship.

The engines start when the application starts, and they run in all scenes.
The `EnginesIgnite` animation plays once, and the `EnginesRunning` animation loops.
`Ship::SetEnginesOn(false)` plays the `EnginesShutdown` animation, and then stops `EnginesRunning`.
A change in the middle of an ignition or a shutdown starts the other animation at the current
flame size, so the flames do not jump.

### Engine boost

A scene turns the boost on with `Ship::SetBoost(true)`.
When a scene starts, the App turns the boost off and puts the ship back at its start position.

The terrain scene starts the boost `kFlyOffTime` seconds (3) before its end.
Then the ship flies away from the camera with an acceleration of `kFlyOffAcceleration` (600 m/s²),
so it is very small before the fade to black.
The camera does not follow the ship.
The asteroid scene starts with the ship at its start position, with the engines on and no boost.

| Item                     | Without a boost                     | During a boost                 |
| ------------------------ | ----------------------------------- | ------------------------------ |
| Flames                   | `kBoostBaseLevel` (0.5) brightness | Full brightness, 1.6 x longer  |
| Engine lights and glow   | 0.5 brightness                      | Full brightness                |
| Terrain or asteroid speed | Usual speed                        | 2 x the usual speed            |

The boost comes on in `kBoostRiseTime` seconds (0.4) and goes off in `kBoostFallTime` seconds
(1.2), so all of the changes are smooth.
The `kBoost` constants are at the top of `src/app/ship.cpp`, and `kBoostSpeedScale` is at the top of
`src/app/app.cpp`.

The solid parts of the ship use the sun with `applyLight()`.
They do not get shadows from the terrain, and they do not cast shadows on the terrain.
The flames are unlit.
They use their vertex colors with additive blending, as `assets/lunarg-ship/viewer.html` does.
The scenes have no full-screen bloom: only the intro has one.
Instead, a glow sprite at each engine light adds a soft halo: a quad that faces the camera and adds
the light color.
The glow has the same fade and flicker as the light, and the depth test hides it behind the ship.
The `kGlow` constants at the top of `src/app/ship.cpp` set its size and brightness.

While the engines run, one orange point light behind each nozzle lights the solid parts of the
ship.
The strength of each light follows the flame size, so the light fades in and out with the
ignition and the shutdown.
The strength also flickers: it is the product of two sine waves, with a different phase for each
engine.
The `kEngineLight` constants at the top of `src/app/ship.cpp` set the color, the strength, the
distance, and the flicker.
The engine lights do not light the terrain, and they do not cast shadows.

`src/util/gltf.cpp` supports only the glTF features that the ship uses.
It gives an error for other features, for example textures, skins, or STEP interpolation.

## Verification

These results are from Linux (Wayland, AMD Radeon 890M, Mesa 26.2.5).

- Desktop: the whole sequence plays: the intro, the four scenes, and the results page, with no
  WebGPU errors.
  The `desktop_link` test passes.
- Parity with the TypeScript version: at a fixed step of exactly 1/60 s, 65 frames were the same
  as the frames of the TypeScript version, pixel for pixel: a frame every 2 seconds of the intro and
  of each scene, and four frames of one run from the start to the city scene.
  The results page was the same for the same results.
  After the parity check, the results page changed: it selects its text scale from the size of the
  table and the title, so that the page fits in the view.
  The parity tools are in `scripts/parity/` of commit `41209d1`.
- Frame rate: one real-time run of each version, in the same 2880 x 1620 window, with the C++
  release build:

  | Scene              | TypeScript fps | C++ fps | TypeScript GPU ms | C++ GPU ms |
  | ------------------ | -------------- | ------- | ----------------- | ---------- |
  | Terrain and ship   | 90.7           | 89.9    | 8.39              | 8.33       |
  | Asteroids and ship | 216.2          | 217.2   | 3.50              | 3.50       |
  | Atmospheric entry  | 129.9          | 158.2   | 5.09              | 5.16       |
  | City flyover       | 112.1          | 130.7   | 6.33              | 6.34       |

  The GPU times are almost the same.
  The C++ version has a higher frame rate in the two scenes with the most CPU work in each frame.
- Desktop capture: Premium-GFXR captures of the intro and of each scene replay with no error.
- Browser (wasm64, Chrome): the build of milestone 1 ran, with the clear color, the clicks, and
  `?frames=<n>`.
  The later builds pass, but they are not run in a browser.

Not verified:

- The click on the Exit button of the results page.
- The scenes in a browser, and browser capture with the Chrome extension.
- The wasm32 build in a browser. It builds.
- Windows and macOS.

## Known issues

- At startup, Dawn writes two warnings about `maxDynamicUniformBuffersPerPipelineLayout` and
  `maxDynamicStorageBuffersPerPipelineLayout`.
  You can ignore them.
- The screenshots of `gfxrecon-replay --screenshots` are black for a desktop capture (see
  "Capture").
- If the intro plays a second time (with the `N` key), the engines do not ignite again.

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
| `src/util/format.cpp`         | Number text with the rounding of JavaScript `toFixed()`.     |
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
| `assets/`                     | The ship model and the intro images.                         |
| `scripts/check_desktop_link.py` | The check that Premium-GFXR can capture the desktop target. |
