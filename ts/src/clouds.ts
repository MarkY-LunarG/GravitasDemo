// Clouds that move past the ship toward the camera. Each cloud is a soft sprite that faces the
// camera, with a noise shape. The clouds are blended over the scene, so the ship flies through
// them.
//
// Blended sprites must draw from far to near. The CPU sorts the clouds by distance in each frame
// and writes them to a storage buffer in that order. The draw is one instanced
// drawIndexedIndirect call. The indirect buffer holds the instance count, which the cloud density
// sets. All world units are meters.

import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { type DirectionalLight, LIGHT_WGSL } from './light.js';
import type { Mat4, Vec3 } from './mat4.js';
import { NOISE_WGSL } from './noise.js';

const CLOUD_COUNT = 160;
// The clouds move in a box around the ship, as the asteroids do. The axes are right, up, and the
// heading, in meters from the ship center. A cloud that leaves the near end comes back at the far
// end. FAR_FADE is the distance at the far end where the clouds fade in.
const BOX_RIGHT = [-900, 900] as const;
const BOX_UP = [-260, 260] as const;
const BOX_HEADING = [-320, 3200] as const;
const FAR_FADE = 700;
const CLOUD_RADIUS = [70, 230] as const;
const CLOUD_SPEED = 650;
const CLOUD_OPACITY = 0.85;
const RANDOM_SEED = 7202610;

// The center (3 floats) and radius, and then the seed, opacity, and 2 unused floats.
const CLOUD_FLOATS = 8;
// viewProjection (16 floats), camera position (4), and flash (4).
const UNIFORM_FLOATS = 24;

const SHADER = /* wgsl */ `
${LIGHT_WGSL}
${NOISE_WGSL}

struct Cloud {
  center: vec3f,
  radius: f32,
  seed: f32,
  opacity: f32,
}

struct Uniforms {
  viewProjection: mat4x4f,
  camera: vec4f,
  // x: the brightness of a lightning flash. yz: its position in clip space. w: the width of the
  // view divided by its height.
  flash: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
// Sorted from far to near.
@group(0) @binding(1) var<storage, read> clouds: array<Cloud>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
  @location(1) @interpolate(flat) seed: f32,
  @location(2) @interpolate(flat) opacity: f32,
  @location(3) clip: vec2f,
}

// The index buffer has the 6 corners of a quad. The vertex index (0 to 3) selects the corner.
@vertex
fn vs_cloud(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let cloud = clouds[instance];
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u)) * 2.0 - 1.0;
  // The quad faces the camera.
  let forward = normalize(cloud.center - uniforms.camera.xyz);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let world = cloud.center + (right * corner.x + up * corner.y) * cloud.radius;
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(world, 1.0);
  output.clip = output.position.xy / output.position.w;
  output.corner = corner;
  output.seed = cloud.seed;
  output.opacity = cloud.opacity;
  return output;
}

// A soft round shape with noise at its edges. The top of the cloud is lit and the bottom is in
// shade. The color has the yellow-brown of the atmosphere. Lightning makes the clouds bright.
@fragment
fn fs_cloud(input: VertexOutput) -> @location(0) vec4f {
  let r2 = dot(input.corner, input.corner);
  if (r2 >= 1.0) {
    discard;
  }
  let p = vec3f(input.corner * 1.6, input.seed);
  let noise = perlin3(p, 800u) + 0.5 * perlin3(p * 2.1, 801u) + 0.25 * perlin3(p * 4.3, 802u);
  let falloff = (1.0 - r2) * (1.0 - r2);
  let density = saturate((noise * 0.8 + 0.55) * falloff * 1.8);
  let alpha = density * input.opacity;
  let lit = 0.55 + 0.45 * saturate(input.corner.y * 0.6 + 0.5);
  var color = vec3f(0.82, 0.68, 0.46) * lit * light.color;
  // Lightning lights the clouds near the flash position, and a little everywhere.
  let flashOffset = (input.clip - uniforms.flash.yz) * vec2f(uniforms.flash.w, 1.0);
  let flash = uniforms.flash.x * (0.06 + 0.55 * exp(-dot(flashOffset, flashOffset) * 2.0));
  color += vec3f(0.8, 0.82, 1.0) * flash * (0.6 + 0.4 * noise);
  // Premultiplied alpha.
  return vec4f(color * alpha, alpha);
}
`;

interface CloudState {
  // In box coordinates: right, up, and heading.
  local: [number, number, number];
  radius: number;
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

export class Clouds {
  private readonly device: Device;
  private readonly light: DirectionalLight;
  private readonly shipCenter: Vec3;
  private readonly basis: { right: Vec3; up: Vec3; heading: Vec3 };
  private readonly clouds: CloudState[] = [];
  private readonly uniformBuffer: GPUBuffer;
  private readonly cloudBuffer: GPUBuffer;
  private readonly indexBuffer: GPUBuffer;
  private readonly indirectBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly pipeline: GPURenderPipeline;
  private readonly cloudData = new Float32Array(CLOUD_COUNT * CLOUD_FLOATS);
  private readonly uniformData = new Float32Array(UNIFORM_FLOATS);
  private visibleCount = 0;

