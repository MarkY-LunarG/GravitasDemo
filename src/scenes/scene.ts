// The interface of a benchmark scene, and the shared objects that each scene can use.
//
// The App (src/app.ts) owns the shared objects. In each frame, it moves the camera, updates and
// draws the ship, and calls the update() and draw() of the current scene. A scene contains only
// what is special to it: its name, its duration, its own objects, and which shared objects it draws.
// When a scene starts, the App puts the ship back at its start position, turns the boost and the
// heat off, sets the engines on or off for the scene, and sets the sun and the terrain style of the
// scene.

import type { Mat4, Vec3 } from '../mat4.js';
import type { DirectionalLight } from '../light.js';
import type { Ship } from '../ship.js';
import type { Terrain, TerrainStyle } from '../terrain.js';

// The sun of a scene: the direction from a surface toward the sun, the color of the sunlight, and
// the color of the ambient light.
export interface SceneSun {
  readonly direction: Vec3;
  readonly color: Vec3;
  readonly ambient: Vec3;
}

// A turn of the ship around its center, in radians. Positive values turn the nose to the right,
// raise the nose, and move the top of the ship to its right (a bank into a right turn).
export interface ShipTurn {
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
}

// The objects that all scenes share. The App makes them once.
export interface SharedObjects {
  readonly device: GPUDevice;
  // The color format and the depth format of the main render pass. A scene that makes pipelines
  // must use these formats.
  readonly format: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  readonly sun: DirectionalLight;
  readonly terrain: Terrain;
  // A scene can use the ship to turn the engine boost on.
  readonly ship: Ship;
  // The start position of the ship center, and the horizontal unit vector of the ship front.
  readonly shipCenter: Vec3;
  readonly heading: Vec3;
  // The camera position of a stationary camera. It looks at shipCenter.
  readonly cameraStart: Vec3;
  // Move the ship center to offset meters from its start position, along the right, up, and
  // heading directions, and turn the ship. The camera does not follow the ship.
  moveShip(offset: Vec3, turn?: ShipTurn): void;
}

// The values of one frame that a scene can use.
export interface FrameInfo {
  // The time step in seconds.
  readonly seconds: number;
  // The time in seconds since the start of the scene.
  readonly sceneTime: number;
  // Things that move past the ship move this many times faster than usual. It is 1 without an
  // engine boost, and larger during a boost.
  readonly speedScale: number;
  readonly viewProjection: Mat4;
  readonly cameraPosition: Vec3;
  // The size of the view in pixels.
  readonly width: number;
  readonly height: number;
  // The command encoder of the frame. A scene can record compute passes in it. The render pass
  // comes after them.
  readonly encoder: GPUCommandEncoder;
}

export interface Scene {
  readonly name: string;
  // The duration in seconds. The last scene can have a duration of Infinity, so that it continues
  // until the application stops. Otherwise, the App is finished at the end of the last scene.
  readonly duration: number;
  // False for a scene that is not part of the benchmark (the intro). It has no result and no scene
  // number, and --scene=N does not count it.
  readonly benchmark?: boolean;
  // False for a scene with the engines off. The engines are on or off at the start of the scene.
  readonly engines?: boolean;
  // A camera that does not move, at this angle in degrees around the ship: 0 is behind the ship,
  // 90 is at its left side, and -90 is at its right side. The camera stays at the start distance
  // and height, and looks at the start position of the ship. Without it, the camera follows its path.
  readonly cameraAngle?: number;
  // The camera looks at a point this many meters in front of the start position of the ship, along
  // its heading. A positive value moves the ship to the left of the screen in a side view.
  readonly cameraLookAhead?: number;
  // The sun of the scene. Without it, the scene has the default sun of the App.
  readonly sun?: SceneSun;
  // The look of the shared terrain. Without it, the terrain has DEFAULT_TERRAIN_STYLE.
  readonly terrainStyle?: TerrainStyle;
  // Advance the scene objects. The App calls this before the render pass of the frame.
  update?(frame: FrameInfo): void;
  // Draw the scene objects. The App draws the ship after the scene objects.
  draw(pass: GPURenderPassEncoder): void;
  // Draw blended objects that the ship can be behind or in, and screen effects. The App calls this
  // after it draws the ship.
  drawAfterShip?(pass: GPURenderPassEncoder): void;
  // The occlusion query set of the main pass. The scene uses it in drawOcclusionQueries().
  readonly occlusionQuerySet?: GPUQuerySet;
  // Draw objects in occlusion queries. The App calls this in the main pass, after it draws the
  // ship and before drawAfterShip(), so the depth buffer has all of the opaque objects.
  drawOcclusionQueries?(pass: GPURenderPassEncoder): void;
  // Record commands that use the results of the main pass, for example resolveQuerySet() or passes
  // that read the scene image. The App calls this after the main pass and before the post pass.
  // sceneView is the image of the main pass.
  afterMainPass?(encoder: GPUCommandEncoder, sceneView: GPUTextureView): void;
  // False when the App must not draw the ship in this frame. Without it, the App draws the ship.
  shipVisible?(): boolean;
  // Draw screen effects that read the image of the scene, for example water on the camera lens.
  // The App calls this in a second pass, after it copies the scene image to the output. The pass
  // has no depth buffer. sceneView has the same size and format as the output.
  drawPost?(pass: GPURenderPassEncoder, sceneView: GPUTextureView): void;
}
