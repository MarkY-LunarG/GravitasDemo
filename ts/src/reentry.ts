// The fire and the smoke of the re-entry: a large fire around the ship, and smoke that the fire
// leaves behind it. The level (0 to 1) sets the strength of both. All world units are meters.
//
// The fire is one quad along the flow. It turns around its axis to face the camera. Its shader
// makes turbulent flames that start just in front of the nose, wrap around the front of the ship,
// and trail back, wider and wider. The flames are white and yellow in the hot middle and near the
// front, and orange at the ragged edges, where tongues of flame lick out. The ship hides the parts
// of the fire behind it, so the fire shows around the outline of the ship. The fire adds light
// (additive blending).
//
// The smoke is a set of soft sprites that the CPU makes behind the flame. Each puff moves back,
// grows, and fades. The CPU sorts the puffs from far to near, and they draw with premultiplied
// alpha blending before the flame.

import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import type { Mat4, Vec3 } from './mat4.js';
import { NOISE_WGSL } from './noise.js';

// The fire starts FLAME_AHEAD meters in front of the ship center (the nose is approximately 27
// meters in front of the center), and it is FLAME_LENGTH meters long and up to FLAME_WIDTH meters
// wide. Its front is round: the radius grows from 0 to FIRE_RADIUS over FIRE_FRONT meters. Then the
// radius grows by FIRE_GROWTH for each meter. FIRE_RADIUS is approximately 13 meters more than the
// half height of the ship.
const FLAME_AHEAD = 32;
const FLAME_LENGTH = 340;
const FLAME_WIDTH = 220;
const FLAME_BRIGHTNESS = 1.2;
const FIRE_RADIUS = 38;
const FIRE_FRONT = 22;
const FIRE_GROWTH = 0.17;
// The flame noise moves back at this speed, in flame lengths per second.
const FLAME_FLOW = 0.6;

// The smoke puffs. A puff starts SMOKE_START meters behind the ship center, with a random offset,
// and moves back at SMOKE_SPEED. It lives SMOKE_LIFE seconds, and its radius grows from
// SMOKE_RADIUS[0] to SMOKE_RADIUS[1]. At full level, SMOKE_RATE puffs start each second.
const SMOKE_COUNT = 160;
const SMOKE_RATE = 40;
const SMOKE_LIFE = 3.5;
const SMOKE_START = [70, 150] as const;
const SMOKE_SPEED = 140;
const SMOKE_RADIUS = [22, 95] as const;
const SMOKE_OPACITY = 0.6;
const RANDOM_SEED = 31337;

const FLAME_SHADER = /* wgsl */ `
${NOISE_WGSL}

struct Uniforms {
  viewProjection: mat4x4f,
  camera: vec4f,
  // xyz: the start of the flame. w: its length.
  start: vec4f,
  // xyz: the unit direction of the flow (from the front of the ship to its back). w: the width.
  back: vec4f,
  // x: the level (0 to 1). y: the time in seconds.
  params: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  // x: from 0 at the start of the flame to 1 at its end. y: -1 to 1 across the flame.
  @location(0) uv: vec2f,
}

@vertex
fn vs_flame(@builtin(vertex_index) vertex: u32) -> VertexOutput {
  var corners = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
  let back = uniforms.back.xyz;
  let center = uniforms.start.xyz + back * uniforms.start.w * 0.5;
  let side = normalize(cross(back, normalize(uniforms.camera.xyz - center)));
  let world = uniforms.start.xyz + back * uniforms.start.w * corner.x + side * uniforms.back.w * 0.5 * corner.y;
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(world, 1.0);
  output.uv = corner;
  return output;
}

// The color of the fire for a heat from 0 to 1: orange, yellow, and white.
fn fireColor(heat: f32) -> vec3f {
  var color = mix(vec3f(1.0, 0.38, 0.06), vec3f(1.0, 0.68, 0.18), saturate(heat * 2.5));
  color = mix(color, vec3f(1.0, 0.9, 0.45), saturate(heat * 2.5 - 1.0));
  return mix(color, vec3f(1.0, 0.98, 0.9), saturate(heat * 3.0 - 1.8));
}

@fragment
fn fs_flame(input: VertexOutput) -> @location(0) vec4f {
  let u = input.uv.x;
  let v = input.uv.y;
  let level = uniforms.params.x;
  let time = uniforms.params.y;
  let flow = time * ${FLAME_FLOW};

  // The position in meters: x from the start of the fire, and y across it.
  let x = u * uniforms.start.w;
  let y = v * uniforms.back.w * 0.5;

  // The radius of the fire: a round front, and then slowly wider.
  let frontRadius = ${FIRE_RADIUS}.0 * sqrt(saturate(x / ${FIRE_FRONT}.0));
  let radius = max(frontRadius + max(x - ${FIRE_FRONT}.0, 0.0) * ${FIRE_GROWTH}, 1.0);

  // Turbulent noise that flows back. The warp bends the flames, and the fine noise makes tongues of
  // flame at the edges.
  let p = vec3f(x * 0.018 - flow * 5.0, y * 0.035, time * 0.4);
  let warp = perlin3(p * 0.7, 950u);
  let noise = perlin3(p + vec3f(warp * 1.8, warp * 1.2, 0.0), 951u) * 0.6
    + perlin3(p * 2.3 + vec3f(0.0, 0.0, time * 0.8), 952u) * 0.3
    + perlin3(p * 5.0 + vec3f(warp, 0.0, 0.0), 953u) * 0.2;
  let inside = 1.0 - abs(y) / radius;
  let flames = saturate((inside + noise * 1.1 - 0.05) * 1.4);

  // Hotter near the front of the ship and in the middle.
  let front = 1.0 - smoothstep(0.0, 150.0, x);
  let fade = 1.0 - smoothstep(0.5, 1.0, u);
  let heat = saturate(flames * (0.55 + 0.6 * front + 0.3 * saturate(inside))) * fade * level;
  return vec4f(fireColor(heat) * heat * ${FLAME_BRIGHTNESS}, 0.0);
}
`;

