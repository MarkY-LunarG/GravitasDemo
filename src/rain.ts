// Rain on the camera lens: long drops (streaks) that the air pushes across the glass, small beads
// of water that the streaks leave behind them, and small still drops. The drops bend the view
// behind them, and the dry parts of the glass are misted. This is a screen effect with its own
// shader: it reads the image of the scene, and draws the image through the water. Draw it in the
// post pass of the App (Scene.drawPost).
//
// The shader makes a height field of the water on the glass. Its slope moves the point where the
// shader reads the scene image, so a drop shows a bent view, as a small lens does.
//
// The blend uses the blend constant: image = rain image * constant + image * (1 - constant).
// draw() sets the blend constant from the rain intensity, so the rain fades in and out.

import type { Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { NOISE_WGSL } from './noise.js';

// The sizes are in units of the screen height. A streak layer has SLIDE_COLUMNS columns across
// one screen height. A column has a streak with the probability SLIDE_PROBABILITY of the layer.
const SLIDE_COLUMNS = [14, 24] as const;
const SLIDE_PROBABILITY = [0.8, 0.55] as const;
// The still drops divide the glass into cells of 1 / STILL_DROP_GRID screen heights, and a cell
// has a drop with the probability STILL_DROP_PROBABILITY.
const STILL_DROP_GRID = 28;
const STILL_DROP_PROBABILITY = 0.2;
// How far a water slope of 1 (height 1 over one screen height) moves the point where the shader
// reads the image, in screen heights. The mist blurs the dry glass by up to MIST_BLUR pixels.
const REFRACTION = 0.004;
const MIST_BLUR = 3;
// The mist also makes the dry glass a little lighter, so the clear water stands out.
const MIST_LIGHT = 0.06;

const SHADER = /* wgsl */ `
${NOISE_WGSL}

struct Uniforms {
  // x: time in seconds. yz: the size of the view in pixels.
  values: vec4f,
  // xy: the unit direction on the screen in which the drops slide (+y is up).
  direction: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;

fn random3(cell: vec2i, seed: u32) -> vec3f {
  let h = hash3(vec3i(cell, 0), seed);
  return vec3f(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) / 1023.0;
}

// The small side-to-side path of a streak, as a function of the position along its cell.
fn wander(y: f32, seed: f32) -> f32 {
  return sin(y * 1.1 + seed * 6.0) * 0.1 + sin(y * 2.9 + seed * 11.0) * 0.04;
}

// One layer of streaks: drops that the air pushes across the lens. Each streak is one long drop,
// almost the same width along all of its length, and a little narrower at its back end. q is the
// position on the glass, with +y up along the slide axis, so the streaks move along -y. The
// result is the water height (x) and the wet area (y).
fn slidingLayer(q: vec2f, time: f32, columns: f32, probability: f32, seed: u32) -> vec2f {
  let cellHeight = 10.0;
  let g = q * columns;
  let column = i32(floor(g.x));
  let columnRandom = random3(vec2i(column, 0), seed);
  if (columnRandom.y >= probability) {
    return vec2f(0.0);
  }
  let shift = columnRandom.x * cellHeight;
  let y = g.y + shift;
  let home = i32(floor(y / cellHeight));
  // A streak can go past the ends of its cell, so look at the streaks of the cells before and after.
  var height = 0.0;
  for (var row = home - 1; row <= home + 1; row++) {
    let local = vec2f(fract(g.x) - 0.5, y - f32(row) * cellHeight);
    let n = random3(vec2i(column, row), seed + 1u);
    // The streak moves at a constant speed. Its front goes from the top of the cell to the bottom.
    let streakLength = 2.5 + 3.5 * n.y;
    let travel = cellHeight + streakLength;
    let front = cellHeight - fract(time * (0.25 + 0.2 * n.x) + n.z) * travel;
    // The streak stays in its column: the center and the wander keep it 0.5 from the column edges.
    let center = (n.z - 0.5) * 0.3;
    let side = local.x - (center + wander(local.y, n.x));
    let along = local.y - front;
    // The distance to the line from the front to the back of the streak. Past the ends, it is the
    // distance to the end.
    let past = max(-along, 0.0) + max(along - streakLength, 0.0);
    // A streak is a thin line of water.
    let radius = (0.045 + 0.035 * n.x) * mix(1.0, 0.6, saturate(along / streakLength));
    let d = length(vec2f(side, past)) / radius;
    // The tail fades out: the water gets thinner toward the back end, so it bends the view less.
    let tail = 1.0 - smoothstep(0.35, 1.0, saturate(along / streakLength));
    height = max(height, sqrt(saturate(1.0 - d * d)) * tail * 0.6);

    // Small beads of water that the streak leaves behind it, on its path. They get fewer and
    // smaller farther behind the streak, and some places on the path have no bead.
    let behind = along - streakLength;
    let wake = 2.5;
    if (behind > 0.0 && behind < wake) {
      let spacing = 0.35;
      let index = floor(local.y / spacing);
      let b = random3(vec2i(column * 64 + i32(index), row), seed + 2u);
      let fade = 1.0 - behind / wake;
      if (b.x < 0.8 * fade) {
        let beadCenter = vec2f(center + wander((index + 0.5) * spacing, n.x) + (b.y - 0.5) * 0.12,
                               (index + 0.5) * spacing);
        let beadRadius = (0.05 + 0.06 * b.z) * (0.5 + 0.5 * fade);
        let e = length(local - beadCenter) / beadRadius;
        height = max(height, sqrt(saturate(1.0 - e * e)) * 0.9);
      }
    }
  }
  return vec2f(height, height);
}

// Still drops that slowly come and go. grid is the number of cells across one screen
// height, and a cell has a drop with the given probability.
fn stillDrops(q: vec2f, time: f32, grid: f32, probability: f32, seed: u32) -> f32 {
  let g = q * grid;
  let cell = vec2i(floor(g));
  let n = random3(cell, seed);
  let position = (n.xy - 0.5) * 0.5;
  let d = length(fract(g) - 0.5 - position) / (0.12 + 0.22 * n.z);
  let life = fract(time * 0.05 + n.z * 7.0);
  let visible = smoothstep(0.0, 0.1, life) * smoothstep(1.0, 0.6, life) * step(1.0 - probability, n.x);
  return sqrt(saturate(1.0 - d * d)) * visible;
}

// The water height (x) and the wet area (y) at a position on the glass.
fn water(q: vec2f, time: f32) -> vec2f {
  let a = slidingLayer(q, time, ${SLIDE_COLUMNS[0]}.0, ${SLIDE_PROBABILITY[0]}, 10u);
  let b = slidingLayer(q + vec2f(0.37, 0.0), time * 1.15, ${SLIDE_COLUMNS[1]}.0, ${SLIDE_PROBABILITY[1]}, 20u);
  let still = stillDrops(q, time, ${STILL_DROP_GRID}.0, ${STILL_DROP_PROBABILITY}, 60u);
  return vec2f(max(max(a.x, b.x * 0.8), still), max(max(a.y, b.y), max(a.x, b.x)));
}

@vertex
fn vs_rain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment
fn fs_rain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let time = uniforms.values.x;
  let size = uniforms.values.yz;
  // The position on the glass in screen heights, with +y up, turned so that the drops slide
  // along -y.
  let screen = vec2f(position.x - 0.5 * size.x, 0.5 * size.y - position.y) / size.y;
  let down = uniforms.direction.xy;
  let across = vec2f(-down.y, down.x);
  let q = vec2f(dot(screen, across), -dot(screen, down));

  // The slope of the water, from two near samples, and then in screen directions (+y up).
  let e = 1.0 / size.y;
  let w = water(q, time);
  let gradient = vec2f(water(q + vec2f(e, 0.0), time).x - w.x, water(q + vec2f(0.0, e), time).x - w.x) / e;
  let slope = across * gradient.x - down * gradient.y;
  // Texture coordinates have +y down, and one unit is the width or the height of the view.
  let offset = slope * ${REFRACTION};
  let uv = position.xy / size + vec2f(offset.x * size.y / size.x, -offset.y);

  // The mist blurs the dry glass. The water and the wet trails are clear.
  let blur = ${MIST_BLUR}.0 * (1.0 - saturate(w.y * 2.0 + w.x * 3.0)) / size;
  var color = textureSampleLevel(scene, sceneSampler, uv, 0.0).rgb;
  if (blur.x > 0.0) {
    for (var i = 0u; i < 8u; i++) {
      let angle = f32(i) * 0.785398;
      color += textureSampleLevel(scene, sceneSampler, uv + vec2f(cos(angle), sin(angle)) * blur, 0.0).rgb;
    }
    color /= 9.0;
  }
  // The mist makes the dry glass lighter.
  let dry = 1.0 - saturate(w.y * 2.0 + w.x * 3.0);
  color = mix(color, vec3f(0.9, 0.85, 0.75), ${MIST_LIGHT} * dry);
  // A narrow dark rim where the water surface is steep, at the edges of the drops, and a small
  // sharp highlight where the surface turns toward the light from the upper left. Thin water, for
  // example at the fading tail of a streak, is not steep, so it has no rim.
  let rim = smoothstep(60.0, 220.0, length(slope));
  color *= 1.0 - 0.45 * rim;
  let shine = saturate(dot(slope, vec2f(-0.6, 0.8)) * 0.015);
  color += vec3f(1.0, 0.97, 0.9) * pow(shine, 8.0) * 0.35;
  return vec4f(color, 1.0);
}
`;

export class Rain {
  private readonly device: Device;
  private readonly uniformBuffer: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup | null = null;
  private sceneView: GPUTextureView | null = null;
  private intensity = 0;

  constructor(device: Device, format: TextureFormat) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      size: 8 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_rain' },
      fragment: {
        module,
        entryPoint: 'fs_rain',
        targets: [
          {
            format,
            // image = rain image * blend constant + image * (1 - blend constant).
            blend: {
              color: { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  // Set the time in seconds, the rain intensity (0 to 1), the size of the view in pixels, and the
  // screen direction in which the drops slide (+x is right and +y is up). The length of the
  // direction is not important.
  update(time: number, intensity: number, width: number, height: number, direction: [number, number]): void {
    this.intensity = Math.max(0, Math.min(1, intensity));
    const length = Math.hypot(direction[0], direction[1]) || 1;
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([time, width, height, 0, direction[0] / length, direction[1] / length, 0, 0]),
    );
  }

  // Draw the rain over the image in the pass. sceneView is the image of the scene.
  draw(pass: RenderPassEncoder, sceneView: GPUTextureView): void {
    if (this.intensity <= 0) {
      return;
    }
    if (sceneView !== this.sceneView) {
      this.sceneView = sceneView;
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: sceneView },
          { binding: 2, resource: this.sampler },
        ],
      });
    }
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    const level = this.intensity;
    pass.setBlendConstant({ r: level, g: level, b: level, a: level });
    pass.draw(3);
  }
}
