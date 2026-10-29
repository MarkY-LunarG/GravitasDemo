# WebGPU Hackathon 2026

This application renders a terrain grid with WebGPU.
It has two targets that share the same rendering code:

- Desktop: Node.js with an SDL window.
- Browser: a web page with a canvas, served and built with [Vite](https://vite.dev).

The camera is 500 m above the ground and tilts down.
The hills and craters move toward the ship, but the ship does not move.
The camera moves around the ship on a path that repeats every 20 seconds.
The application is a benchmark with a sequence of scenes.
After 40 seconds, the terrain goes away, and the ship flies through a field of asteroids.
The LunarG ship (`lunarg-ship/lunarg_ship.glb`) is in the center of the view and faces away from
the camera.

The desktop target uses [`@kmamal/gpu`](https://github.com/kmamal/gpu) for WebGPU through Google
Dawn.
It uses [`@kmamal/sdl`](https://github.com/kmamal/node-sdl) for the window and the keyboard.
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

Each scene is in its own file in `src/scenes/`, and `SCENES` in `src/scenes/index.ts` gives their
order:

| Scene                | File                | Duration   | Contents                         |
| -------------------- | ------------------- | ---------- | -------------------------------- |
| `Terrain and ship`   | `terrain-scene.ts`  | 40 seconds | The terrain, the ship, and stars. |
| `Asteroids and ship` | `asteroid-scene.ts` | No end     | The ship moves around the asteroids, with a planet, a nebula, and stars. The camera does not move. |

The last scene continues until you stop the application.
Between two scenes, the image fades to black in `TRANSITION_FADE_TIME` seconds (0.5), and then
fades in from black in the same time.
The engines continue across the transition.
A scene with `stationaryCamera: true` keeps the camera at its start position.
Other scenes use the camera path.
`App.sceneName` gives the name of the current scene.

The App (`src/app.ts`) owns the objects that all scenes share: the sun, the terrain, the ship,
the camera and its path, and the fade.
In each frame, the App moves the camera and updates the ship.
Then it calls `update()` of the current scene, which can record compute passes.
In the render pass, it calls `draw()` of the current scene, and then draws the ship and the fade.
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

- At startup, Dawn shows two warnings about `maxDynamicUniformBuffersPerPipelineLayout` and
  `maxDynamicStorageBuffersPerPipelineLayout`.
  You can ignore them.
- The application calls `process.exit()` when the window closes.
  If Node.js releases the Dawn objects in its usual shutdown, Dawn fails a `RefCounted` assertion
  and the process crashes.
