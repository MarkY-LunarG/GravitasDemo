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
| `src/mat4.ts`        | 4x4 matrix functions for the model, view, and projection matrices.    |
| `src/gpu-types.ts`   | WebGPU type names from the `@kmamal/gpu` typings.                     |

To change the camera position, the look-at point, or the field of view, edit the constants at the
top of `src/main.ts`.
To change the grid size or the number of grid points, edit the constants at the top of
`src/terrain.ts`.
All world units are meters.

## Known issues

- At startup, Dawn shows two warnings about `maxDynamicUniformBuffersPerPipelineLayout` and
  `maxDynamicStorageBuffersPerPipelineLayout`.
  You can ignore them.
- The application calls `process.exit()` when the window closes.
  If Node.js releases the Dawn objects in its usual shutdown, Dawn fails a `RefCounted` assertion
  and the process crashes.
