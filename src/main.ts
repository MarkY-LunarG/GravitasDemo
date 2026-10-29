// Render a terrain grid with WebGPU in an SDL window.
// The camera does not move, and the terrain grid covers its view.
// The terrain features move toward the camera.
// The LunarG ship is in the center of the view and faces away from the camera.
// Hold Space to run the ship engines. Press W to toggle between the solid and the wireframe
// terrain. Press ESC to exit.

import { fileURLToPath } from 'node:url';
import gpu from '@kmamal/gpu';
import sdl from '@kmamal/sdl';
import { loadGlb } from './gltf.js';
import { DirectionalLight } from './light.js';
import { compose, lookAt, multiply, perspective, transformPoint, viewToWorldDirection } from './mat4.js';
import { Ship } from './ship.js';
import { TERRAIN_RADIUS, Terrain } from './terrain.js';

const WIDTH = 1920;
const HEIGHT = 1080;

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

// The window surface format. The default format of @kmamal/gpu is rgba16float, which changes
// the brightness of the colors, so request an 8-bit format with no sRGB encoding.
const SURFACE_FORMAT = 'bgra8unorm';
// All pipelines that draw in the main render pass must use this depth format.
const DEPTH_FORMAT = 'depth24plus';

// The speed at which the terrain features move toward the camera, in meters per second.
const TERRAIN_SPEED = 1200;

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

// The path is relative to this file, so it is correct from src/ (tsx) and from dist/ (tsc).
const SHIP_MODEL_PATH = fileURLToPath(new URL('../lunarg-ship/lunarg_ship.glb', import.meta.url));
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

function computeView(pitch: number): Float32Array {
  const eye = EYE;
  const forward = viewDirection(pitch);
  return lookAt(eye, [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]], [0, 1, 0]);
}

// Put the center of the ship on the center of the view, SHIP_DISTANCE from the camera.
// The ship stays level, and its front (+Z) points along the camera heading.
function placeShip(ship: Ship): void {
  const yaw = Math.atan2(HEADING[0], HEADING[2]);
  const rotation = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] as const;
  const rotatedCenter = transformPoint(compose([0, 0, 0], rotation, [1, 1, 1]), ship.center);
  const forward = viewDirection(CAMERA_PITCH);
  ship.setPlacement(
    [
      EYE[0] + forward[0] * SHIP_DISTANCE - rotatedCenter[0],
      EYE[1] + forward[1] * SHIP_DISTANCE - rotatedCenter[1],
      EYE[2] + forward[2] * SHIP_DISTANCE - rotatedCenter[2],
    ],
    rotation,
  );
}

function computeViewProjection(aspect: number): Float32Array {
  const projection = perspective(FIELD_OF_VIEW_Y, aspect, NEAR_PLANE, FAR_PLANE);
  return multiply(projection, computeView(CAMERA_PITCH));
}

async function main(): Promise<void> {
  const window = sdl.video.createWindow({
    title: 'WebGPU Terrain',
    width: WIDTH,
    height: HEIGHT,
    resizable: true,
    webgpu: true,
  });

  const instance = gpu.create([]);
  const adapter = await instance.requestAdapter();
  if (!adapter) {
    throw new Error('No WebGPU adapter is available');
  }
  const device = await adapter.requestDevice();
  // The @kmamal/gpu types do not export GPUUncapturedErrorEvent, so get it from the module type.
  device.addEventListener('uncapturederror', (event) => {
    console.error('WebGPU error:', (event as typeof gpu.GPUUncapturedErrorEvent).error.message);
  });

  const renderer = gpu.renderGPUDeviceToWindow({ device, window, format: SURFACE_FORMAT });

  // The pipelines must use the same format as the window surface.
  const surfaceFormat = renderer.getPreferredFormat();

  // All objects in the scene use this one light.
  const sun = new DirectionalLight(
    device,
    viewToWorldDirection(computeView(0), SUN_VIEW_POSITION),
    SUN_COLOR,
    AMBIENT_COLOR,
  );
  const terrain = new Terrain(device, surfaceFormat, DEPTH_FORMAT, sun);
  terrain.setGridCenter(EYE, HEADING);
  const ship = new Ship(device, surfaceFormat, DEPTH_FORMAT, sun, loadGlb(SHIP_MODEL_PATH));
  placeShip(ship);

  // The depth texture must have the same size as the window surface.
  const createDepthTexture = () => {
    const surface = renderer.getCurrentTexture();
    return device.createTexture({
      size: [surface.width, surface.height],
      format: DEPTH_FORMAT,
      usage: gpu.GPUTextureUsage.RENDER_ATTACHMENT,
    });
  };
  let depthTexture = createDepthTexture();

  const updateCamera = (): void => {
    const viewProjection = computeViewProjection(window.pixelWidth / window.pixelHeight);
    terrain.setViewProjection(viewProjection);
    ship.setViewProjection(viewProjection);
  };

  const render = (): void => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: renderer.getCurrentTextureView(),
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    terrain.draw(pass);
    ship.draw(pass);
    pass.end();
    device.queue.submit([encoder.finish()]);
    renderer.swap();
  };

  window.on('resize', () => {
    renderer.resize();
    depthTexture.destroy();
    depthTexture = createDepthTexture();
    updateCamera();
  });

  window.on('keyDown', (event) => {
    if (event.repeat) {
      return;
    }
    if (event.key === 'escape') {
      window.destroy();
    } else if (event.key === 'w') {
      terrain.setRenderMode(terrain.renderMode === 'solid' ? 'wireframe' : 'solid');
    } else if (event.key === ' ') {
      ship.setEnginesOn(true);
    }
  });

  // The engines run only while Space is held down.
  window.on('keyUp', (event) => {
    if (event.key === ' ') {
      ship.setEnginesOn(false);
    }
  });
  // The window does not get the key release if it is not in focus, so stop the engines.
  window.on('blur', () => {
    ship.setEnginesOn(false);
  });

  window.on('close', () => {
    device.destroy();
    // Exit now. If Node.js releases the Dawn objects in its normal shutdown,
    // Dawn fails a RefCounted assertion and the process crashes.
    process.exit(0);
  });

  updateCamera();

  // Move worldPos forward along the camera heading. The terrain samples its height field at
  // worldPos, so the terrain features come toward the camera, but the camera does not move.
  const worldPos = [0, 0, 0];
  let previousTime = performance.now();
  while (!window.destroyed) {
    const now = performance.now();
    const seconds = (now - previousTime) / 1000;
    previousTime = now;
    worldPos[0] += HEADING[0] * TERRAIN_SPEED * seconds;
    worldPos[2] += HEADING[2] * TERRAIN_SPEED * seconds;
    terrain.update([worldPos[0], worldPos[1], worldPos[2]]);
    ship.update(seconds);
    render();
    // Let Node.js process the window events between frames.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
