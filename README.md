# WebGPU Hackathon 2026

This application renders a flat terrain grid with WebGPU in Node.js.
It shows the grid in an SDL window.
The camera is above one corner of the grid and looks toward the center.

The application uses [`@kmamal/gpu`](https://github.com/kmamal/gpu) for WebGPU through Google Dawn.
It uses [`@kmamal/sdl`](https://github.com/kmamal/node-sdl) for the window and the keyboard.

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

The window close button also exits the application.

## Source files

| File                 | Contents                                                              |
| -------------------- | --------------------------------------------------------------------- |
| `src/main.ts`        | Window, camera, key handling, and the render loop.                    |
| `src/terrain.ts`     | The terrain grid: shaders, pipelines, and the solid/wireframe mode.   |
| `src/light.ts`       | The directional light that all objects share, and its WGSL code.      |
| `src/mat4.ts`        | 4x4 matrix functions for the model, view, and projection matrices.    |
| `src/gpu-types.ts`   | WebGPU type names from the `@kmamal/gpu` typings.                     |

To change the camera position, the look-at point, or the field of view, edit the constants at the
top of `src/main.ts`.
To change the grid size or the number of grid points, edit the constants at the top of
`src/terrain.ts`.
To change the direction or the color of the sun, edit the `SUN_` constants in `src/main.ts`.

## Lighting

One directional light, the sun, lights the scene.
`SUN_VIEW_POSITION` in `src/main.ts` sets the sun direction relative to the camera.
The value `[-9000, 9000 * Math.SQRT2, -9000]` puts the sun in front of the camera,
45 degrees to the left of the view direction, and 45 degrees above the horizon.
The solid terrain uses diffuse (Lambert) lighting with an ambient term.
The wireframe terrain does not use the light.

To light a new object with the same sun:

1. Add `LIGHT_WGSL` to the shader code, and call `applyLight()` in the fragment shader.
2. Put `light.bindGroupLayout` at index `LIGHT_BIND_GROUP` in the pipeline layout.
3. Call `light.bind(pass)` before the draw.
All world units are meters.

## Known issues

- At startup, Dawn shows two warnings about `maxDynamicUniformBuffersPerPipelineLayout` and
  `maxDynamicStorageBuffersPerPipelineLayout`.
  You can ignore them.
- The application calls `process.exit()` when the window closes.
  If Node.js releases the Dawn objects in its usual shutdown, Dawn fails a `RefCounted` assertion
  and the process crashes.
