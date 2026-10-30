// The benchmark: a sequence of scenes with the LunarG ship, the sun, and the camera. Each scene is
// in its own file in src/scenes/, and src/scenes/index.ts gives their order. The App owns the
// objects that all scenes share: the terrain, the ship, the sun, the camera, and the fade. A short
// fade through black goes from one scene to the next. The ship engines run in all scenes.
// The camera follows a path that repeats: it moves around the ship to the left, then to the
// right, and then back to the center.
//
// This code uses only the standard WebGPU API, so the desktop target (src/desktop.ts) and the
// browser target (src/browser.ts) both use it. Each target makes the GPU device, loads the ship
// model, sends key events to the App, and calls App.frame() once for each frame.

import { Blit } from './blit.js';
import { Fade } from './fade.js';
import { type GltfModel } from './gltf.js';
import { GpuTimer } from './gpu-timer.js';
import { DirectionalLight } from './light.js';
import {
  type Mat4,
  type Vec3,
  compose,
  lookAt,
  multiply,
  perspective,
  quatFromAxisAngle,
  quatMultiply,
  transformPoint,
  viewToWorldDirection,
} from './mat4.js';
import { SCENES } from './scenes/index.js';
import type { Scene, SceneSun, SharedObjects, ShipTurn } from './scenes/scene.js';
import { Ship } from './ship.js';
import { DEFAULT_TERRAIN_STYLE, TERRAIN_RADIUS, Terrain } from './terrain.js';

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

// During an engine boost, things that move past the ship (for example the terrain features and
// the asteroids) move up to BOOST_SPEED_SCALE times faster.
const BOOST_SPEED_SCALE = 2;

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

// The horizontal unit vector to the right of the start heading.
const RIGHT = [-HEADING[2], 0, HEADING[0]] as const;

// Put the ship center at offset from SHIP_CENTER, along RIGHT, up, and HEADING, in meters, and turn
// the ship around its center. Without a turn, the ship is level, and its front (+Z) points along
// HEADING. In the model, +X is to the left of the ship, +Y is up, and +Z is the front.
function placeShip(ship: Ship, offset: Vec3 = [0, 0, 0], turn: ShipTurn = { yaw: 0, pitch: 0, roll: 0 }): void {
  const heading = quatFromAxisAngle([0, 1, 0], Math.atan2(HEADING[0], HEADING[2]));
  // A turn of the nose to the right is a negative rotation around +Y, because +X is to the left.
  // A raise of the nose is a negative rotation around +X. A positive rotation around +Z moves the
  // top of the ship to its right.
  const local = quatMultiply(
    quatFromAxisAngle([0, 1, 0], -turn.yaw),
    quatMultiply(quatFromAxisAngle([1, 0, 0], -turn.pitch), quatFromAxisAngle([0, 0, 1], turn.roll)),
  );
  const rotation = quatMultiply(heading, local);
  const rotatedCenter = transformPoint(compose([0, 0, 0], rotation, [1, 1, 1]), ship.center);
  const position = [0, 1, 2].map(
    (i) => SHIP_CENTER[i] + RIGHT[i] * offset[0] + (i === 1 ? offset[1] : 0) + HEADING[i] * offset[2],
  );
  ship.setPlacement(
    [position[0] - rotatedCenter[0], position[1] - rotatedCenter[1], position[2] - rotatedCenter[2]],
    rotation,
  );
}

function computeProjection(aspect: number): Float32Array {
  return perspective(FIELD_OF_VIEW_Y, aspect, NEAR_PLANE, FAR_PLANE);
}

// The fade to black takes TRANSITION_FADE_TIME seconds before the end of a scene, and the fade
// from black takes the same time after the start of the next scene.
const TRANSITION_FADE_TIME = 0.5;

// The scene at a time in seconds, the start time of the scene, and the amount of the fade to black
// at that time (0 to 1). After the last scene ends, the last scene continues.
function sceneAt(scenes: readonly Scene[], seconds: number): { scene: Scene; start: number; fade: number } {
  let start = 0;
  for (let index = 0; index < scenes.length; ++index) {
    const scene = scenes[index];
    const end = start + scene.duration;
    if (seconds < end || index === scenes.length - 1) {
      let fade = 0;
      if (index > 0) {
        fade = Math.max(fade, 1 - (seconds - start) / TRANSITION_FADE_TIME);
      }
      if (index < scenes.length - 1) {
        fade = Math.max(fade, 1 - (end - seconds) / TRANSITION_FADE_TIME);
      }
      return { scene, start, fade: Math.max(0, Math.min(1, fade)) };
    }
    start = end;
  }
  return { scene: scenes[scenes.length - 1], start, fade: 0 };
}

// The benchmark result of one scene.
interface SceneStats {
  frames: number;
  seconds: number;
  gpuMilliseconds: number;
  gpuFrames: number;
}

