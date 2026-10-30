// A bloom filter: bright parts of the scene image spread light around them.
//
// render() runs between the main pass and the post pass (Scene.afterMainPass):
//
// 1. The prefilter pass keeps the part of each pixel that is brighter than the threshold, at half
//    the size of the view.
// 2. LEVELS - 1 passes make a chain of smaller images, each half the size of the previous one. Each
//    pass averages 16 pixels with 4 bilinear samples, so the chain is a wide blur.
// 3. Upsample passes add each small image (with a 3 x 3 tent filter) to the next larger image, from
//    the smallest to the half-size image. The sum has a sharp glow near bright parts and a wide,
//    weak glow farther away.
//
// draw() adds the half-size image to the output in the post pass (Scene.drawPost).

import type { Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';

// The number of images in the chain. The smallest is 1/64 of the size of the view.
const LEVELS = 6;
// The format of the chain: 16-bit floats, so that the sums can be larger than 1.
const CHAIN_FORMAT: GPUTextureFormat = 'rgba16float';

const SHADER = /* wgsl */ `
struct Uniforms {
  // x: the threshold (0 to 1). y: the width of the soft knee above the threshold. z: the intensity
  // of the bloom in the output.
  values: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

struct Output {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_full(@builtin(vertex_index) index: u32) -> Output {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: Output;
  output.position = vec4f(corners[index], 0.0, 1.0);
  output.uv = vec2f(corners[index].x * 0.5 + 0.5, 0.5 - corners[index].y * 0.5);
  return output;
}

// The average of 4 x 4 source pixels around uv: 4 bilinear samples between pixels.
fn box4(uv: vec2f) -> vec3f {
  let texel = 1.0 / vec2f(textureDimensions(source));
  var sum = vec3f(0.0);
  sum += textureSampleLevel(source, linearSampler, uv + texel * vec2f(-1.0, -1.0), 0.0).rgb;
  sum += textureSampleLevel(source, linearSampler, uv + texel * vec2f(1.0, -1.0), 0.0).rgb;
  sum += textureSampleLevel(source, linearSampler, uv + texel * vec2f(-1.0, 1.0), 0.0).rgb;
  sum += textureSampleLevel(source, linearSampler, uv + texel * vec2f(1.0, 1.0), 0.0).rgb;
  return sum * 0.25;
}

@fragment
fn fs_prefilter(input: Output) -> @location(0) vec4f {
  let color = box4(input.uv);
  // A soft threshold: the part of the brightness above the threshold, with a smooth knee.
  let brightness = max(color.r, max(color.g, color.b));
  let threshold = uniforms.values.x;
  let knee = max(uniforms.values.y, 1e-4);
  let soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
  let amount = max(soft * soft / (4.0 * knee), brightness - threshold) / max(brightness, 1e-4);
  return vec4f(color * max(amount, 0.0), 1.0);
}

@fragment
fn fs_down(input: Output) -> @location(0) vec4f {
  return vec4f(box4(input.uv), 1.0);
}

// A 3 x 3 tent filter of the smaller image, which the blend adds to the larger image.
@fragment
fn fs_up(input: Output) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(source));
  var sum = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let weight = f32((2 - abs(x)) * (2 - abs(y)));
      sum += textureSampleLevel(source, linearSampler, input.uv + texel * vec2f(f32(x), f32(y)), 0.0).rgb * weight;
    }
  }
  return vec4f(sum / 16.0, 1.0);
}

@fragment
fn fs_composite(input: Output) -> @location(0) vec4f {
  let bloom = textureSampleLevel(source, linearSampler, input.uv, 0.0).rgb;
  return vec4f(bloom * uniforms.values.z, 0.0);
}
`;

const ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

export class Bloom {
  private readonly device: Device;
  private readonly uniformBuffer: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly prefilterPipeline: GPURenderPipeline;
  private readonly downPipeline: GPURenderPipeline;
  private readonly upPipeline: GPURenderPipeline;
  private readonly compositePipeline: GPURenderPipeline;
  // The chain, for the current size and scene image.
  private chain: {
    width: number;
    height: number;
    sceneView: GPUTextureView;
    textures: GPUTexture[];
    views: GPUTextureView[];
    // The bind group that reads the scene image, and one for each image of the chain.
    sceneBindGroup: GPUBindGroup;
    bindGroups: GPUBindGroup[];
  } | null = null;
  private intensity = 0;

  // format is the format of the scene image and of the output.
  constructor(device: Device, format: TextureFormat) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      size: 4 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const module = device.createShaderModule({ code: SHADER });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = (entryPoint: string, targetFormat: GPUTextureFormat, blend?: GPUBlendState) =>
      device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_full' },
        fragment: { module, entryPoint, targets: [{ format: targetFormat, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    this.prefilterPipeline = pipeline('fs_prefilter', CHAIN_FORMAT);
    this.downPipeline = pipeline('fs_down', CHAIN_FORMAT);
    this.upPipeline = pipeline('fs_up', CHAIN_FORMAT, ADD);
    this.compositePipeline = pipeline('fs_composite', format, ADD);
  }

  // Make the bloom image from sceneView. width and height are the size of the scene image. Only
  // the part above threshold (0 to 1) blooms. intensity is the brightness of the bloom in draw().
  render(
    encoder: GPUCommandEncoder,
    sceneView: GPUTextureView,
    width: number,
    height: number,
    threshold: number,
    intensity: number,
  ): void {
    this.intensity = intensity;
    if (intensity <= 0) {
      return;
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([threshold, 0.1, intensity, 0]));
    const chain = this.chainFor(sceneView, width, height);
    const pass = (view: GPUTextureView, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup, load: boolean) => {
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
      });
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.draw(3);
      renderPass.end();
    };
    pass(chain.views[0], this.prefilterPipeline, chain.sceneBindGroup, false);
    for (let level = 1; level < LEVELS; ++level) {
      pass(chain.views[level], this.downPipeline, chain.bindGroups[level - 1], false);
    }
    for (let level = LEVELS - 1; level > 0; --level) {
      pass(chain.views[level - 1], this.upPipeline, chain.bindGroups[level], true);
    }
  }

  // Add the bloom to the image of the pass (the post pass).
  draw(pass: RenderPassEncoder): void {
    if (this.intensity <= 0 || !this.chain) {
      return;
    }
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, this.chain.bindGroups[0]);
    pass.draw(3);
  }

  // The chain for the size and the scene image. A new size or scene image makes a new chain.
  private chainFor(sceneView: GPUTextureView, width: number, height: number) {
    if (this.chain && this.chain.width === width && this.chain.height === height && this.chain.sceneView === sceneView) {
      return this.chain;
    }
    for (const texture of this.chain?.textures ?? []) {
      texture.destroy();
    }
    const textures: GPUTexture[] = [];
    const views: GPUTextureView[] = [];
    for (let level = 0; level < LEVELS; ++level) {
      const texture = this.device.createTexture({
        size: [Math.max(1, width >> (level + 1)), Math.max(1, height >> (level + 1))],
        format: CHAIN_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      textures.push(texture);
      views.push(texture.createView());
    }
    const bindGroup = (view: GPUTextureView) =>
      this.device.createBindGroup({
        layout: this.prefilterPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: view },
          { binding: 2, resource: this.sampler },
        ],
      });
    this.chain = {
      width,
      height,
      sceneView,
      textures,
      views,
      sceneBindGroup: bindGroup(sceneView),
      bindGroups: views.map(bindGroup),
    };
    return this.chain;
  }
}