  constructor(
    device: Device,
    format: TextureFormat,
    depthFormat: DepthFormat,
    light: DirectionalLight,
    shipCenter: Vec3,
    heading: Vec3,
  ) {
    this.device = device;
    this.light = light;
    this.shipCenter = shipCenter;
    this.basis = { right: [-heading[2], 0, heading[0]], up: [0, 1, 0], heading };

    const random = makeRandom(RANDOM_SEED);
    const between = (range: readonly [number, number]) => range[0] + (range[1] - range[0]) * random();
    for (let i = 0; i < CLOUD_COUNT; ++i) {
      this.clouds.push({
        local: [between(BOX_RIGHT), between(BOX_UP), between(BOX_HEADING)],
        radius: between(CLOUD_RADIUS),
        seed: random() * 100,
      });
    }

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cloudBuffer = device.createBuffer({
      size: this.cloudData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
    this.indexBuffer = device.createBuffer({
      size: 12,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, indices);
    // indexCount, instanceCount, firstIndex, baseVertex, and firstInstance. update() sets the
    // instance count.
    this.indirectBuffer = device.createBuffer({
      size: 5 * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });

    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.cloudBuffer } },
      ],
    });
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, light.bindGroupLayout] }),
      vertex: { module, entryPoint: 'vs_cloud' },
      fragment: {
        module,
        entryPoint: 'fs_cloud',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      // The ship hides the clouds behind it. The clouds do not write depth, so they do not hide
      // each other.
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });
  }

  // Move the clouds by a time step in seconds, and write the visible clouds from far to near.
  // density (0 to 1) sets how many clouds there are. flash is the brightness of lightning, and
  // flashPosition is its position in clip space. aspect is the width of the view divided by its
  // height.
  update(
    seconds: number,
    density: number,
    flash: number,
    flashPosition: [number, number],
    aspect: number,
    viewProjection: Mat4,
    cameraPosition: Vec3,
  ): void {
    const { right, up, heading } = this.basis;
    const length = BOX_HEADING[1] - BOX_HEADING[0];
    const visible: { center: number[]; distance: number; cloud: CloudState; opacity: number }[] = [];
    const activeCount = Math.round(CLOUD_COUNT * Math.max(0, Math.min(1, density)));
    this.clouds.forEach((cloud, index) => {
      cloud.local[2] -= CLOUD_SPEED * seconds;
      if (cloud.local[2] < BOX_HEADING[0]) {
        cloud.local[2] += length;
      }
      if (index >= activeCount) {
        return;
      }
      const [x, y, z] = cloud.local;
      const center = [0, 1, 2].map((i) => this.shipCenter[i] + right[i] * x + up[i] * y + heading[i] * z);
      const distance = Math.hypot(
        center[0] - cameraPosition[0],
        center[1] - cameraPosition[1],
        center[2] - cameraPosition[2],
      );
      // Fade in at the far end. Fade out as the cloud comes to the camera, so that the camera
      // goes through it smoothly.
      const farFade = Math.min(1, (BOX_HEADING[1] - z) / FAR_FADE);
      const nearFade = Math.min(1, Math.max(0, (distance - cloud.radius * 0.3) / cloud.radius));
      const opacity = CLOUD_OPACITY * farFade * nearFade * Math.min(1, density * 1.5);
      if (opacity > 0.01) {
        visible.push({ center, distance, cloud, opacity });
      }
    });
    visible.sort((a, b) => b.distance - a.distance);
    visible.forEach(({ center, cloud, opacity }, i) => {
      this.cloudData.set([center[0], center[1], center[2], cloud.radius, cloud.seed, opacity, 0, 0], i * CLOUD_FLOATS);
    });
    this.visibleCount = visible.length;
    if (visible.length > 0) {
      this.device.queue.writeBuffer(this.cloudBuffer, 0, this.cloudData, 0, visible.length * CLOUD_FLOATS);
    }
    this.device.queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([6, visible.length, 0, 0, 0]));

    this.uniformData.set(viewProjection, 0);
    this.uniformData.set([...cameraPosition, 0], 16);
    this.uniformData.set([flash, flashPosition[0], flashPosition[1], aspect], 20);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  draw(pass: RenderPassEncoder): void {
    if (this.visibleCount === 0) {
      return;
    }
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    this.light.bind(pass);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
    pass.drawIndexedIndirect(this.indirectBuffer, 0);
  }
}