// A scene writes its result when it ends. A scene with no end writes its result after this many
// seconds, and again after each interval.
const STATS_INTERVAL = 20;

export class App {
  private readonly device: GPUDevice;
  // Null if the device cannot write timestamps. Then the results have no GPU time.
  private readonly gpuTimer: GpuTimer | null;
  private stats: SceneStats = { frames: 0, seconds: 0, gpuMilliseconds: 0, gpuFrames: 0 };
  private readonly terrain: Terrain;
  private readonly sun: DirectionalLight;
  // The sun of the scenes that do not have their own sun.
  private readonly defaultSun: SceneSun;
  private readonly ship: Ship;
  private readonly fade: Fade;
  private readonly blit: Blit;
  private readonly format: GPUTextureFormat;
  private readonly scenes: readonly Scene[];
  // The scene draws into this texture. Then a second pass copies it to the output, and screen
  // effects of the scene can read it.
  private sceneTexture: GPUTexture | null = null;
  private sceneView: GPUTextureView | null = null;
  private currentScene: Scene | null = null;
  private depthTexture: GPUTexture | null = null;
  // The time in seconds since the first frame. The camera path and the scene sequence use it.
  private elapsed = 0;

  // format is the format of the texture views that frame() draws into.
  constructor(device: GPUDevice, format: GPUTextureFormat, shipModel: GltfModel) {
    this.device = device;
    this.gpuTimer = GpuTimer.create(device);
    // All objects in all scenes use this one light. A scene can change its direction and colors.
    this.defaultSun = {
      direction: viewToWorldDirection(computeView(0), SUN_VIEW_POSITION),
      color: SUN_COLOR,
      ambient: AMBIENT_COLOR,
    };
    const sun = new DirectionalLight(device, this.defaultSun.direction, SUN_COLOR, AMBIENT_COLOR);
    this.sun = sun;
    this.terrain = new Terrain(device, format, DEPTH_FORMAT, sun);
    this.ship = new Ship(device, format, DEPTH_FORMAT, sun, shipModel);
    placeShip(this.ship);
    this.fade = new Fade(device, format, DEPTH_FORMAT);
    this.blit = new Blit(device, format);
    this.format = format;
    const shared: SharedObjects = {
      device,
      format,
      depthFormat: DEPTH_FORMAT,
      sun,
      terrain: this.terrain,
      ship: this.ship,
      shipCenter: SHIP_CENTER,
      heading: HEADING,
      cameraStart: cameraEye(0),
      moveShip: (offset, turn) => placeShip(this.ship, offset, turn),
    };
    this.scenes = SCENES.map((createScene) => createScene(shared));
  }

  // The name of the current benchmark scene.
  get sceneName(): string {
    return sceneAt(this.scenes, this.elapsed).scene.name;
  }

  // The number of scenes.
  get sceneCount(): number {
    return this.scenes.length;
  }

  // Go to the start of a scene. The scene numbers start at 1. The scene starts as after a normal
  // transition: the ship is at its start position, and the scene time is 0.
  jumpToScene(sceneNumber: number): void {
    const index = Math.max(0, Math.min(this.scenes.length - 1, Math.floor(sceneNumber) - 1));
    this.elapsed = this.scenes.slice(0, index).reduce((sum, scene) => sum + scene.duration, 0);
    // Start just after the fade from black.
    this.elapsed += index > 0 ? TRANSITION_FADE_TIME : 0;
  }

  // Go to the start of the next scene, or to the first scene after the last scene.
  nextScene(): void {
    const index = this.currentScene ? this.scenes.indexOf(this.currentScene) : 0;
    this.jumpToScene(((index + 1) % this.scenes.length) + 1);
  }

  toggleTerrainRenderMode(): void {
    this.terrain.setRenderMode(this.terrain.renderMode === 'solid' ? 'wireframe' : 'solid');
  }

  // Advance the current scene and the ship by a time step in seconds, and draw them into
  // colorView. width and height are the size of colorView in pixels.
  frame(seconds: number, colorView: GPUTextureView, width: number, height: number): void {
    this.elapsed += seconds;
    const { scene, start, fade } = sceneAt(this.scenes, this.elapsed);
    // Each scene starts with the ship at its start position, with no boost and no heat.
    if (scene !== this.currentScene) {
      if (this.currentScene) {
        this.reportStats(this.currentScene);
      }
      this.currentScene = scene;
      placeShip(this.ship);
      this.ship.setBoost(false);
      this.ship.setHeat(0);
      this.ship.resetEngines(scene.engines ?? true);
      const sceneSun = scene.sun ?? this.defaultSun;
      this.sun.setDirection(sceneSun.direction);
      this.sun.setColors(sceneSun.color, sceneSun.ambient);
      this.terrain.setStyle(scene.terrainStyle ?? DEFAULT_TERRAIN_STYLE);
    } else if (scene.duration === Infinity && this.stats.seconds >= STATS_INTERVAL) {
      this.reportStats(scene);
    }
    this.stats.frames += 1;
    this.stats.seconds += seconds;
    const { viewProjection, cameraPosition } = this.updateCamera(
      width / height,
      scene.cameraAngle,
      scene.cameraLookAhead ?? 0,
    );
    this.ship.update(seconds);
    const encoder = this.device.createCommandEncoder();
    scene.update?.({
      seconds,
      sceneTime: this.elapsed - start,
      // The boost level changes smoothly, so the speed also changes smoothly.
      speedScale: 1 + (BOOST_SPEED_SCALE - 1) * this.ship.boostLevel,
      viewProjection,
      cameraPosition,
      width,
      height,
      encoder,
    });
    this.render(encoder, colorView, width, height, scene, fade);
  }