const SMOKE_SHADER = /* wgsl */ `
${NOISE_WGSL}

struct Uniforms {
  viewProjection: mat4x4f,
  camera: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct Puff {
  center: vec3f,
  radius: f32,
  opacity: f32,
  // 0 when the puff starts, and 1 at the end of its life.
  age: f32,
  seed: f32,
  unused: f32,
}
// Sorted from far to near.
@group(0) @binding(1) var<storage, read> puffs: array<Puff>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
  @location(1) @interpolate(flat) opacity: f32,
  @location(2) @interpolate(flat) age: f32,
  @location(3) @interpolate(flat) seed: f32,
}

@vertex
fn vs_smoke(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let puff = puffs[instance];
  let corner = corners[vertex];
  let forward = normalize(puff.center - uniforms.camera.xyz);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  var output: VertexOutput;
  let world = puff.center + (right * corner.x + up * corner.y) * puff.radius;
  output.position = uniforms.viewProjection * vec4f(world, 1.0);
  output.corner = corner;
  output.opacity = puff.opacity;
  output.age = puff.age;
  output.seed = puff.seed;
  return output;
}

// A soft, uneven puff. A young puff is near the fire, so the fire lights it orange.
@fragment
fn fs_smoke(input: VertexOutput) -> @location(0) vec4f {
  let r2 = dot(input.corner, input.corner);
  if (r2 >= 1.0) {
    discard;
  }
  let p = vec3f(input.corner * 1.7, input.seed + input.age * 1.5);
  let noise = perlin3(p, 960u) + 0.5 * perlin3(p * 2.1, 961u);
  let density = saturate((noise * 0.7 + 0.55) * (1.0 - r2) * (1.0 - r2) * 1.6);
  let alpha = density * input.opacity;
  let glow = (1.0 - smoothstep(0.0, 0.35, input.age)) * 0.6;
  let color = mix(vec3f(0.17, 0.14, 0.12), vec3f(0.85, 0.35, 0.08), glow);
  return vec4f(color * alpha, alpha);
}
`;

interface Puff {
  position: [number, number, number];
  velocity: Vec3;
  age: number;
  seed: number;
}

// A small random number generator (mulberry32) with a fixed seed.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Premultiplied alpha blending for the smoke, and additive blending for the flame.
const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};
const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

export class Reentry {
  private readonly device: Device;
  private readonly random = makeRandom(RANDOM_SEED);
  private readonly puffs: Puff[] = [];
  private readonly flameUniforms: GPUBuffer;
  private readonly smokeUniforms: GPUBuffer;
  private readonly puffBuffer: GPUBuffer;
  private readonly flamePipeline: GPURenderPipeline;
  private readonly smokePipeline: GPURenderPipeline;
  private readonly flameBindGroup: GPUBindGroup;
  private readonly smokeBindGroup: GPUBindGroup;
  private readonly puffData = new Float32Array(SMOKE_COUNT * 8);
  private puffCount = 0;
  private level = 0;
  // The fraction of a puff that is due to start. A puff starts when it is 1 or more.
  private emission = 0;

