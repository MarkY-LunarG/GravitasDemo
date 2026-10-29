// A square ground grid that draws as a solid surface or as a wireframe.
// All world units are meters. The grid is centered on the origin, and its height comes from
// Perlin noise and craters. The grid itself does not move. worldPos offsets the point where
// the vertex shader samples the height field, so the terrain features move across the grid.

import gpu from '@kmamal/gpu';
import type { Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { type DirectionalLight, LIGHT_WGSL } from './light.js';
import { type Mat4, type Vec3, multiply, translationScale } from './mat4.js';

export type TerrainRenderMode = 'solid' | 'wireframe';

// The length of one side of the square grid, in meters.
export const TERRAIN_EXTENT = 25000;

const GRID_POINTS = 5000;
const HALF_EXTENT = TERRAIN_EXTENT / 2;

const CELLS_PER_ROW = GRID_POINTS - 1;
// The solid terrain is one triangle strip for each row of cells. Each strip has two vertices
// for each grid point in the row. Thus the vertex shader runs only twice for each grid point.
const STRIP_VERTEX_COUNT = GRID_POINTS * 2;
// Each grid line along X and along Z is made of CELLS_PER_ROW segments of two vertices.
const WIRE_VERTEX_COUNT = 2 * GRID_POINTS * CELLS_PER_ROW * 2;

// Perlin noise (fractal Brownian motion) for the hills.
// Each octave has double the frequency and half the amplitude of the octave before it.
const NOISE_WAVELENGTH = 4000;
const NOISE_AMPLITUDE = 150;
const NOISE_OCTAVES = 6;

// The craters are in two layers: large craters that are far apart, and small craters that are
// near each other. Each layer divides the plane into square cells. A cell has one crater or no
// crater, and the crater has a random position and radius in the cell. Thus the distance between
// craters is not constant. The maximum radius must be no more than 0.5 of the cell size,
// because the shader looks only at the cell of the point and the 8 cells around it.
const LARGE_CRATER_CELL = 8000;
const LARGE_CRATER_PROBABILITY = 0.1;
const LARGE_CRATER_RADIUS = [250, 1500] as const;
const SMALL_CRATER_CELL = 800;
const SMALL_CRATER_PROBABILITY = 0.35;
const SMALL_CRATER_RADIUS = [30, 140] as const;

// The vertex shaders make the grid positions from the vertex index, so no vertex or
// index buffers are necessary. Grid coordinates are in [0, 1] and the model matrix
// moves them into world space.
const SHADER = /* wgsl */ `
${LIGHT_WGSL}
const CELLS_PER_ROW: u32 = ${CELLS_PER_ROW}u;
const GRID_POINTS: u32 = ${GRID_POINTS}u;
const TERRAIN_EXTENT: f32 = ${TERRAIN_EXTENT}.0;
const NOISE_FREQUENCY: f32 = ${1 / NOISE_WAVELENGTH};
const NOISE_AMPLITUDE: f32 = ${NOISE_AMPLITUDE}.0;
const NOISE_OCTAVES: u32 = ${NOISE_OCTAVES}u;

struct Uniforms {
  mvp: mat4x4f,
  worldPos: vec3f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) height: f32,
}

// An integer hash of a cell and a seed. Different seeds give values that are not related.
fn hash(cell: vec2i, seed: u32) -> u32 {
  var h = (bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u) ^ (seed * 0xcb1ab31fu);
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

// A random number in [0, 1).
fn random(cell: vec2i, seed: u32) -> f32 {
  return f32(hash(cell, seed) >> 8u) / 16777216.0;
}

// A random gradient with components in [-1, 1]. The two halves of the hash give the
// two components, so no trigonometric functions are necessary.
fn gradient(cell: vec2i, seed: u32) -> vec2f {
  let h = hash(cell, seed);
  return vec2f(f32(h & 0xffffu), f32(h >> 16u)) / 32767.5 - 1.0;
}

// The height functions return vec3f(height, d(height)/dx, d(height)/dz).
// The analytic derivatives give the normal without more samples of the height field.

// Perlin gradient noise with a quintic fade curve. The value is approximately in [-1, 1].
fn perlin(p: vec2f, seed: u32) -> vec3f {
  let cell = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  let ga = gradient(cell, seed);
  let gb = gradient(cell + vec2i(1, 0), seed);
  let gc = gradient(cell + vec2i(0, 1), seed);
  let gd = gradient(cell + vec2i(1, 1), seed);

  let va = dot(ga, f);
  let vb = dot(gb, f - vec2f(1.0, 0.0));
  let vc = dot(gc, f - vec2f(0.0, 1.0));
  let vd = dot(gd, f - vec2f(1.0, 1.0));

  let value = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  let gradient = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
    + du * (u.yx * (va - vb - vc + vd) + vec2f(vb, vc) - va);
  return vec3f(value, gradient);
}

fn hills(p: vec2f) -> vec3f {
  var sum = vec3f(0.0);
  var frequency = NOISE_FREQUENCY;
  var amplitude = NOISE_AMPLITUDE;
  for (var octave = 0u; octave < NOISE_OCTAVES; octave++) {
    let n = perlin(p * frequency, octave);
    sum += vec3f(n.x * amplitude, n.yz * amplitude * frequency);
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  return sum;
}

// One crater: a bowl below the ground inside the radius, and a raised rim at the radius.
fn crater(p: vec2f, center: vec2f, radius: f32) -> vec3f {
  let offset = p - center;
  let dist = length(offset);
  if (dist >= 2.0 * radius || dist < 1e-3) {
    return vec3f(0.0);
  }
  let d = dist / radius;
  let depth = 0.2 * radius;
  let rimHeight = 0.06 * radius;
  let rimWidth = 0.3;

  let rimOffset = (d - 1.0) / rimWidth;
  let rimShape = exp(-rimOffset * rimOffset);
  var height = rimHeight * rimShape;
  var slope = rimHeight * rimShape * -2.0 * (d - 1.0) / (rimWidth * rimWidth);
  if (d < 1.0) {
    height += depth * (d * d - 1.0);
    slope += depth * 2.0 * d;
  }
  // slope is d(height)/d(d). Change it to the gradient in world space.
  return vec3f(height, slope * offset / (dist * radius));
}

fn craterLayer(p: vec2f, cellSize: f32, probability: f32, minRadius: f32, maxRadius: f32,
               seed: u32) -> vec3f {
  let home = vec2i(floor(p / cellSize));
  var sum = vec3f(0.0);
  for (var dz = -1; dz <= 1; dz++) {
    for (var dx = -1; dx <= 1; dx++) {
      let cell = home + vec2i(dx, dz);
      if (random(cell, seed) >= probability) {
        continue;
      }
      let radius = mix(minRadius, maxRadius, random(cell, seed + 1u));
      let center = (vec2f(cell) + vec2f(random(cell, seed + 2u), random(cell, seed + 3u))) * cellSize;
      sum += crater(p, center, radius);
    }
  }
  return sum;
}

fn terrainHeight(p: vec2f) -> vec3f {
  return hills(p)
    + craterLayer(p, ${LARGE_CRATER_CELL}.0, ${LARGE_CRATER_PROBABILITY}, ${LARGE_CRATER_RADIUS[0]}.0,
                  ${LARGE_CRATER_RADIUS[1]}.0, 100u)
    + craterLayer(p, ${SMALL_CRATER_CELL}.0, ${SMALL_CRATER_PROBABILITY}, ${SMALL_CRATER_RADIUS[0]}.0,
                  ${SMALL_CRATER_RADIUS[1]}.0, 200u);
}

fn makeVertex(column: u32, row: u32) -> VertexOutput {
  let gridCoord = vec2f(f32(column), f32(row)) / f32(CELLS_PER_ROW);
  // The model matrix maps grid coordinates to world X and Z, and it does not scale Y.
  // Thus the height and the normal can stay in meters in world space.
  let gridWorld = (gridCoord - 0.5) * TERRAIN_EXTENT;
  let terrain = terrainHeight(gridWorld + uniforms.worldPos.xz);
  var output: VertexOutput;
  output.position = uniforms.mvp * vec4f(gridCoord.x, terrain.x, gridCoord.y, 1.0);
  output.worldNormal = normalize(vec3f(-terrain.y, 1.0, -terrain.z));
  output.height = terrain.x;
  return output;
}

// One instance for each row of cells. The strip goes along the row and alternates between the
// two grid lines at the edges of the row.
@vertex
fn vs_solid(@builtin(vertex_index) index: u32, @builtin(instance_index) row: u32) -> VertexOutput {
  return makeVertex(index / 2u, row + index % 2u);
}

@vertex
fn vs_wire(@builtin(vertex_index) index: u32) -> VertexOutput {
  let segmentsPerDirection = GRID_POINTS * CELLS_PER_ROW;
  var segment = index / 2u;
  let end = index % 2u;
  if (segment < segmentsPerDirection) {
    // Lines along X.
    return makeVertex(segment % CELLS_PER_ROW + end, segment / CELLS_PER_ROW);
  }
  // Lines along Z.
  segment -= segmentsPerDirection;
  return makeVertex(segment / CELLS_PER_ROW, segment % CELLS_PER_ROW + end);
}

@fragment
fn fs_solid(input: VertexOutput) -> @location(0) vec4f {
  // Low ground is darker than high ground.
  let shade = mix(0.3, 0.55, saturate(input.height / 400.0 + 0.5));
  return vec4f(applyLight(vec3f(shade, shade, shade), input.worldNormal), 1.0);
}

@fragment
fn fs_wire(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.0);
}
`;

export class Terrain {
  private readonly device: Device;
  private readonly light: DirectionalLight;
  private readonly uniformBuffer;
  private readonly bindGroup;
  private readonly solidPipeline;
  private readonly wirePipeline;
  private readonly modelMatrix: Mat4;
  private worldPosition: Vec3;
  private mode: TerrainRenderMode = 'solid';

  constructor(device: Device, format: TextureFormat, light: DirectionalLight) {
    this.device = device;
    this.light = light;
    this.modelMatrix = translationScale([-HALF_EXTENT, 0, -HALF_EXTENT], [TERRAIN_EXTENT, 1, TERRAIN_EXTENT]);
    this.worldPosition = [0, 0, 0];

    this.uniformBuffer = device.createBuffer({
      size: 20 * Float32Array.BYTES_PER_ELEMENT,
      usage: gpu.GPUBufferUsage.UNIFORM | gpu.GPUBufferUsage.COPY_DST,
    });

    // Both pipelines share one layout so that the same bind groups work for both.
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: gpu.GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout, light.bindGroupLayout] });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const shaderModule = device.createShaderModule({ code: SHADER });
    this.solidPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_solid' },
      fragment: { module: shaderModule, entryPoint: 'fs_solid', targets: [{ format }] },
      primitive: { topology: 'triangle-strip' },
    });
    this.wirePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_wire' },
      fragment: { module: shaderModule, entryPoint: 'fs_wire', targets: [{ format }] },
      primitive: { topology: 'line-list' },
    });
  }

  get renderMode(): TerrainRenderMode {
    return this.mode;
  }

  setRenderMode(mode: TerrainRenderMode): void {
    this.mode = mode;
  }

  // Combine the camera view-projection matrix with the terrain model matrix.
  setViewProjection(viewProjection: Mat4): void {
    this.device.queue.writeBuffer(this.uniformBuffer, 0, multiply(viewProjection, this.modelMatrix));
    this.writeWorldPosition();
  }

  // Set the point of the height field that is at the center of the grid. Only X and Z are used.
  // When worldPos moves along a direction, the terrain features move the opposite direction.
  update(currentPos: Vec3): void {
    this.worldPosition = currentPos;
    this.writeWorldPosition();
  }

  // worldPos follows the 64-byte mvp matrix in the Uniforms struct.
  private writeWorldPosition(): void {
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      16 * Float32Array.BYTES_PER_ELEMENT,
      new Float32Array(this.worldPosition),
    );
  }

  draw(pass: RenderPassEncoder): void {
    pass.setBindGroup(0, this.bindGroup);
    this.light.bind(pass);
    if (this.mode === 'wireframe') {
      pass.setPipeline(this.wirePipeline);
      pass.draw(WIRE_VERTEX_COUNT);
    } else {
      pass.setPipeline(this.solidPipeline);
      pass.draw(STRIP_VERTEX_COUNT, CELLS_PER_ROW);
    }
  }
}
