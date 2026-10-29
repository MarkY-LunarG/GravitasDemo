// Render a flat terrain grid with WebGPU in an SDL window.
// The camera is above one corner and looks toward the center of the grid.
// Press W to toggle between the solid and the wireframe terrain. Press ESC to exit.

import gpu from '@kmamal/gpu';
import sdl from '@kmamal/sdl';
import { DirectionalLight } from './light.js';
import { lookAt, multiply, perspective, viewToWorldDirection } from './mat4.js';
import { TERRAIN_EXTENT, Terrain } from './terrain.js';

const WIDTH = 1920;
const HEIGHT = 1080;

// All world units are meters. The terrain is on the Y = 0 plane, centered on the origin.
const CAMERA_CORNER = -TERRAIN_EXTENT / 2 - 100;
const EYE_HEIGHT = 300;
const TARGET_HEIGHT = 300;
const FIELD_OF_VIEW_Y = (45 * Math.PI) / 180;
const NEAR_PLANE = 1;
const FAR_PLANE = 5000;

// The sun is a directional light. This is the sun position in view space, where the camera
// is at the origin and looks along -Z, +X is to the right, and +Y is up.
// The sun is in front of the camera, 45 degrees to the left of the view direction, and
// 45 degrees above the horizon: the height is equal to the horizontal distance, 9000 * sqrt(2).
// Only the direction to this point is important, because the sun is infinitely far away.
const SUN_VIEW_POSITION = [-9000, 9000 * Math.SQRT2, -9000] as const;
const SUN_COLOR = [1.0, 0.95, 0.85] as const;
const AMBIENT_COLOR = [0.25, 0.27, 0.32] as const;

function computeView(): Float32Array {
  return lookAt([CAMERA_CORNER, EYE_HEIGHT, CAMERA_CORNER], [0, TARGET_HEIGHT, 0], [0, 1, 0]);
}

function computeViewProjection(aspect: number): Float32Array {
  const projection = perspective(FIELD_OF_VIEW_Y, aspect, NEAR_PLANE, FAR_PLANE);
  return multiply(projection, computeView());
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

  const renderer = gpu.renderGPUDeviceToWindow({ device, window });

  // The pipelines must use the same format as the window surface.
  const surfaceFormat = renderer.getCurrentTexture().format;

  // All objects in the scene use this one light.
  const sun = new DirectionalLight(
    device,
    viewToWorldDirection(computeView(), SUN_VIEW_POSITION),
    SUN_COLOR,
    AMBIENT_COLOR,
  );
  const terrain = new Terrain(device, surfaceFormat, sun);

  const updateCamera = (): void => {
    terrain.setViewProjection(computeViewProjection(window.pixelWidth / window.pixelHeight));
  };

  const render = (): void => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: renderer.getCurrentTextureView(),
          clearValue: { r: 0.0, g: 0.0, b: 1.0, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    terrain.draw(pass);
    pass.end();
    device.queue.submit([encoder.finish()]);
    renderer.swap();
  };

  // The scene is static, so draw only when the window contents become invalid.
  window.on('expose', render);
  window.on('resize', () => {
    renderer.resize();
    updateCamera();
    render();
  });

  window.on('keyDown', (event) => {
    if (event.repeat) {
      return;
    }
    if (event.key === 'escape') {
      window.destroy();
    } else if (event.key === 'w') {
      terrain.setRenderMode(terrain.renderMode === 'solid' ? 'wireframe' : 'solid');
      render();
    }
  });

  window.on('close', () => {
    device.destroy();
    gpu.destroy(instance);
    // Exit now. If Node.js releases the Dawn objects in its normal shutdown,
    // Dawn fails a RefCounted assertion and the process crashes.
    process.exit(0);
  });

  updateCamera();
  render();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