  constructor(device: Device, format: TextureFormat, depthFormat: DepthFormat) {
    this.device = device;
    const depthStencil: GPUDepthStencilState = {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: 'less',
    };
    const makePipeline = (code: string, entry: string, blend: GPUBlendState) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: `vs_${entry}` },
        fragment: { module, entryPoint: `fs_${entry}`, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
        depthStencil,
      });
    };
    this.flamePipeline = makePipeline(FLAME_SHADER, 'flame', ADDITIVE);
    this.smokePipeline = makePipeline(SMOKE_SHADER, 'smoke', PREMULTIPLIED);

    // viewProjection (16 floats), camera (4), start (4), back (4), and params (4).
    this.flameUniforms = device.createBuffer({ size: 32 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // viewProjection (16 floats) and camera (4).
    this.smokeUniforms = device.createBuffer({ size: 20 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.puffBuffer = device.createBuffer({
      size: this.puffData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.flameBindGroup = device.createBindGroup({
      layout: this.flamePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.flameUniforms } }],
    });
    this.smokeBindGroup = device.createBindGroup({
      layout: this.smokePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.smokeUniforms } },
        { binding: 1, resource: { buffer: this.puffBuffer } },
      ],
    });
  }

  // Advance the fire and the smoke by a time step in seconds. level (0 to 1) is the strength of the
  // fire and of the new smoke. shipCenter and heading are the center and the front direction of the
  // ship. time is in seconds, for the motion of the flame.
  update(
    seconds: number,
    time: number,
    level: number,
    shipCenter: Vec3,
    heading: Vec3,
    viewProjection: Mat4,
    cameraPosition: Vec3,
  ): void {
    this.level = Math.max(0, Math.min(1, level));
    const back: Vec3 = [-heading[0], -heading[1], -heading[2]];
    const start = [0, 1, 2].map((i) => shipCenter[i] - back[i] * FLAME_AHEAD);
    const flameData = new Float32Array(32);
    flameData.set(viewProjection, 0);
    flameData.set([...cameraPosition, 0], 16);
    flameData.set([...start, FLAME_LENGTH], 20);
    flameData.set([...back, FLAME_WIDTH], 24);
    flameData.set([this.level, time, 0, 0], 28);
    this.device.queue.writeBuffer(this.flameUniforms, 0, flameData);

    // Move the puffs, remove the old puffs, and start new puffs behind the flame.
    for (const puff of this.puffs) {
      puff.age += seconds / SMOKE_LIFE;
      for (let i = 0; i < 3; ++i) {
        puff.position[i] += puff.velocity[i] * seconds;
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; --i) {
      if (this.puffs[i].age >= 1) {
        this.puffs.splice(i, 1);
      }
    }
    this.emission += SMOKE_RATE * this.level * seconds;
    const right: Vec3 = [-heading[2], 0, heading[0]];
    while (this.emission >= 1 && this.puffs.length < SMOKE_COUNT) {
      this.emission -= 1;
      const distance = SMOKE_START[0] + (SMOKE_START[1] - SMOKE_START[0]) * this.random();
      const across = (this.random() * 2 - 1) * 25;
      const up = (this.random() * 2 - 1) * 20;
      const position: [number, number, number] = [
        shipCenter[0] + back[0] * distance + right[0] * across,
        shipCenter[1] + up,
        shipCenter[2] + back[2] * distance + right[2] * across,
      ];
      const spread = () => (this.random() * 2 - 1) * 12;
      const velocity: Vec3 = [
        back[0] * SMOKE_SPEED + spread(),
        6 + spread() * 0.5,
        back[2] * SMOKE_SPEED + spread(),
      ];
      this.puffs.push({ position, velocity, age: 0, seed: this.random() * 100 });
    }
    this.emission = Math.min(this.emission, 1);

    // Sort from far to near, and write the puffs.
    const distance = (p: readonly number[]) =>
      Math.hypot(p[0] - cameraPosition[0], p[1] - cameraPosition[1], p[2] - cameraPosition[2]);
    const sorted = [...this.puffs].sort((a, b) => distance(b.position) - distance(a.position));
    sorted.forEach((puff, i) => {
      const radius = SMOKE_RADIUS[0] + (SMOKE_RADIUS[1] - SMOKE_RADIUS[0]) * Math.sqrt(puff.age);
      // The puff comes in quickly and goes out slowly.
      const opacity = SMOKE_OPACITY * Math.min(1, puff.age * 8) * (1 - puff.age);
      this.puffData.set([...puff.position, radius, opacity, puff.age, puff.seed, 0], i * 8);
    });
    this.puffCount = sorted.length;
    if (sorted.length > 0) {
      this.device.queue.writeBuffer(this.puffBuffer, 0, this.puffData, 0, sorted.length * 8);
    }
    const smokeData = new Float32Array(20);
    smokeData.set(viewProjection, 0);
    smokeData.set([...cameraPosition, 0], 16);
    this.device.queue.writeBuffer(this.smokeUniforms, 0, smokeData);
  }

  // Draw the smoke, and then the flame. Draw them after the ship, so that the ship hides the parts
  // behind it.
  draw(pass: RenderPassEncoder): void {
    if (this.puffCount > 0) {
      pass.setPipeline(this.smokePipeline);
      pass.setBindGroup(0, this.smokeBindGroup);
      pass.draw(6, this.puffCount);
    }
    if (this.level > 0.001) {
      pass.setPipeline(this.flamePipeline);
      pass.setBindGroup(0, this.flameBindGroup);
      pass.draw(6);
    }
  }
}
