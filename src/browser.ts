// The browser target: show the scene (src/app.ts) in a canvas with the browser WebGPU API.
// Press W to toggle between the solid and the wireframe terrain, and N to go to the next scene.
// To start at a scene, give its number (from 1) in the URL: ?scene=2
// After the last scene, the canvas shows the results page. Its Exit button stops the application.

import { App } from './app.js';
import { parseGlb } from './gltf.js';

// Vite copies the model into the build output and changes this URL to point to the copy.
const SHIP_MODEL_URL = new URL('../lunarg-ship/lunarg_ship.glb', import.meta.url);

function showError(message: string): void {
  const element = document.getElementById('error');
  if (element) {
    element.textContent = message;
    element.hidden = false;
  }
  console.error(message);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('The page has no canvas with the id "canvas"');
  }
  if (!navigator.gpu) {
    throw new Error('This browser does not support WebGPU');
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('No WebGPU adapter is available');
  }
  // The benchmark measures the GPU time of each frame when the adapter can write timestamps.
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
  });
  device.addEventListener('uncapturederror', (event) => {
    console.error('WebGPU error:', (event as GPUUncapturedErrorEvent).error.message);
  });

  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('The canvas cannot make a WebGPU context');
  }
  // The preferred format has no sRGB encoding, as the desktop target has.
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const response = await fetch(SHIP_MODEL_URL);
  if (!response.ok) {
    throw new Error(`Cannot load ${SHIP_MODEL_URL}: ${response.status} ${response.statusText}`);
  }
  const app = new App(device, format, parseGlb(await response.arrayBuffer()));
  const sceneNumber = Number(new URLSearchParams(location.search).get('scene') ?? '1');
  app.jumpToScene(Number.isFinite(sceneNumber) && sceneNumber >= 1 ? sceneNumber : 1);

  // The canvas fills the window. Its size in pixels is its CSS size times the device pixel ratio,
  // so the image is sharp on high-density displays.
  const resize = (): void => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  window.addEventListener('keydown', (event) => {
    if (event.repeat) {
      return;
    }
    if (event.key === 'w' || event.key === 'W') {
      app.toggleTerrainRenderMode();
    } else if (event.key === 'n' || event.key === 'N') {
      app.nextScene();
    }
  });

  // The pointer positions are in CSS pixels. The view has the size of the canvas in device pixels.
  const toPixels = (event: PointerEvent): [number, number] => [
    (event.offsetX * canvas.width) / canvas.clientWidth,
    (event.offsetY * canvas.height) / canvas.clientHeight,
  ];
  canvas.addEventListener('pointermove', (event) => app.pointerMove(...toPixels(event)));
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button === 0) {
      app.click(...toPixels(event));
    }
  });

  // A page can close only a window that a script opened. If the window stays open, show a message.
  const stop = (): void => {
    device.destroy();
    window.close();
    showError('The benchmark has stopped. You can close this page.');
  };

  let previousTime = performance.now();
  const frame = (now: number): void => {
    // A frame can come after a long pause, for example when the tab was hidden. Limit the time
    // step, so that the animations do not jump.
    const seconds = Math.min((now - previousTime) / 1000, 0.1);
    previousTime = now;
    app.frame(seconds, context.getCurrentTexture().createView(), canvas.width, canvas.height);
    if (app.exitRequested) {
      stop();
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
