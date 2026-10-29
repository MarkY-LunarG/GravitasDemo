// The desktop target: show the scene (src/app.ts) in an SDL window with WebGPU through Google
// Dawn (@kmamal/gpu) in Node.js.
// Hold Space to run the ship engines. Press W to toggle between the solid and the wireframe
// terrain. Press ESC to exit.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import gpu from '@kmamal/gpu';
import sdl from '@kmamal/sdl';
import { App } from './app.js';
import { parseGlb } from './gltf.js';

const WIDTH = 1920;
const HEIGHT = 1080;

// The window surface format. The default format of @kmamal/gpu is rgba16float, which changes
// the brightness of the colors, so request an 8-bit format with no sRGB encoding.
const SURFACE_FORMAT = 'bgra8unorm';

// The path is relative to this file, so it is correct from src/ (tsx) and from dist/ (tsc).
const SHIP_MODEL_PATH = fileURLToPath(new URL('../lunarg-ship/lunarg_ship.glb', import.meta.url));

// The shared code uses the standard WebGPU global constants, as in a browser. @kmamal/gpu
// exports them from its module, so put them on globalThis.
Object.assign(globalThis, {
  GPUBufferUsage: gpu.GPUBufferUsage,
  GPUShaderStage: gpu.GPUShaderStage,
  GPUTextureUsage: gpu.GPUTextureUsage,
  GPUMapMode: gpu.GPUMapMode,
  GPUColorWrite: gpu.GPUColorWrite,
});

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
  const dawnDevice = await adapter.requestDevice();
  // The @kmamal/gpu types do not export GPUUncapturedErrorEvent, so get it from the module type.
  dawnDevice.addEventListener('uncapturederror', (event) => {
    console.error('WebGPU error:', (event as typeof gpu.GPUUncapturedErrorEvent).error.message);
  });

  const renderer = gpu.renderGPUDeviceToWindow({ device: dawnDevice, window, format: SURFACE_FORMAT });

  // The @kmamal/gpu typings are not compatible with @webgpu/types, but the objects implement the
  // standard API. Convert the types only here.
  const device = dawnDevice as unknown as GPUDevice;
  const shipFile = fs.readFileSync(SHIP_MODEL_PATH);
  const shipData = shipFile.buffer.slice(shipFile.byteOffset, shipFile.byteOffset + shipFile.byteLength);
  const app = new App(device, renderer.getPreferredFormat() as GPUTextureFormat, parseGlb(shipData as ArrayBuffer));

  window.on('resize', () => {
    renderer.resize();
  });

  window.on('keyDown', (event) => {
    if (event.repeat) {
      return;
    }
    if (event.key === 'escape') {
      window.destroy();
    } else if (event.key === 'w') {
      app.toggleTerrainRenderMode();
    } else if (event.key === ' ') {
      app.setEnginesOn(true);
    }
  });

  // The engines run only while Space is held down.
  window.on('keyUp', (event) => {
    if (event.key === ' ') {
      app.setEnginesOn(false);
    }
  });
  // The window does not get the key release if it is not in focus, so stop the engines.
  window.on('blur', () => {
    app.setEnginesOn(false);
  });

  window.on('close', () => {
    dawnDevice.destroy();
    // Exit now. If Node.js releases the Dawn objects in its normal shutdown,
    // Dawn fails a RefCounted assertion and the process crashes.
    process.exit(0);
  });

  let previousTime = performance.now();
  while (!window.destroyed) {
    const now = performance.now();
    const seconds = (now - previousTime) / 1000;
    previousTime = now;
    const surface = renderer.getCurrentTexture();
    app.frame(seconds, renderer.getCurrentTextureView() as unknown as GPUTextureView, surface.width, surface.height);
    renderer.swap();
    // Let Node.js process the window events between frames.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
