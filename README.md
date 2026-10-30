# WebGPU Hackathon 2026

This application renders a terrain grid with WebGPU.
It has two targets that share the same rendering code:

- Desktop: Node.js with an SDL window.
- Browser: a web page with a canvas, served and built with [Vite](https://vite.dev).

The camera is 500 m above the ground and tilts down.
The hills and craters move toward the ship, but the ship does not move.
The camera moves around the ship on a path that repeats every 20 seconds.
The application is a benchmark with a sequence of scenes.
First, a 14-second intro shows the LunarG logo, and the ship takes the place of the G.
The intro is not part of the benchmark results.
The times below are from the end of the intro.
After 20 seconds, the terrain goes away, and the ship flies through a field of asteroids.
After 40 seconds, the ship falls into the atmosphere of a yellow-brown planet, with re-entry
heating, clouds, rain, and lightning.
After 73 seconds, the ship flies over a dark brown land with reflective glass towers.
After 93 seconds, the benchmark is finished, and the window shows the results page.
The LunarG ship (`lunarg-ship/lunarg_ship.glb`) is in the center of the view and faces away from
the camera.

The desktop target uses [`@kmamal/gpu`](https://github.com/kmamal/gpu) for WebGPU through Google
Dawn.
It uses [`@kmamal/sdl`](https://github.com/kmamal/node-sdl) for the window, the keyboard, and the
mouse.
The window uses the `mailbox` present mode, so the frame rate is not limited to the display refresh
rate, and the image does not tear.
If the surface does not support `mailbox`, the application writes a warning and uses `fifo`.
The browser target uses the WebGPU API of the browser.

The application uses the prerelease versions `@kmamal/gpu` 1.0.0-6 and `@kmamal/sdl` 1.0.0-5
(SDL3).
In `@kmamal/gpu` 0.2.1, `GPUTexture.createView()` always fails, so a depth buffer is not possible.
The two packages must have matching versions: `@kmamal/gpu` 1.0.0-6 cannot make a window surface
for a window from `@kmamal/sdl` 0.11.

## Requirements

- Node.js 24 or later.
- Desktop target: a GPU and driver that Dawn supports (Vulkan on Linux, D3D12 on Windows, Metal on
  macOS), and a desktop session.
  The application opens a window, so it does not run headless.
- Browser target: a browser with WebGPU, for example a recent Chrome, Edge, Firefox, or Safari.

## Install

```sh
npm install
```

Both `@kmamal` packages include prebuilt native binaries.
If npm reports that it did not run their install scripts, the application still runs.

## Run

| Command               | Target                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| `npm start`           | Desktop. Runs the TypeScript source directly with `tsx`.               |
| `npm run desktop`     | The same as `npm start`.                                               |
| `npm run browser`     | Browser. Starts the Vite development server. Open the URL that it shows. |

The Vite development server loads the changes when you save a file.

To start at a benchmark scene with no intro, give its number (from 1):

```sh
npm start -- --scene=3
```

In the browser, add `?scene=3` to the URL.
In both targets, the `N` key goes to the next scene.

At the end of each scene, the application writes the benchmark result of the scene to the console:

```text
Scene "Terrain and ship": 2582 frames in 20.0 s, 129.1 fps, GPU render pass 7.26 ms
```

After the last scene, the image fades to black, and then the window shows the results page
(`src/results-page.ts`).
The page has a table with one row for each scene: the scene number and name, the total number of
frames, and the frames per second.
Click the `Exit` button below the table to stop the application.
In the browser, the page stops drawing and closes the window if the browser lets it.
Otherwise, it shows a message.
The page draws its text with a small 5 x 7 pixel font, with no font files.
A last scene with no end (`duration: Infinity`) writes its result after each 20 seconds instead.
The GPU time is the time of the main render pass, from timestamp queries.
The post pass (the copy to the output and screen effects such as the rain on the lens) is not in
the GPU time.
It is only available when the adapter has the `timestamp-query` feature.
Compute passes, for example the asteroid update, are not in the GPU time.
The GPU time is the average of all of the frames of the scene.
The GPU adds the time of each frame to a total, with a small compute pass.
The application reads the total one time at the end of the scene, so the result of a scene comes a
few frames after the scene ends.
If you stop the application before the end, it does not write the GPU times.

## Build

Desktop: compile the TypeScript to JavaScript in `dist/`, then run the result:

```sh
npm run build
node dist/desktop.js
```

Browser: build static files in `dist-web/`.
Copy the folder to a web server, or show it with the Vite preview server:

```sh
npm run build:browser
npm run preview:browser
```

The pages use relative paths, so they work from any folder on a web server.
Browsers do not load the page from `file://` URLs, so you must use a web server.

To do a type check without output files:

```sh
npm run typecheck
```

## Keys

| Key   | Action                                          |
| ----- | ----------------------------------------------- |
| `W`   | Toggle between the solid and wireframe terrain. |
| `N`   | Go to the next scene.                           |
| `Esc` | Exit the application (desktop only).            |

The window close button also exits the desktop application.

## Source files

| File                 | Contents                                                              |
| -------------------- | --------------------------------------------------------------------- |
| `src/app.ts`         | The shared scenes: scene list, camera path, sun, ship placement, and frames. |
| `src/fade.ts`        | The fade to black between scenes.                                     |
| `src/asteroids.ts`   | The asteroids: shape, update, and cull compute shaders, and indirect draws. |
| `src/sky.ts`         | The background: stars, and as options a nebula and a ringed planet.   |
| `src/noise.ts`       | WGSL hash and 3D Perlin noise that the asteroids and the sky use.     |
| `src/ship-path.ts`   | A smooth ship path from sine waves, in TypeScript and in WGSL.        |
| `src/clouds.ts`      | Blended cloud sprites, sorted far to near, drawn with `drawIndexedIndirect`. |
| `src/rain.ts`        | Rain on the camera lens: streaks, still drops, and mist, in the post pass. |
| `src/blit.ts`        | Copies the scene image to the output in the post pass.                |
| `src/results-page.ts` | The results page: a table of the scene results and an Exit button.  |
| `src/intro-logo.ts`  | The LunarG logo of the intro: the three logo images and the tube flicker. |
| `src/bloom.ts`       | The bloom filter of the intro.                                        |
| `src/png.ts`         | A small PNG decoder for the desktop target.                           |
| `src/lightning.ts`   | Lightning flashes at the edges of the screen, with a blend constant.  |
| `src/reentry.ts`     | The re-entry fire around the ship, and its smoke.                     |
| `src/gpu-timer.ts`   | GPU time of the render pass, from a timestamp query set.              |
| `src/scenes/entry-scene.ts` | Scene 3: the atmospheric entry.                               |
| `src/scenes/city-scene.ts` | Scene 4: the city flyover.                                     |
| `src/buildings.ts`   | Reflective towers, two cube maps of reflections, and render bundles.  |
| `src/scenes/scene.ts` | The `Scene` interface, and the shared objects that scenes can use.   |
| `src/scenes/index.ts` | The list of scenes, in the order that they play.                     |
| `src/scenes/terrain-scene.ts` | Scene 1: the terrain and the ship.                           |
| `src/scenes/asteroid-scene.ts` | Scene 2: the asteroids and the ship.                        |
| `src/desktop.ts`     | Desktop target: SDL window, Dawn device, keys, and the frame loop.    |
| `src/browser.ts`     | Browser target: canvas, browser WebGPU device, keys, and frames.      |
| `index.html`         | The browser page. Vite uses it as the entry point.                    |
| `vite.config.ts`     | The Vite configuration for the browser target.                        |
| `src/terrain.ts`     | The terrain grid: shaders, pipelines, and the solid/wireframe mode.   |
| `src/light.ts`       | The directional light that all objects share, and its WGSL code.      |
| `src/mat4.ts`        | 4x4 matrix functions for the model, view, and projection matrices.    |
| `src/gpu-types.ts`   | Short names for WebGPU types from `@webgpu/types`.                    |
| `src/gltf.ts`        | A minimal binary glTF (.glb) parser and an animation sampler.         |
| `src/ship.ts`        | The ship: pipelines, the engine animations, and the engine state.     |

To change the camera position, the camera pitch (`CAMERA_PITCH`), or the field of view, edit the
constants at the top of `src/app.ts`.
To change the grid size or the number of grid points, edit the constants at the top of
`src/terrain.ts`.
To change the direction or the color of the sun, edit the `SUN_` constants in `src/app.ts`.
All world units are meters.

## Terrain

The vertex shader calculates the height of each grid point from two parts:

- Hills: Perlin noise with `NOISE_OCTAVES` octaves.
  The first octave has a wavelength of `NOISE_WAVELENGTH` and an amplitude of `NOISE_AMPLITUDE`.
- Craters: two layers, one of large craters and one of small craters.
  Each layer divides the plane into square cells, and each cell has one crater or no crater.
  The crater has a random position and a random radius in its cell.
  Thus the distance between craters changes.
  The maximum radius must be no more than 0.25 of the cell size, because the shader looks only at
  the 2 x 2 cells nearest to each point.

The `_CRATER_` and `NOISE_` constants at the top of `src/terrain.ts` control these parts.
The shader also calculates the slope of the height, and uses it for the normal.

The grid is a sector of rings around the point below the camera, and it covers the view of the
camera.
The columns are at equal angles, and the radius of each ring is a fixed ratio larger than the
radius of the ring before it.
Thus a cell has approximately the same size on the screen at all distances, approximately 3
pixels wide at 1920 x 1080.
`GRID_COLUMNS`, `GRID_ROWS`, `GRID_NEAR`, `GRID_HALF_ANGLE`, and `TERRAIN_RADIUS` at the top of
`src/terrain.ts` set the shape of the grid.
`Terrain.setGridCenter()` puts the grid below the camera and turns it to the camera heading.
`src/app.ts` calls it in each frame, so the grid follows the camera.

Far cells are large, so the shader removes noise octaves and craters that are smaller than
approximately 4 cells.
Without this, the small features would flicker as the terrain moves.

The grid does not move.
`Terrain.update()` sets `worldPos`, an offset that the shader adds to each grid point before it
samples the height field.
Each frame, the terrain scene (`src/scenes/terrain-scene.ts`) moves `worldPos` along the camera
heading at `TERRAIN_SPEED` meters per second.
Thus the terrain features come toward the camera.

## Lighting

One directional light, the sun, lights the scene.
`SUN_VIEW_POSITION` in `src/app.ts` sets the sun direction relative to the camera heading.
The camera pitch does not change the sun direction.
The value `[-9000, 9000 * Math.SQRT2, -9000]` puts the sun in front of the camera,
45 degrees to the left of the view direction, and 45 degrees above the horizon.
The solid terrain uses diffuse (Lambert) lighting with an ambient term.
The wireframe terrain does not use the light.

The terrain also casts shadows.
For each grid point, the vertex shader sends a ray toward the sun and samples the height field at
`SHADOW_STEPS` points along the ray.
Where the terrain is above the ray, the grid point gets only ambient light.
Where the terrain is a short distance below the ray, the grid point is in the soft edge of a
shadow.
The fragment shader interpolates the result between the grid points.
To save time, the rays use only the first `SHADOW_OCTAVES` octaves of the noise.
The `SHADOW_` constants at the top of `src/terrain.ts` control the rays.

To light a new object with the same sun:

1. Add `LIGHT_WGSL` to the shader code.
   Call `applyLight()` in the fragment shader, or call `applyShadowedLight()` if the object
   calculates its own shadows.
2. Put `light.bindGroupLayout` at index `LIGHT_BIND_GROUP` in the pipeline layout.
3. Give the pipeline a `depthStencil` state with the format `DEPTH_FORMAT` from `src/app.ts`.
4. Call `light.bind(pass)` before the draw.

Other objects do not cast shadows on the terrain, and the terrain does not cast shadows on them.

## Benchmark scenes

Each scene is in its own file in `src/scenes/`, and `SCENES` in `src/scenes/index.ts` gives the
order of the benchmark scenes.
The App puts the intro (`intro-scene.ts`) before them.
The intro has `benchmark: false`, so it has no result, no scene number, and no GPU time.

| Scene                | File                | Duration   | Contents                         |
| -------------------- | ------------------- | ---------- | -------------------------------- |
| `Terrain and ship`   | `terrain-scene.ts`  | 20 seconds | The terrain, the ship, and stars. |
| `Asteroids and ship` | `asteroid-scene.ts` | 20 seconds | The ship moves around the asteroids, with a planet, a nebula, and stars. The camera does not move. |
| `Atmospheric entry`  | `entry-scene.ts`    | 33 seconds | The ship falls into a planet atmosphere, seen from its right side. The engines are off. |
| `City flyover`       | `city-scene.ts`     | 20 seconds | The ship flies over dark brown land with reflective glass towers, toward the sun. |

After the last scene, the application shows the results page.

## Intro

The intro (`src/scenes/intro-scene.ts`) uses three images in `textures/`:

- `2025-LunarG-Color-Logo-with-tagline.png`: the color logo, with a transparent background.
- `LunarG-Logo-Neon-Transparent.png`: the neon logo.
- `LunarG-Logo-NeonTube-Transparent.png`: the neon tube logo.

The two neon images have the same size, and their letters are at the same positions.
The color logo has the same letter size, at the offset (120, 118) in the neon images.
`src/intro-logo.ts` draws the logo with one full-screen shader, which mixes the three images.

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
where the height of its solid parts (`Ship.height`) is the height of the G.
The ship faces to the left, so its ring is on the G.
The ring is not at the center of the ship, so `RING_OFFSET` moves the ship to put the ring on the G.

The bloom filter (`src/bloom.ts`) runs between the main pass and the post pass
(`Scene.afterMainPass()`).
It keeps the parts of the image that are brighter than a threshold, at half size, and makes a chain
of 6 smaller images.
Then it adds each small image back to the next larger one, so the glow is sharp near bright parts
and wide and weak farther away.
The post pass adds the result to the output.

The desktop target decodes the images with `src/png.ts`, a small PNG decoder that uses
`node:zlib`.
It supports 8-bit gray, RGB, palette, gray with alpha, and RGBA images with no interlace.
The browser target uses the image decoder of the browser.
Between two scenes, the image fades to black in `TRANSITION_FADE_TIME` seconds (0.5), and then
fades in from black in the same time.
At the start of each scene, the ship is at its start position, with no boost and no heat.
The engines are on, or off at once for a scene with `engines: false`.
A scene with `cameraAngle` has a camera that does not move, at that angle in degrees around the
ship: 0 is behind the ship, 90 is at its left side, and -90 is at its right side.
Other scenes use the camera path.
A scene with `cameraLookAhead` has a camera that looks that many meters in front of the ship.
A scene can also set its own sun (`sun`: the direction, the color, and the ambient color) and the
look of the shared terrain (`terrainStyle`: the colors of low and high ground, the height scale,
and the crater scale, which is 0 for no craters).
At the start of each scene, the App sets the sun and the terrain style of the scene, or the
defaults.
`App.sceneName` gives the name of the current scene.

The App (`src/app.ts`) owns the objects that all scenes share: the sun, the terrain, the ship,
the camera and its path, and the fade.
In each frame, the App moves the camera and updates the ship.
Then it calls `update()` of the current scene, which can record compute passes.
In the render pass, it calls `draw()` of the current scene, and then draws the ship.
Then it calls `drawOcclusionQueries()` of the current scene, for draws in occlusion queries.
Then it calls `drawAfterShip()` of the current scene, for blended objects that the ship can fly
through and for screen effects, and then draws the fade.
The render pass draws into a scene texture.
After the render pass, the App calls `afterMainPass()` of the current scene, for example to
resolve the occlusion queries.
A second pass, the post pass, copies the scene texture to the output.
Then it calls `drawPost()` of the current scene, for screen effects that read the scene image.
A scene contains only its name, its duration, its own objects, and the shared objects that it draws.
For example, the terrain scene moves and draws the shared terrain, and the asteroid scene makes and
draws its own asteroids.
A scene can move and turn the ship with `moveShip(offset, turn)` in `SharedObjects`.
The offset is in meters from the start position of the ship, along the right, up, and heading
directions.
The turn has a yaw, a pitch, and a roll in radians.

In the asteroid scene, the ship follows `SHIP_PATH`: wide turns to the left and right, and smaller
moves up and down and forward and back.
The path starts at the start position of the ship and eases in over 3 seconds.
The nose of the ship points along the path, and the ship banks into turns.

To add a scene:

1. Write a file in `src/scenes/` with a function that takes the `SharedObjects` and returns a
   `Scene`.
2. Add the function to `SCENES` in `src/scenes/index.ts`.

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

- Heating: `Ship.setHeat()` makes the hull surfaces that face forward glow, from orange to white.
  A heat shell, the hull moved out along its normals and drawn with additive blending, adds a faint
  glow around the front of the ship.
- Fire light: the fire lights the whole ship with a flickering orange light, strongest on the
  surfaces that face back into the flames.
- Fire (`src/reentry.ts`): one quad along the flow, which turns around its axis to face the
  camera.
  Its shader makes turbulent flames that start just in front of the nose, wrap around the front of
  the ship, and trail back, wider and wider.
  The flames are white and yellow in the hot middle and near the front, and orange at the ragged
  edges.
  The ship hides the parts behind it, so the fire shows around the outline of the ship.
- Smoke (`src/reentry.ts`): soft puffs start behind the fire, move back, grow, and fade.
  Young puffs have an orange light from the fire.
  The CPU sorts the puffs from far to near, and they draw with premultiplied alpha blending.
- Plasma streaks: 160 additive ribbons on the solid parts of the ship add short-lived accents.
  Each streak shows only at random times.
- Sky: the `atmosphere` option of `Sky` draws the planet below the horizon, the bright edge of its
  atmosphere, and the haze.
  The horizon is tilted (`HORIZON_TILT`, 14 degrees): it is higher in front of the ship, at the
  right of the screen, so the ship seems to go down into the planet.
- Clouds (`src/clouds.ts`): soft sprites that face the camera.
  The CPU sorts them from far to near in each frame, and they draw with premultiplied alpha
  blending after the ship, so the ship flies through them.
  One instanced `drawIndexedIndirect` call draws them.
  The indirect buffer has the instance count, which the cloud density sets.
- Rain on the lens (`src/rain.ts`): a separate shader in the post pass reads the scene image.
  It makes a height field of the water on the glass: thin, long, slightly wavy lines of water that
  move across the lens at a constant speed, small beads that the lines leave on their paths, and
  a few still drops.
  The back end of a line fades out.
  The slope of the water bends the view through the drops, and the dry glass is a little misted
  (`MIST_BLUR` and `MIST_LIGHT`).
  The lines move straight from the front of the ship to its back (right to left).
  The scene projects the ship axis to the screen for this direction, so it is correct for all
  camera positions.
  The blend uses the blend constant, and `setBlendConstant()` sets the rain intensity.
- Lightning (`src/lightning.ts`): a flash has one to three quick pulses at a random point near the
  edge of the screen.
  The blend uses the blend constant, and `setBlendConstant()` sets the flash brightness.
  The flash also lights the clouds and the haze near the flash position.

The random values of the clouds and the lightning come from fixed seeds, so each run is the same.

### Dawn entry points

The scene uses these Dawn entry points from the list of the hackathon:

- `wgpuRenderPassEncoderSetBlendConstant`: the rain on the lens and the lightning.
- `wgpuRenderPassEncoderDrawIndexedIndirect`: the clouds (and the asteroids in scene 2).
- `wgpuQuerySetGetCount` and `wgpuQuerySetGetType`: `src/gpu-timer.ts` reads `querySet.count` and
  `querySet.type` to make the resolve buffer of the timestamp query set.

The scene does not use these entry points:

- `wgpuCommandEncoderWriteTimestamp`: `@kmamal/gpu` 1.0.0-6 rejects
  `GPUCommandEncoder.writeTimestamp()` with the `timestamp-query` feature.
  It needs an experimental Dawn feature that requires the `allow_unsafe_apis` toggle.
  The GPU timer uses the `timestampWrites` of the render pass instead.
- `wgpuBufferWriteMappedRange`: the JavaScript API has no call for it.
  `getMappedRange()` and `unmap()` do not use it.

## City flyover

The camera is at the right side of the ship and looks 60 meters in front of it, so the ship is
approximately one third from the left edge of the screen.
The ship flies from left to right, so the dark brown land and the towers move from right to left.
The land has low hills and no craters.
The sky is the yellow-brown haze of the planet, with the sun at the upper right of the screen,
in front of the ship.
The sun of the scene comes from that direction, and the ambient light has the same color.

The glass towers (`src/buildings.ts`) reflect their surroundings, and the reflections show the
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
   than `MIRROR_DISTANCE` (900) meters from the ship.
   It keeps the `MAX_MIRRORS` (48) walls nearest to the ship.
2. One pass draws the solid parts of the ship one time for each wall, with instancing
   (`Ship.drawMirrored()`).
   Each instance reflects the ship through the plane of its wall.
   The fragment shader keeps only the pixels where the line from the camera goes through the wall
   rectangle.
   The pass writes the color into a reflection image the size of the view, and the wall id into a
   second `r32uint` image.
3. In the main pass, each wall adds the reflection image at its own pixels, but only where the
   stored id is its own id.

A wall that is parallel to the flight path would show the reflection directly behind the ship,
where the ship hides it.
Thus, each tower turns 10 to 28 degrees from the heading (`TOWER_TURN`), and the reflection
appears farther along the street.
A row of 12 tall glass towers (`FRONT_COUNT`) is on the far edge of the street, near the ship, so
that most frames show a reflection.
The reflection does not show the engine flames.

A lens flare (`src/lens-flare.ts`) shows when the sun is not behind the towers or the ship.
It has a glow with rays and a horizontal streak at the sun, and a line of six faint colored ghosts
from the sun through the center of the screen.
Each ghost is a hexagon, a circle, or an oval, which a seeded random value selects (`SHAPE_SEED`).
An oval is squashed along the line from the sun through the center of the screen.
Occlusion queries measure how much of the sun is visible:

1. In the main pass, after the opaque objects and the ship, a disk over the sun is drawn two times
   with no color writes (`Scene.drawOcclusionQueries()`).
   Query 0 counts the samples that pass the depth test.
   Query 1 counts all of the samples, with no depth test.
2. After the main pass, `resolveQuerySet` writes the two counts into a storage buffer
   (`Scene.afterMainPass()`).
3. In the post pass, the flare shader reads the counts.
   Its brightness is the visible part of the sun: the first count divided by the second.

The counts stay on the GPU, so the flare changes in the same frame, with no read back to the CPU.
The main pass uses the occlusion query set of the scene (`Scene.occlusionQuerySet`).

## Sky

`src/sky.ts` draws the background of a scene with one full-screen shader.
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

The asteroid scene has `ASTEROID_COUNT` (4000) asteroids with a radius from 2 m to 60 m.
Small asteroids are much more common than large asteroids.
The GPU does all of the work after the start:

1. At the start, a compute shader makes `ASTEROID_SHAPES` (8) rock shapes from an icosphere.
   The surface uses the design of the terrain in 3D: Perlin noise and small craters with the same
   bowl and rim.
   Each shape is also stretched by a random amount on each axis.
   Each shape has two levels of detail (LOD): 5120 triangles and 320 triangles.
   Both come from the same surface function, so they have the same shape.
2. In each frame, a compute shader moves and turns each asteroid.
   It removes the asteroids that are outside the view, selects the LOD from the size on the screen,
   and adds each visible asteroid to the list of its shape and LOD.
   With an atomic add, it counts the instances of each list in the indirect draw buffer.
3. The render pass draws each list with one instanced `drawIndexedIndirect` call (16 calls).
   The vertex shader reads the shape vertices and the asteroid data from storage buffers.

The asteroids move toward the camera at `FLOW_SPEED` (150 m/s), with a small random velocity each.
They stay in a box around the ship: an asteroid that leaves one side comes back on the other side.
No asteroid can go into two tubes along the heading:

- The ship tube (radius `SHIP_CLEARANCE`, 50 m) follows the ship path.
  For each asteroid, the shader calculates when the asteroid comes to the ship, and keeps the
  asteroid away from the position of the ship path at that time.
  Thus the ship flies near the asteroids, but it does not hit them.
- The camera tube (radius `CAMERA_CLEARANCE`, 50 m) is a straight tube through the camera.

More asteroids start near the center of the box than near its sides (`BOX_CENTER_BIAS`), so that
some asteroids are near the ship path.
The start positions come from a random number generator with a fixed seed, so each run of the
benchmark is the same.
The constants are at the top of `src/asteroids.ts`.

## Camera path

The camera moves on a horizontal circle around the ship center, and it always looks at the ship
center.
The circle has the start distance and height of the camera.
The path repeats every `CAMERA_PATH_PERIOD` seconds (20):

| Time (s) | Camera                                                   |
| -------- | -------------------------------------------------------- |
| 0 to 3   | At the start position, behind the ship.                  |
| 3 to 5   | Moves `CAMERA_ORBIT_ANGLE` (20 degrees) to the left.     |
| 5 to 9   | Stays at the left, with a view of the left of the ship.  |
| 9 to 12  | Moves to 20 degrees to the right.                        |
| 12 to 16 | Stays at the right, with a view of the right of the ship. |
| 16 to 18 | Moves back to the start position.                        |
| 18 to 20 | Stays at the start position.                             |

`CAMERA_PATH` in `src/app.ts` holds these times and angles.
Each move starts and stops smoothly.
The sun direction and the ship position use the start position of the camera, so they do not
change when the camera moves.

## Ship

Each target loads `lunarg-ship/lunarg_ship.glb` at startup: the desktop target reads the file,
and the browser target fetches it.
The ship is `SHIP_DISTANCE` meters from the camera, on the center of the view.
The ship stays level, and its front (+Z in the model) points along the camera heading.
Thus the camera sees the engines at the back of the ship.

The engines start when the application starts, and they run in all scenes.
The `EnginesIgnite` animation plays once, and the `EnginesRunning` animation loops.
`Ship.setEnginesOn(false)` plays the `EnginesShutdown` animation, and then stops `EnginesRunning`.
A change in the middle of an ignition or a shutdown starts the other animation at the current
flame size, so the flames do not jump.

### Engine boost

A scene turns the boost on with `Ship.setBoost(true)`.
When a scene starts, the App turns the boost off and puts the ship back at its start position.

The terrain scene starts the boost `FLY_OFF_TIME` seconds (3) before its end.
Then the ship flies away from the camera with an acceleration of `FLY_OFF_ACCELERATION` (600 m/s²),
so it is very small before the fade to black.
The camera does not follow the ship.
The asteroid scene starts with the ship at its start position, with the engines on and no boost.

| Item                     | Without a boost                     | During a boost                 |
| ------------------------ | ----------------------------------- | ------------------------------ |
| Flames                   | `BOOST_BASE_LEVEL` (0.5) brightness | Full brightness, 1.6 x longer  |
| Engine lights and glow   | 0.5 brightness                      | Full brightness                |
| Terrain or asteroid speed | Usual speed                        | 2 x the usual speed            |

The boost comes on in `BOOST_RISE_TIME` seconds (0.4) and goes off in `BOOST_FALL_TIME` seconds
(1.2), so all of the changes are smooth.
The `BOOST_` constants are at the top of `src/ship.ts`, and `BOOST_SPEED_SCALE` is at the top of
`src/app.ts`.

The solid parts of the ship use the sun with `applyLight()`.
They do not get shadows from the terrain, and they do not cast shadows on the terrain.
The flames are unlit.
They use their vertex colors with additive blending, as `lunarg-ship/viewer.html` does.
This renderer has no full-screen bloom.
Instead, a glow sprite at each engine light adds a soft halo: a quad that faces the camera and adds
the light color.
The glow has the same fade and flicker as the light, and the depth test hides it behind the ship.
The `GLOW_` constants at the top of `src/ship.ts` set its size and brightness.

While the engines run, one orange point light behind each nozzle lights the solid parts of the
ship.
The strength of each light follows the flame size, so the light fades in and out with the
ignition and the shutdown.
The strength also flickers: it is the product of two sine waves, with a different phase for each
engine.
The `ENGINE_LIGHT_` constants at the top of `src/ship.ts` set the color, the strength, the
distance, and the flicker.
The engine lights do not light the terrain, and they do not cast shadows.

`src/gltf.ts` supports only the glTF features that the ship uses.
It throws an error for other features, for example textures, skins, or STEP interpolation.

## Known issues

- With `@kmamal/gpu` 1.0.0-6, the device and the async operations do not keep the `GPU` object
  (from `gpu.create()`) alive.
  If the garbage collector frees it, the binding frees the Dawn instance.
  Then the next poll of Dawn (`InstanceBase::ProcessEvents`, for a pending `mapAsync()`) uses
  freed memory.
  The process stops with a native error (a segmentation fault, `std::system_error`, or a glibc
  `pthread_mutex_lock` or `tpp.c` assertion), or it hangs.
  This usually occurs only after a minute or more, so it is a problem in a full benchmark run.
  Thus `src/desktop.ts` keeps the `GPU` object at module scope.
- At startup, Dawn shows two warnings about `maxDynamicUniformBuffersPerPipelineLayout` and
  `maxDynamicStorageBuffersPerPipelineLayout`.
  You can ignore them.
- The desktop window takes the keyboard focus when it opens.
  If you press `Esc` in another window, for example a terminal, while the application window has the
  focus, the application stops.
  The console then shows `Esc pressed.` and `The window closed.`
- The application calls `process.exit()` when the window closes.
  If Node.js releases the Dawn objects in its usual shutdown, Dawn fails a `RefCounted` assertion
  and the process crashes.
