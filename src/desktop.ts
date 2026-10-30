// The desktop target: show the scene (src/app.ts) in an SDL window with WebGPU through Google
// Dawn (@kmamal/gpu) in Node.js.
// Press W to toggle between the solid and the wireframe terrain, N to go to the next scene, and
// ESC to exit. The intro comes first. To start at a benchmark scene with no intro, give its number
// (from 1): npm start -- --scene=2
// After the last scene, the window shows the results page. Its Exit button stops the application.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import gpu from '@kmamal/gpu';
import sdl from '@kmamal/sdl';
import { App } from './app.js';
import { parseGlb } from './gltf.js';
import { INTRO_IMAGE_FILES, type IntroImages } from './intro-logo.js';
import { decodePng } from './png.js';

const WIDTH = 1920;
const HEIGHT = 1080;

// The window surface format. The default format of @kmamal/gpu is rgba16float, which changes
// the brightness of the colors, so request an 8-bit format with no sRGB encoding.
const SURFACE_FORMAT = 'bgra8unorm';
// Mailbox presentation does not wait for the display refresh, so the frame rate of the benchmark
// is not limited to the refresh rate, and the image does not tear. If the surface does not support
// it, the renderer uses FIFO (the default of @kmamal/gpu), which waits for the display refresh.
const PRESENT_MODE = 'mailbox';

// The path is relative to this file, so it is correct from src/ (tsx) and from dist/ (tsc).
const SHIP_MODEL_PATH = fileURLToPath(new URL('../lunarg-ship/lunarg_ship.glb', import.meta.url));
const TEXTURES_DIRECTORY = fileURLToPath(new URL('../textures/', import.meta.url));

// Read and decode the images of the intro.
function loadIntroImages(): IntroImages {
  const load = (file: string) =>
    decodePng(new Uint8Array(fs.readFileSync(TEXTURES_DIRECTORY + file)), (data) => new Uint8Array(zlib.inflateSync(data)));
  return {
    colorLogo: load(INTRO_IMAGE_FILES.colorLogo),
    neon: load(INTRO_IMAGE_FILES.neon),
    neonTube: load(INTRO_IMAGE_FILES.neonTube),
  };
}

// The benchmark scene number from the --scene=<number> argument, or 0 (the intro) with no argument.
function startScene(): number {
  const argument = process.argv.find((value) => value.startsWith('--scene='));
  const number = argument ? Number(argument.slice('--scene='.length)) : 0;
  return Number.isFinite(number) && number >= 1 ? number : 0;
}

// The shared code uses the standard WebGPU global constants, as in a browser. @kmamal/gpu
// exports them from its module, so put them on globalThis.
Object.assign(globalThis, {
  GPUBufferUsage: gpu.GPUBufferUsage,
  GPUShaderStage: gpu.GPUShaderStage,
  GPUTextureUsage: gpu.GPUTextureUsage,
  GPUMapMode: gpu.GPUMapMode,
  GPUColorWrite: gpu.GPUColorWrite,
});

// The Dawn instance. Keep it at module scope, so that it lives as long as the process. The device
// and the async operations (for example mapAsync) use it, but they do not keep the GPU object
// alive in JavaScript. If the garbage collector frees the GPU object, @kmamal/gpu frees the Dawn
// instance. Then the next poll of Dawn (InstanceBase::ProcessEvents, for a pending mapAsync) uses
// freed memory, and the process crashes or hangs, usually after a minute or more.
const instance = gpu.create([]);

// Make the renderer of the window, with PRESENT_MODE if the surface supports it.
function makeRenderer(device: Parameters<typeof gpu.renderGPUDeviceToWindow>[0]['device'], window: unknown) {
  try {
    return gpu.renderGPUDeviceToWindow({ device, window, format: SURFACE_FORMAT, presentMode: PRESENT_MODE });
  } catch (error) {
    console.warn(`The ${PRESENT_MODE} present mode is not available, so the frame rate is limited to the display refresh rate:`, error);
    return gpu.renderGPUDeviceToWindow({ device, window, format: SURFACE_FORMAT });
  }
}

async function main(): Promise<void> {
  const window = sdl.video.createWindow({
    title: 'WebGPU Terrain',
    width: WIDTH,
    height: HEIGHT,
    resizable: true,
    webgpu: true,
  });

  const adapter = await instance.requestAdapter();
  if (!adapter) {
    throw new Error('No WebGPU adapter is available');
  }
  // The benchmark measures the GPU time of each frame when the adapter can write timestamps.
  const dawnDevice = await adapter.requestDevice({
    requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
  });
  // The @kmamal/gpu types do not export GPUUncapturedErrorEvent, so get it from the module type.
  dawnDevice.addEventListener('uncapturederror', (event) => {
    console.error('WebGPU error:', (event as typeof gpu.GPUUncapturedErrorEvent).error.message);
  });

  const renderer = makeRenderer(dawnDevice, window);

  // The @kmamal/gpu typings are not compatible with @webgpu/types, but the objects implement the
  // standard API. Convert the types only here.
  const device = dawnDevice as unknown as GPUDevice;
  const shipFile = fs.readFileSync(SHIP_MODEL_PATH);
  const shipData = shipFile.buffer.slice(shipFile.byteOffset, shipFile.byteOffset + shipFile.byteLength);
  const app = new App(
    device,
    renderer.getPreferredFormat() as GPUTextureFormat,
    parseGlb(shipData as ArrayBuffer),
    loadIntroImages(),
  );
  app.jumpToScene(startScene());

  window.on('resize', () => {
    renderer.resize();
  });

  window.on('keyDown', (event) => {
    if (event.repeat) {
      return;
    }
    if (event.key === 'escape') {
      console.log('Esc pressed.');
      window.destroy();
    } else if (event.key === 'w') {
      app.toggleTerrainRenderMode();
    } else if (event.key === 'n') {
      app.nextScene();
    }
  });

  // The mouse positions are in window units. The view has the size of the window in pixels, which
  // is larger on a high-density display.
  const toPixels = (x: number, y: number): [number, number] => [
    (x * window.pixelWidth) / window.width,
    (y * window.pixelHeight) / window.height,
  ];
  window.on('mouseMove', (event) => {
    app.pointerMove(...toPixels(event.x, event.y));
  });
  window.on('mouseButtonDown', (event) => {
    if (event.button === sdl.mouse.BUTTON.LEFT) {
      app.click(...toPixels(event.x, event.y));
    }
  });

  // Report why the application stops, so that an unexpected exit is easy to find.
  // The window close destroys the device, which is not an error.
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') {
      console.error(`WebGPU device lost (${info.reason}): ${info.message}`);
    }
  });
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
    process.exit(1);
  });

  // The window close event also comes while the process exits, so exit only one time.
  let exiting = false;
  const exit = (message: string): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    console.log(message);
    dawnDevice.destroy();
    // Exit now. If Node.js releases the Dawn objects in its normal shutdown,
    // Dawn fails a RefCounted assertion and the process crashes.
    process.exit(0);
  };
  window.on('close', () => exit('The window closed.'));

  let previousTime = performance.now();
  while (!window.destroyed) {
    const now = performance.now();
    const seconds = (now - previousTime) / 1000;
    previousTime = now;
    // The size of the surface texture is the size of the window in pixels.
    const view = renderer.getCurrentTextureView() as unknown as GPUTextureView;
    app.frame(seconds, view, window.pixelWidth, window.pixelHeight);
    renderer.swap();
    if (app.exitRequested) {
      exit('Exit pressed.');
    }
    // Let Node.js process the window events between frames.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
