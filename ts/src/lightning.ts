// Lightning flashes around the edges of the screen. A random schedule (with a fixed seed, so each
// benchmark run is the same) starts a flash every few seconds. A flash has one to three quick
// pulses, and it is at a random position near the edge of the screen.
//
// The flash draws one full-screen triangle with a soft glow around the flash position. The blend
// uses the blend constant: draw() sets the blend constant from the brightness of the flash. The
// scene also gives the brightness to the clouds and the sky, so that the flash lights them.

import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';

// The time in seconds between flashes is random in this range.
const FLASH_INTERVAL = [1.5, 5.0] as const;
// Each pulse goes up at once and fades in PULSE_DECAY seconds. The pulses of a flash are up to
// PULSE_SPACING seconds apart.
const PULSE_DECAY = 0.07;
const PULSE_SPACING = 0.12;
const RANDOM_SEED = 4242;

const SHADER = /* wgsl */ `
struct Uniforms {
  // xy: the flash position in clip space. z: the width of the view divided by its height.
  values: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}

@vertex
fn vs_flash(@builtin(vertex_index) index: u32) -> VertexOutput {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(corners[index], 0.0, 1.0);
  output.clip = corners[index];
  return output;
}

// A bright glow at the flash position near the edge, and a very weak glow over the whole screen.
@fragment
fn fs_flash(input: VertexOutput) -> @location(0) vec4f {
  let offset = (input.clip - uniforms.values.xy) * vec2f(uniforms.values.z, 1.0);
  let distance2 = dot(offset, offset);
  let glow = exp(-distance2 * 3.0) * 0.7 + 0.03;
  return vec4f(vec3f(0.82, 0.86, 1.0) * glow, 0.0);
}
`;

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

export class Lightning {
  private readonly device: Device;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly pipeline: GPURenderPipeline;
  private readonly random = makeRandom(RANDOM_SEED);
  private nextFlash = 0;
  private flashStart = -Infinity;
  private pulses: number[] = [];
  private flashPosition: [number, number] = [0, 0];
  private flash = 0;

  constructor(device: Device, format: TextureFormat, depthFormat: DepthFormat) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      size: 4 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs_flash' },
      fragment: {
        module,
        entryPoint: 'fs_flash',
        targets: [
          {
            format,
            // image = glow color * blend constant + image.
            blend: {
              color: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
    });
  }

  // The brightness of the current flash, from 0 to approximately 1.
  get brightness(): number {
    return this.flash;
  }

  // The position of the current flash in clip space, near the edge of the screen.
  get position(): [number, number] {
    return this.flashPosition;
  }

  // Advance to a time in seconds. Flashes happen only when enabled is true. aspect is the width of
  // the view divided by its height.
  update(time: number, enabled: boolean, aspect: number): void {
    if (enabled && time >= this.nextFlash) {
      this.flashStart = time;
      const count = 1 + Math.floor(this.random() * 3);
      this.pulses = Array.from({ length: count }, (_, i) => i * PULSE_SPACING * (0.6 + 0.4 * this.random()));
      // A random point near the edge of the screen.
      const angle = this.random() * 2 * Math.PI;
      this.flashPosition = [Math.cos(angle) * 1.05, Math.sin(angle) * 0.95];
      this.nextFlash = time + FLASH_INTERVAL[0] + (FLASH_INTERVAL[1] - FLASH_INTERVAL[0]) * this.random();
    } else if (!enabled) {
      this.nextFlash = Math.max(this.nextFlash, time);
    }
    const sinceStart = time - this.flashStart;
    this.flash = 0;
    for (const pulse of this.pulses) {
      const t = sinceStart - pulse;
      if (t >= 0) {
        this.flash = Math.max(this.flash, Math.exp(-t / PULSE_DECAY));
      }
    }
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([this.flashPosition[0], this.flashPosition[1], aspect, 0]),
    );
  }

  draw(pass: RenderPassEncoder): void {
    if (this.flash < 0.01) {
      return;
    }
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setBlendConstant({ r: this.flash, g: this.flash, b: this.flash, a: this.flash });
    pass.draw(3);
  }
}
