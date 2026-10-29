// Render a terrain grid with WebGPU in an SDL window.
// The camera stays above one corner and looks toward the center of the grid.
// The terrain features move toward the camera.
// Press W to toggle between the solid and the wireframe terrain. Press ESC to exit.

import gpu from '@kmamal/gpu';
import sdl from '@kmamal/sdl';
import { DirectionalLight } from './light.js';
import { lookAt, multiply, perspective, viewToWorldDirection } from './mat4.js';
import { TERRAIN_EXTENT, Terrain } from './terrain.js';

const WIDTH = 1920;
const HEIGHT = 1080;

// All world units are meters. The terrain is on the Y = 0 plane, centered on the origin.
const CAMERA_CORNER = -TERRAIN_EXTENT / 2;
const EYE_HEIGHT = 500;
// The camera looks horizontally toward the center of the terrain, then tilts down by this angle.
// At -10 degrees, the terrain fills approximately the bottom two thirds of the window.
const CAMERA_PITCH = (-10 * Math.PI) / 180;
const FIELD_OF_VIEW_Y = (45 * Math.PI) / 180;
const NEAR_PLANE = 1;
// The far plane clips the terrain at 20 km. The far corner of the terrain is farther away.
const FAR_PLANE = 20000;

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

const EYE = [CAMERA_CORNER, EYE_HEIGHT, CAMERA_CORNER] as const;
// The horizontal unit vector from the camera toward the center of the terrain.
const HEADING = [-EYE[0] / Math.hypot(EYE[0], EYE[2]), 0, -EYE[2] / Math.hypot(EYE[0], EYE[2])] as const;

// The camera heading is toward the center of the terrain. The pitch tilts it up or down.
function computeView(pitch: number): Float32Array {
  const eye = EYE;
  const forward = [HEADING[0] * Math.cos(pitch), Math.sin(pitch), HEADING[2] * Math.cos(pitch)] as const;
  return lookAt(eye, [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]], [0, 1, 0]);
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
    terrain.setViewProjection(computeViewProjection(window.pixelWidth / window.pixelHeight));
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
    }
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
    const distance = (TERRAIN_SPEED * (now - previousTime)) / 1000;
    previousTime = now;
    worldPos[0] += HEADING[0] * distance;
    worldPos[2] += HEADING[2] * distance;
    terrain.update([worldPos[0], worldPos[1], worldPos[2]]);
    render();
    // Let Node.js process the window events between frames.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
