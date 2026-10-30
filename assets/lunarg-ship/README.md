# LunarG ship model

`lunarg_ship.glb` is a glTF 2.0 model of the ship in `lunarg-ship-design.jpg`.
`build_ship.mjs` generates the model.
`viewer.html` shows the model with the three.js `WebGPURenderer`.

## Dimensions and axes

- Units are meters.
- +Y is up and +Z is the front of the ship.
- The hull is 50 m tall and 10 m wide. The ship stands on y = 0.
- The engines are at x = ±13 m, so the span across the engines is approximately 29 m.

## Engine state

The node `EngineL_Flames` and the node `EngineR_Flames` hold the flame meshes.
Their default scale is 0.0001, so the engines are unlit when the model loads.

The model has three animations:

| Animation         | Play mode        | Effect                                        |
|-------------------|------------------|-----------------------------------------------|
| `EnginesIgnite`   | Once, clamp      | Scales the flame roots from 0 to 1 (1.3 s).   |
| `EnginesRunning`  | Loop (4 s)       | Flicker: layer scale, spin, and morph weights. |
| `EnginesShutdown` | Once, clamp      | Scales the flame roots from 1 to 0 (0.9 s).   |

To light the engines, play `EnginesIgnite` and `EnginesRunning` together.
To stop the engines, stop `EnginesIgnite` and play `EnginesShutdown`.
When `EnginesShutdown` is complete, stop `EnginesRunning`.

The flames use only core glTF animation (scale, rotation, and morph weights).
The flame materials use `KHR_materials_unlit` and `COLOR_0` with alpha.
For a stronger glow, draw the materials named `Flame_*` with additive blending and bloom.
`viewer.html` shows how to do this.

## Use

Rebuild the model:

```sh
node build_ship.mjs
```

Open the viewer through a local web server, because browsers block `file://` loads:

```sh
python3 -m http.server 8000
# open http://localhost:8000/viewer.html
```

Press Space, or click **Ignite** and **Shutdown**, to change the engine state.
Add `?ignite` to the URL to light the engines when the page opens.
