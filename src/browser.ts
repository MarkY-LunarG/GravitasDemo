// The browser target: show the scene (src/app.ts) in a canvas with the browser WebGPU API.
// Hold Space to run the ship engines. Press W to toggle between the solid and the wireframe
// terrain.

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
  const device = await adapter.requestDevice();
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

  // The canvas fills the window. Its size in pixels is its CSS size times the device pixel ratio,
  // so the image is sharp on high-density displays.
  const resize = (): void => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  window.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      // Prevent the page scroll that Space usually causes.
      event.preventDefault();
    }
    if (event.repeat) {
      return;
    }
    if (event.key === 'w' || event.key === 'W') {
      app.toggleTerrainRenderMode();
    } else if (event.key === ' ') {
      app.setEnginesOn(true);
    }
  });
  // The engines run only while Space is held down.
  window.addEventListener('keyup', (event) => {
    if (event.key === ' ') {
      app.setEnginesOn(false);
    }
  });
  // The page does not get the key release if it is not in focus, so stop the engines.
  window.addEventListener('blur', () => {
    app.setEnginesOn(false);
  });

  let previousTime = performance.now();
  const frame = (now: number): void => {
    // A frame can come after a long pause, for example when the tab was hidden. Limit the time
    // step, so that the animations do not jump.
    const seconds = Math.min((now - previousTime) / 1000, 0.1);
    previousTime = now;
    app.frame(seconds, context.getCurrentTexture().createView(), canvas.width, canvas.height);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
