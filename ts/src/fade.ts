// A fade to black for the transitions between scenes. It draws one triangle that covers the
// whole view, and blends black over the image. An amount of 0 changes nothing, and an amount of
// 1 makes the image fully black.

import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';

const SHADER = /* wgsl */ `
@group(0) @binding(0) var<uniform> amount: vec4f;

// One triangle that is larger than the view, so it covers all of the view.
@vertex
fn vs_fade(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment
fn fs_fade() -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, amount.x);
}
`;

export class Fade {
  private readonly device: Device;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly pipeline: GPURenderPipeline;

  constructor(device: Device, format: TextureFormat, depthFormat: DepthFormat) {
    this.device = device;
    // A vec4f, because a uniform buffer binding must be at least 16 bytes.
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
      vertex: { module, entryPoint: 'vs_fade' },
      fragment: {
        module,
        entryPoint: 'fs_fade',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      // The pass has a depth buffer, so the pipeline must have a depth state. The fade covers all
      // surfaces, so it ignores the depth.
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
    });
  }

  // Draw the fade last in the pass. An amount of 0 or less draws nothing.
  draw(pass: RenderPassEncoder, amount: number): void {
    if (amount <= 0) {
      return;
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([Math.min(amount, 1), 0, 0, 0]));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }
}
