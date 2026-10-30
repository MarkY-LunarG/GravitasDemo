// The LunarG logo of the intro scene: the color logo, the neon logo, and the neon tube logo, all on
// black, which are images in textures/. One full-screen triangle draws the logo. The shader mixes
// the three images, and sets the brightness of each neon tube for the flicker.
//
// The two neon images have the same size (LOGO_SIZE), and the letters are at the same positions.
// The color logo has the same letter size, at COLOR_LOGO_OFFSET in the neon images. The page
// coordinates of the logo are the pixels of the neon images.

import type { RgbaImage } from './png.js';
import type { Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';

// The images of the intro, with 4 bytes for each pixel and no premultiplied alpha.
export interface IntroImages {
  // 2025-LunarG-Color-Logo-with-tagline.png
  readonly colorLogo: RgbaImage;
  // LunarG-Logo-Neon-Transparent.png
  readonly neon: RgbaImage;
  // LunarG-Logo-NeonTube-Transparent.png
  readonly neonTube: RgbaImage;
}

// The file names of the images in textures/.
export const INTRO_IMAGE_FILES = {
  colorLogo: '2025-LunarG-Color-Logo-with-tagline.png',
  neon: 'LunarG-Logo-Neon-Transparent.png',
  neonTube: 'LunarG-Logo-NeonTube-Transparent.png',
} as const;

const LOGO_SIZE = [1740, 902] as const;
const COLOR_LOGO_OFFSET = [120, 118] as const;
// The part of the screen that the logo can use.
const LOGO_SCREEN_FRACTION = 0.92;
// The G of the neon tube image in logo pixels: its center and its height.
export const G_CENTER = [1355, 448] as const;
export const G_HEIGHT = 282;

// The tubes that flicker. The shader finds the tube of a pixel from its logo position.
export const TUBES = ['L', 'U', 'N', 'A', 'R', 'bracket', 'G', 'dot', 'tagline'] as const;
export const TUBE_COUNT = TUBES.length;
export const G_TUBE = TUBES.indexOf('G');

// The logo state of a frame.
export interface LogoState {
  // 0: the color logo. 1: the neon logo.
  readonly colorToNeon: number;
  // 0: the neon logo. 1: the neon tube logo.
  readonly neonToTube: number;
  // A multiplier of the neon colors, for example above 1 for a brighter logo.
  readonly brightness: number;
  // A multiplier of the glow around the tubes.
  readonly panel: number;
  // The brightness of each tube (TUBES), from 0 (off) to 1 (on).
  readonly tubes: readonly number[];
  // The amount of a white flash over the whole screen.
  readonly flash: number;
}

const UNIFORM_FLOATS = 24;

const SHADER = /* wgsl */ `
struct Uniforms {
  // xy: the screen position (pixels) of the upper-left corner of the logo. z: screen pixels for
  // each logo pixel.
  placement: vec4f,
  // x: colorToNeon. y: neonToTube. z: brightness. w: panel.
  mix: vec4f,
  // The brightness of each tube.
  tubes: array<vec4f, 3>,
  // x: flash.
  effects: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var colorLogo: texture_2d<f32>;
@group(0) @binding(2) var neon: texture_2d<f32>;
@group(0) @binding(3) var neonTube: texture_2d<f32>;
@group(0) @binding(4) var linearSampler: sampler;

const LOGO_SIZE = vec2f(${LOGO_SIZE[0]}.0, ${LOGO_SIZE[1]}.0);
const COLOR_OFFSET = vec2f(${COLOR_LOGO_OFFSET[0]}.0, ${COLOR_LOGO_OFFSET[1]}.0);

@vertex
fn vs_logo(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

// The tube of a logo position (pixels of the neon images), in the order of TUBES.
fn tubeAt(p: vec2f) -> u32 {
  if (p.y > 580.0 && p.x < 900.0) {
    return 8u;
  }
  if (p.x >= 1458.0) {
    return 7u;
  }
  if (p.x >= 1245.0) {
    return 6u;
  }
  if (p.x >= 1140.0 || (p.x >= 1095.0 && (p.y < 330.0 || p.y > 590.0))) {
    return 5u;
  }
  let edges = array<f32, 4>(395.0, 583.0, 776.0, 985.0);
  for (var tube = 0u; tube < 4u; tube++) {
    if (p.x < edges[tube]) {
      return tube;
    }
  }
  return 4u;
}

// The part of a neon tube image color that is a tube (near white), not glow.
fn tubeMaskOf(color: vec3f) -> f32 {
  return smoothstep(0.35, 0.75, color.r) * smoothstep(0.5, 0.8, min(color.g, color.b));
}

fn tubeLevel(p: vec2f) -> f32 {
  let tube = tubeAt(p);
  return uniforms.tubes[tube / 4u][tube % 4u];
}

// The brightness of the glow at a logo position: the tube brightness, averaged across
// approximately 70 pixels, so the glow has no sharp edge where two tubes meet.
fn glowLevel(p: vec2f) -> f32 {
  var sum = 0.0;
  for (var i = -2; i <= 2; i++) {
    sum += tubeLevel(p + vec2f(f32(i) * 17.0, 0.0)) + tubeLevel(p + vec2f(0.0, f32(i) * 17.0));
  }
  return sum / 10.0;
}

fn sampleImage(image: texture_2d<f32>, p: vec2f, size: vec2f) -> vec4f {
  let uv = p / size;
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  let color = textureSampleLevel(image, linearSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
  return select(vec4f(0.0), color, inside);
}

@fragment
fn fs_logo(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = (position.xy - uniforms.placement.xy) / uniforms.placement.z;

  // The color logo: blue text with a transparent background, on black.
  let colorSample = sampleImage(colorLogo, p - COLOR_OFFSET, vec2f(textureDimensions(colorLogo)));
  let colorImage = colorSample.rgb * colorSample.a;

  // The neon images, on black.
  let neonSample = sampleImage(neon, p, LOGO_SIZE);
  let neonImage = neonSample.rgb * neonSample.a;
  let tubeSample = sampleImage(neonTube, p, LOGO_SIZE);
  let tubeImage = tubeSample.rgb * tubeSample.a;

  // The tubes are near white, and the glow panel is blue. Each tube has its own brightness. An
  // unlit tube is dim gray glass.
  let level = tubeLevel(p);
  let tubeMask = tubeMaskOf(tubeImage);
  let glass = vec3f(0.1, 0.13, 0.16);
  let lit = tubeImage * tubeMask * level + glass * tubeMask * (1.0 - level);
  // The glow around a tube has the brightness of the tube.
  let tubeLogo = tubeImage * (1.0 - tubeMask) * uniforms.mix.w * glowLevel(p) + lit;

  let neonLogo = mix(neonImage, tubeLogo, uniforms.mix.y) * uniforms.mix.z;
  var color = mix(colorImage, neonLogo, uniforms.mix.x);
  color = mix(color, vec3f(1.0), uniforms.effects.x);
  return vec4f(color, 1.0);
}
`;

export class IntroLogo {
  private readonly device: Device;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniforms = new Float32Array(UNIFORM_FLOATS);
  // The logo position on the screen, from the last update().
  private origin: [number, number] = [0, 0];
  private scale = 1;

  // format is the color format of the main pass. The logo does not use the depth buffer, but the
  // pipeline must match the pass.
  constructor(device: Device, format: TextureFormat, depthFormat: TextureFormat, images: IntroImages) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      size: this.uniforms.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const texture = (image: RgbaImage) => {
      const result = device.createTexture({
        size: [image.width, image.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: result }, image.data, { bytesPerRow: image.width * 4 }, [
        image.width,
        image.height,
      ]);
      return result.createView();
    };
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_logo' },
      fragment: { module, entryPoint: 'fs_logo', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: texture(images.colorLogo) },
        { binding: 2, resource: texture(images.neon) },
        { binding: 3, resource: texture(images.neonTube) },
        {
          binding: 4,
          resource: device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        },
      ],
    });
  }

  // Set the state of the frame. width and height are the size of the view in pixels.
  update(state: LogoState, width: number, height: number): void {
    this.scale = Math.min((width * LOGO_SCREEN_FRACTION) / LOGO_SIZE[0], (height * LOGO_SCREEN_FRACTION) / LOGO_SIZE[1]);
    this.origin = [(width - LOGO_SIZE[0] * this.scale) / 2, (height - LOGO_SIZE[1] * this.scale) / 2];
    this.uniforms.set([this.origin[0], this.origin[1], this.scale, 0], 0);
    this.uniforms.set([state.colorToNeon, state.neonToTube, state.brightness, state.panel], 4);
    for (let tube = 0; tube < 12; ++tube) {
      this.uniforms[8 + tube] = state.tubes[tube] ?? 0;
    }
    this.uniforms.set([state.flash, 0, 0, 0], 20);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniforms);
  }

  // The screen position in pixels of a logo position (pixels of the neon images), from the last
  // update().
  toScreen(x: number, y: number): [number, number] {
    return [this.origin[0] + x * this.scale, this.origin[1] + y * this.scale];
  }

  // The screen pixels for each logo pixel, from the last update().
  get screenScale(): number {
    return this.scale;
  }

  draw(pass: RenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }
}