  // Move the camera along its path, or put it at a fixed angle around the ship (in degrees). The
  // camera looks at a point lookAhead meters in front of the start position of the ship. Then give
  // the camera to the shared objects. The terrain grid follows the camera, so that the grid always
  // covers the view.
  private updateCamera(
    aspect: number,
    fixedAngle: number | undefined,
    lookAhead: number,
  ): { viewProjection: Mat4; cameraPosition: Vec3 } {
    const eye = cameraEye(fixedAngle !== undefined ? (fixedAngle * Math.PI) / 180 : cameraOrbitAngle(this.elapsed));
    const target: Vec3 = [
      SHIP_CENTER[0] + HEADING[0] * lookAhead,
      SHIP_CENTER[1] + HEADING[1] * lookAhead,
      SHIP_CENTER[2] + HEADING[2] * lookAhead,
    ];
    const toTarget = [target[0] - eye[0], 0, target[2] - eye[2]] as const;
    const length = Math.hypot(toTarget[0], toTarget[2]);
    this.terrain.setGridCenter(eye, [toTarget[0] / length, 0, toTarget[2] / length]);
    const view = lookAt(eye, target, [0, 1, 0]);
    const projection = computeProjection(aspect);
    const viewProjection = multiply(projection, view);
    this.terrain.setViewProjection(viewProjection);
    this.ship.setCamera(view, projection);
    return { viewProjection, cameraPosition: eye };
  }

  private render(
    encoder: GPUCommandEncoder,
    colorView: GPUTextureView,
    width: number,
    height: number,
    scene: Scene,
    fade: number,
  ): void {
    // The depth texture and the scene texture must have the same size as the output.
    if (!this.depthTexture || this.depthTexture.width !== width || this.depthTexture.height !== height) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [width, height],
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.sceneTexture?.destroy();
      this.sceneTexture = this.device.createTexture({
        size: [width, height],
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.sceneView = this.sceneTexture.createView();
    }
    const sceneView = this.sceneView!;
    const pass = encoder.beginRenderPass({
      timestampWrites: this.gpuTimer?.timestampWrites,
      colorAttachments: [
        {
          view: sceneView,
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
      ...(scene.occlusionQuerySet ? { occlusionQuerySet: scene.occlusionQuerySet } : {}),
    });
    // The ship goes after the opaque scene objects, because its flames and glow are blended and
    // do not write depth. Objects that draw after them would cover them. Blended scene objects that
    // the ship can fly through, and screen effects, go after the ship.
    scene.draw(pass);
    this.ship.draw(pass);
    scene.drawOcclusionQueries?.(pass);
    scene.drawAfterShip?.(pass);
    this.fade.draw(pass, fade);
    pass.end();
    scene.afterMainPass?.(encoder);

    // Copy the scene to the output, and then draw the screen effects that read the scene image.
    const post = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
    });
    this.blit.draw(post, sceneView);
    scene.drawPost?.(post, sceneView);
    post.end();
    this.gpuTimer?.resolve(encoder);
    this.device.queue.submit([encoder.finish()]);
    // The GPU time comes later. It goes to the stats of the scene that is current at that time,
    // which is the same scene, except for a frame or two at a scene change.
    this.gpuTimer?.read((milliseconds) => {
      this.stats.gpuMilliseconds += milliseconds;
      this.stats.gpuFrames += 1;
    });
  }

  // Write the benchmark result of a scene to the console, and start new stats.
  private reportStats(scene: Scene): void {
    const { frames, seconds, gpuMilliseconds, gpuFrames } = this.stats;
    const fps = seconds > 0 ? frames / seconds : 0;
    const gpu = gpuFrames > 0 ? `, GPU render pass ${(gpuMilliseconds / gpuFrames).toFixed(2)} ms` : '';
    console.log(`Scene "${scene.name}": ${frames} frames in ${seconds.toFixed(1)} s, ${fps.toFixed(1)} fps${gpu}`);
    this.stats = { frames: 0, seconds: 0, gpuMilliseconds: 0, gpuFrames: 0 };
  }
}
