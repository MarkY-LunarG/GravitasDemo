// The scene: a terrain with Perlin noise and craters, the LunarG ship, the sun, and the camera.
// The camera follows a path that repeats: it moves around the ship to the left, then to the
// right, and then back to the center. The terrain features move toward the ship.
//
// This code uses only the standard WebGPU API, so the desktop target (src/desktop.ts) and the
// browser target (src/browser.ts) both use it. Each target makes the GPU device, loads the ship
// model, sends key events to the App, and calls App.frame() once for each frame.

import { type GltfModel } from './gltf.js';
import { DirectionalLight } from './light.js';
import { type Vec3, compose, lookAt, multiply, perspective, transformPoint, viewToWorldDirection } from './mat4.js';
import { Ship } from './ship.js';
import { TERRAIN_RADIUS, Terrain } from './terrain.js';

// All world units are meters. The camera is above the point (CAMERA_CORNER, CAMERA_CORNER), and
// its heading is toward the origin. The terrain grid is a sector around the point below the camera.
const CAMERA_CORNER = -12500;
const EYE_HEIGHT = 500;
// The camera looks horizontally toward the origin, then tilts down by this angle.
// At -10 degrees, the terrain fills approximately the bottom two thirds of the window.
const CAMERA_PITCH = (-10 * Math.PI) / 180;
const FIELD_OF_VIEW_Y = (45 * Math.PI) / 180;
const NEAR_PLANE = 1;
// The terrain grid ends at TERRAIN_RADIUS, so the far plane does not need to be farther away.
const FAR_PLANE = TERRAIN_RADIUS;

// All pipelines that draw in the main render pass must use this depth format.
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

// The speed at which the terrain features move toward the camera, in meters per second.
// During an engine boost, the speed increases to BOOST_TERRAIN_SPEED times this value.
const TERRAIN_SPEED = 1200;
const BOOST_TERRAIN_SPEED = 2;

// The sun is a directional light. This is the sun position in the view space of a level camera
// (pitch 0), where the camera is at the origin and looks along -Z, +X is to the right, and +Y is up.
// The level view keeps the sun 45 degrees above the horizon for all values of CAMERA_PITCH.
// The sun is in front of the camera, 45 degrees to the left of the view direction, and
// 45 degrees above the horizon: the height is equal to the horizontal distance, 9000 * sqrt(2).
// Only the direction to this point is important, because the sun is infinitely far away.
const SUN_VIEW_POSITION = [-9000, 9000 * Math.SQRT2, -9000] as const;
// A bright sun and a dim ambient term give high contrast: slopes that face away from the sun
// are dark. Increase AMBIENT_COLOR for softer shadows.
const SUN_COLOR = [1.0, 1.0, 1.0] as const;
const AMBIENT_COLOR = [0.0, 0.0, 0.0] as const;

// The distance from the camera to the center of the ship, along the center of the view.
// The ship is 50 m tall, so at 250 m it fills approximately one quarter of the window height.
const SHIP_DISTANCE = 250;

const EYE = [CAMERA_CORNER, EYE_HEIGHT, CAMERA_CORNER] as const;
// The horizontal unit vector from the camera toward the origin.
const HEADING = [-EYE[0] / Math.hypot(EYE[0], EYE[2]), 0, -EYE[2] / Math.hypot(EYE[0], EYE[2])] as const;

// The unit vector along the center of the view. The heading is toward the origin, and the pitch
// tilts it up or down.
function viewDirection(pitch: number): readonly [number, number, number] {
  return [HEADING[0] * Math.cos(pitch), Math.sin(pitch), HEADING[2] * Math.cos(pitch)];
}

// The view of the camera at its start position. The sun direction uses the level view (pitch 0).
function computeView(pitch: number): Float32Array {
  const eye = EYE;
  const forward = viewDirection(pitch);
  return lookAt(eye, [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]], [0, 1, 0]);
}

// The world position of the ship center: on the center of the start view, SHIP_DISTANCE from
// the camera.
const SHIP_CENTER = [
  EYE[0] + viewDirection(CAMERA_PITCH)[0] * SHIP_DISTANCE,
  EYE[1] + viewDirection(CAMERA_PITCH)[1] * SHIP_DISTANCE,
  EYE[2] + viewDirection(CAMERA_PITCH)[2] * SHIP_DISTANCE,
] as const;

// The camera path. The camera moves on a horizontal circle around the ship center, at its start
// distance and height, and always looks at the ship center. The path repeats every
// CAMERA_PATH_PERIOD seconds. Each key is [time in seconds, angle], where the angle is a fraction
// of CAMERA_ORBIT_ANGLE: 1 is to the left of the start position, and -1 is to the right.
// Between two keys, the angle changes along a smooth curve.
const CAMERA_ORBIT_ANGLE = (20 * Math.PI) / 180;
const CAMERA_PATH_PERIOD = 20;
const CAMERA_PATH = [
  [0, 0],
  [3, 0],
  [5, 1],
  [9, 1],
  [12, -1],
  [16, -1],
  [18, 0],
  [20, 0],
] as const;

