// Render frames of the TypeScript version offscreen, and write them as PNG files, for the parity
// check with the C++ version (run_parity.py). It uses @kmamal/gpu (Dawn) from ts/node_modules,
// with no window. The frames have a fixed time step of exactly 1/60 s, as the C++ version has with
// --fixed-step=0.016666666666666666.
//
// Usage (from ts/, so that tsx is found): npx tsx ../scripts/parity/ts_reference.mts
//     <scene> <frame,frame,...> <output directory> <width> <height>
// Scene 0 starts with the intro. Scene n (from 1) starts at benchmark scene n, as --scene=n does.
// Each frame is written to <output directory>/ts_<frame>.png.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import gpu from '../../ts/node_modules/@kmamal/gpu/src/index.js';
import { App } from '../../ts/src/app.ts';
import { parseGlb } from '../../ts/src/gltf.ts';
import { INTRO_IMAGE_FILES } from '../../ts/src/intro-logo.ts';
import { decodePng } from '../../ts/src/png.ts';

const [sceneArgument, frameList, outDir, widthArgument, heightArgument] = process.argv.slice(2);
const frames = frameList.split(',').map(Number);
const width = Number(widthArgument);
const height = Number(heightArgument);
const assets = fileURLToPath(new URL('../../assets/', import.meta.url));

// The shared code uses the standard WebGPU global constants, as desktop.ts does.
Object.assign(globalThis, {
  GPUBufferUsage: gpu.GPUBufferUsage,
  GPUShaderStage: gpu.GPUShaderStage,
  GPUTextureUsage: gpu.GPUTextureUsage,
  GPUMapMode: gpu.GPUMapMode,
  GPUColorWrite: gpu.GPUColorWrite,
});
// The Dawn instance must live as long as the process (see desktop.ts). If the garbage collector
// frees it, a later poll of Dawn uses freed memory, and the process crashes. A module constant
// that no later code reads is not enough, so keep a reference on globalThis.
const instance = gpu.create([]);
Object.assign(globalThis, { dawnInstance: instance });
const adapter = await instance.requestAdapter();
const device = await adapter.requestDevice({
  requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
});
device.addEventListener('uncapturederror', (event) => console.error('WebGPU error:', event.error.message));

// The ship model and the intro images, decoded as the desktop target decodes them.
const ship = fs.readFileSync(assets + 'lunarg-ship/lunarg_ship.glb');
const loadImage = (name: string) =>
  decodePng(new Uint8Array(fs.readFileSync(assets + 'textures/' + name)), (data) => new Uint8Array(zlib.inflateSync(data)));
const app = new App(device, 'bgra8unorm', parseGlb(ship.buffer.slice(ship.byteOffset, ship.byteOffset + ship.byteLength)), {
  colorLogo: loadImage(INTRO_IMAGE_FILES.colorLogo),
  neon: loadImage(INTRO_IMAGE_FILES.neon),
  neonTube: loadImage(INTRO_IMAGE_FILES.neonTube),
});
app.jumpToScene(Number(sceneArgument));

const texture = device.createTexture({
  size: [width, height],
  format: 'bgra8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
const view = texture.createView();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Copy the texture to a buffer, and write it as an RGB PNG file.
async function save(path: string): Promise<void> {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const source = new Uint8Array(buffer.getMappedRange());
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = y * bytesPerRow + x * 4;
      const d = y * (width * 3 + 1) + 1 + x * 3;
      raw[d] = source[s + 2];
      raw[d + 1] = source[s + 1];
      raw[d + 2] = source[s];
    }
  }
  buffer.unmap();
  buffer.destroy();
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  fs.writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const last = Math.max(...frames);
for (let frame = 1; frame <= last; frame++) {
  app.frame(1 / 60, view, width, height);
  if (frames.includes(frame)) {
    await save(`${outDir}/ts_${frame}.png`);
  }
}
device.destroy();
process.exit(0);
