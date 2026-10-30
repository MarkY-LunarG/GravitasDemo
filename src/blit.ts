// Copy a texture to the render target of a pass with one full-screen triangle. The texture and the
// target must have the same size. The pass has no depth buffer.

import type { Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';

const SHADER = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;

@vertex
fn vs_blit(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment
fn fs_blit(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureLoad(source, vec2i(position.xy), 0);
}
`;

export class Blit {
  private readonly device: Device;
  private readonly pipeline: GPURenderPipeline;
  // The bind group of the last source. It changes only when the source changes.
  private bindGroup: GPUBindGroup | null = null;
  private source: GPUTextureView | null = null;

  constructor(device: Device, format: TextureFormat) {
    this.device = device;
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_blit' },
      fragment: { module, entryPoint: 'fs_blit', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  draw(pass: RenderPassEncoder, source: GPUTextureView): void {
    if (source !== this.source) {
      this.source = source;
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source }],
      });
    }
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }
}