// The orbit angle of the camera, in radians, at a time in seconds.
function cameraOrbitAngle(seconds: number): number {
  const time = seconds % CAMERA_PATH_PERIOD;
  for (let key = 1; key < CAMERA_PATH.length; ++key) {
    const [endTime, endAngle] = CAMERA_PATH[key];
    if (time <= endTime) {
      const [startTime, startAngle] = CAMERA_PATH[key - 1];
      const fraction = (time - startTime) / (endTime - startTime);
      const smooth = fraction * fraction * (3 - 2 * fraction);
      return (startAngle + (endAngle - startAngle) * smooth) * CAMERA_ORBIT_ANGLE;
    }
  }
  return 0;
}

// The camera position at an orbit angle. Positive angles move the camera to its left.
function cameraEye(angle: number): Vec3 {
  const distance = Math.hypot(EYE[0] - SHIP_CENTER[0], EYE[2] - SHIP_CENTER[2]);
  // The horizontal unit vector to the left of the start heading.
  const left = [HEADING[2], 0, -HEADING[0]];
  return [
    SHIP_CENTER[0] + (-HEADING[0] * Math.cos(angle) + left[0] * Math.sin(angle)) * distance,
    EYE[1],
    SHIP_CENTER[2] + (-HEADING[2] * Math.cos(angle) + left[2] * Math.sin(angle)) * distance,
  ];
}

// Put the ship center at SHIP_CENTER. The ship stays level, and its front (+Z) points along the
// start heading of the camera.
function placeShip(ship: Ship): void {
  const yaw = Math.atan2(HEADING[0], HEADING[2]);
  const rotation = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] as const;
  const rotatedCenter = transformPoint(compose([0, 0, 0], rotation, [1, 1, 1]), ship.center);
  ship.setPlacement(
    [SHIP_CENTER[0] - rotatedCenter[0], SHIP_CENTER[1] - rotatedCenter[1], SHIP_CENTER[2] - rotatedCenter[2]],
    rotation,
  );
}

function computeProjection(aspect: number): Float32Array {
  return perspective(FIELD_OF_VIEW_Y, aspect, NEAR_PLANE, FAR_PLANE);
}

export class App {
  private readonly device: GPUDevice;
  private readonly terrain: Terrain;
  private readonly ship: Ship;
  private depthTexture: GPUTexture | null = null;
  // The time in seconds since the first frame. The camera path uses it.
  private elapsed = 0;
  // worldPos moves forward along the start heading of the camera. The terrain samples its height
  // field at worldPos, so the terrain features come toward the ship, but the ship does not move.
  private readonly worldPos = [0, 0, 0];

  // format is the format of the texture views that frame() draws into.
  constructor(device: GPUDevice, format: GPUTextureFormat, shipModel: GltfModel) {
    this.device = device;
    // All objects in the scene use this one light.
    const sun = new DirectionalLight(
      device,
      viewToWorldDirection(computeView(0), SUN_VIEW_POSITION),
      SUN_COLOR,
      AMBIENT_COLOR,
    );
    this.terrain = new Terrain(device, format, DEPTH_FORMAT, sun);
    this.ship = new Ship(device, format, DEPTH_FORMAT, sun, shipModel);
    placeShip(this.ship);
  }

  // The engines run only while the target reports that Space is held down.
  setEnginesOn(on: boolean): void {
    this.ship.setEnginesOn(on);
  }

  toggleTerrainRenderMode(): void {
    this.terrain.setRenderMode(this.terrain.renderMode === 'solid' ? 'wireframe' : 'solid');
  }

  // Advance the scene by a time step in seconds, and draw it into colorView. width and height are
  // the size of colorView in pixels.
  frame(seconds: number, colorView: GPUTextureView, width: number, height: number): void {
    this.elapsed += seconds;
    this.updateCamera(width / height);
    this.ship.update(seconds);
    // The boost level changes smoothly, so the speed also changes smoothly.
    const speed = TERRAIN_SPEED * (1 + (BOOST_TERRAIN_SPEED - 1) * this.ship.boostLevel);
    this.worldPos[0] += HEADING[0] * speed * seconds;
    this.worldPos[2] += HEADING[2] * speed * seconds;
    this.terrain.update([this.worldPos[0], this.worldPos[1], this.worldPos[2]]);
    this.render(colorView, width, height);
  }

  // Move the camera along its path. The terrain grid follows the camera, so that the grid always
  // covers the view.
  private updateCamera(aspect: number): void {
    const eye = cameraEye(cameraOrbitAngle(this.elapsed));
    const toShip = [SHIP_CENTER[0] - eye[0], 0, SHIP_CENTER[2] - eye[2]] as const;
    const length = Math.hypot(toShip[0], toShip[2]);
    this.terrain.setGridCenter(eye, [toShip[0] / length, 0, toShip[2] / length]);
    const view = lookAt(eye, SHIP_CENTER, [0, 1, 0]);
    const projection = computeProjection(aspect);
    this.terrain.setViewProjection(multiply(projection, view));
    this.ship.setCamera(view, projection);
  }

  private render(colorView: GPUTextureView, width: number, height: number): void {
    // The depth texture must have the same size as the color texture.
    if (!this.depthTexture || this.depthTexture.width !== width || this.depthTexture.height !== height) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [width, height],
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    this.terrain.draw(pass);
    this.ship.draw(pass);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
