# WebGPU Hackathon 2026

This application renders a terrain grid with WebGPU.
It has two targets that share the same rendering code:

- Desktop: Node.js with an SDL window.
- Browser: a web page with a canvas, served and built with [Vite](https://vite.dev).

The camera is 500 m above the ground and tilts down.
The hills and craters move toward the ship, but the ship does not move.
The camera moves around the ship on a path that repeats every 20 seconds.
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
| Space | Hold to run the ship engines.                   |

The window close button also exits the desktop application.

## Source files

| File                 | Contents                                                              |
| -------------------- | --------------------------------------------------------------------- |
| `src/app.ts`         | The shared scene: camera, camera path, sun, ship placement, and frames. |
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
Each frame, `src/app.ts` moves `worldPos` along the camera heading at `TERRAIN_SPEED` meters
per second.
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

The engines run only while you hold Space:

1. When you press Space, the `EnginesIgnite` animation plays once and the `EnginesRunning`
   animation loops.
2. When you release Space, the `EnginesShutdown` animation plays.
   When it is complete, `EnginesRunning` stops.

If you release Space during the ignition, the shutdown starts at the current flame size.
If you press Space during the shutdown, the ignition starts at the current flame size.
Thus the flames do not jump.
The engines also stop when the window is not in focus, because the window does not get the key
release.

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
