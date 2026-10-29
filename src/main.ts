// Render a flat terrain grid with WebGPU in an SDL window.
// The camera is above one corner and looks toward the center of the grid.
// Press W to toggle between the solid and the wireframe terrain. Press ESC to exit.

import gpu from '@kmamal/gpu';
import sdl from '@kmamal/sdl';
import { lookAt, multiply, perspective } from './mat4.js';
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

function computeViewProjection(aspect: number): Float32Array {
  const view = lookAt([CAMERA_CORNER, EYE_HEIGHT, CAMERA_CORNER], [0, TARGET_HEIGHT, 0], [0, 1, 0]);
  const projection = perspective(FIELD_OF_VIEW_Y, aspect, NEAR_PLANE, FAR_PLANE);
  return multiply(projection, view);
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

  const terrain = new Terrain(device, surfaceFormat);

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
