// The interface of a benchmark scene, and the shared objects that each scene can use.
//
// The App (src/app.ts) owns the shared objects. In each frame, it moves the camera, updates and
// draws the ship, and calls the update() and draw() of the current scene. A scene contains only
// what is special to it: its name, its duration, its own objects, and which shared objects it draws.
// The engines run in all scenes. When a scene starts, the App puts the ship back at its start
// position and turns the boost off.

import type { Mat4, Vec3 } from '../mat4.js';
import type { DirectionalLight } from '../light.js';
import type { Ship } from '../ship.js';
import type { Terrain } from '../terrain.js';

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
  // The command encoder of the frame. A scene can record compute passes in it. The render pass
  // comes after them.
  readonly encoder: GPUCommandEncoder;
}

export interface Scene {
  readonly name: string;
  // The duration in seconds. The last scene can have a duration of Infinity, so that it continues
  // until the application stops.
  readonly duration: number;
  // True to keep the camera at its start position. Otherwise, the camera follows its path.
  readonly stationaryCamera?: boolean;
  // Advance the scene objects. The App calls this before the render pass of the frame.
  update?(frame: FrameInfo): void;
  // Draw the scene objects. The App draws the ship after the scene objects.
  draw(pass: GPURenderPassEncoder): void;
}
