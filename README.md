# WebGPU Hackathon 2026

This application renders a terrain grid with WebGPU in Node.js.
It shows the grid in an SDL window.
The camera is 500 m above the ground and tilts down.
The camera does not move, but the hills and craters move toward it.
The LunarG ship (`lunarg-ship/lunarg_ship.glb`) is in the center of the view and faces away from
the camera.

The application uses [`@kmamal/gpu`](https://github.com/kmamal/gpu) for WebGPU through Google Dawn.
It uses [`@kmamal/sdl`](https://github.com/kmamal/node-sdl) for the window and the keyboard.

The application uses the prerelease versions `@kmamal/gpu` 1.0.0-6 and `@kmamal/sdl` 1.0.0-5
(SDL3).
In `@kmamal/gpu` 0.2.1, `GPUTexture.createView()` always fails, so a depth buffer is not possible.
The two packages must have matching versions: `@kmamal/gpu` 1.0.0-6 cannot make a window surface
for a window from `@kmamal/sdl` 0.11.

## Requirements

- Node.js 24 or later.
- A GPU and driver that Dawn supports (Vulkan on Linux, D3D12 on Windows, Metal on macOS).
- A desktop session. The application opens a window, so it does not run headless.

## Install

```sh
npm install
```

Both `@kmamal` packages include prebuilt native binaries.
If npm reports that it did not run their install scripts, the application still runs.

## Run

Run the TypeScript source directly with `tsx`:

```sh
npm start
```

## Build

Compile the TypeScript to JavaScript in `dist/`, then run the result:

```sh
npm run build
node dist/main.js
```

To do a type check without output files:

```sh
npm run typecheck
```

## Keys

| Key   | Action                                          |
| ----- | ----------------------------------------------- |
| `W`   | Toggle between the solid and wireframe terrain. |
| `Esc` | Exit the application.                           |
| Space | Hold to run the ship engines.                   |

The window close button also exits the application.

## Source files

| File                 | Contents                                                              |
| -------------------- | --------------------------------------------------------------------- |
| `src/main.ts`        | Window, camera, key handling, and the render loop.                    |
| `src/terrain.ts`     | The terrain grid: shaders, pipelines, and the solid/wireframe mode.   |
| `src/light.ts`       | The directional light that all objects share, and its WGSL code.      |
| `src/mat4.ts`        | 4x4 matrix functions for the model, view, and projection matrices.    |
| `src/gpu-types.ts`   | WebGPU type names from the `@kmamal/gpu` typings.                     |
| `src/gltf.ts`        | A minimal binary glTF (.glb) loader and an animation sampler.         |
| `src/ship.ts`        | The ship: pipelines, the engine animations, and the engine state.     |

To change the camera position, the camera pitch (`CAMERA_PITCH`), or the field of view, edit the
constants at the top of `src/main.ts`.
To change the grid size or the number of grid points, edit the constants at the top of
`src/terrain.ts`.
To change the direction or the color of the sun, edit the `SUN_` constants in `src/main.ts`.
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
The grid is correct only for a camera that does not move.

Far cells are large, so the shader removes noise octaves and craters that are smaller than
approximately 4 cells.
Without this, the small features would flicker as the terrain moves.

The grid does not move.
`Terrain.update()` sets `worldPos`, an offset that the shader adds to each grid point before it
samples the height field.
Each frame, `src/main.ts` moves `worldPos` along the camera heading at `TERRAIN_SPEED` meters
per second.
Thus the terrain features come toward the camera.

## Lighting

One directional light, the sun, lights the scene.
`SUN_VIEW_POSITION` in `src/main.ts` sets the sun direction relative to the camera heading.
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
3. Give the pipeline a `depthStencil` state with the format `DEPTH_FORMAT` from `src/main.ts`.
4. Call `light.bind(pass)` before the draw.

Other objects do not cast shadows on the terrain, and the terrain does not cast shadows on them.

## Ship

`src/main.ts` loads `lunarg-ship/lunarg_ship.glb` at startup.
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
This renderer has no bloom and no engine lights, so the flames do not glow on other surfaces.

`src/gltf.ts` supports only the glTF features that the ship uses.
It throws an error for other features, for example textures, skins, or STEP interpolation.

## Known issues

- At startup, Dawn shows two warnings about `maxDynamicUniformBuffersPerPipelineLayout` and
  `maxDynamicStorageBuffersPerPipelineLayout`.
  You can ignore them.
- The application calls `process.exit()` when the window closes.
  If Node.js releases the Dawn objects in its usual shutdown, Dawn fails a `RefCounted` assertion
  and the process crashes.
