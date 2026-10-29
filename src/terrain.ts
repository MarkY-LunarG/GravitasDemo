// A square ground grid that draws as a solid surface or as a wireframe.
// All world units are meters. The grid is centered on the origin, and its height comes from
// Perlin noise and craters. The grid itself does not move. worldPos offsets the point where
// the vertex shader samples the height field, so the terrain features move across the grid.

import gpu from '@kmamal/gpu';
import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
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
//
// The depth test gives the correct result in all draw orders. The rows draw from the camera
// corner (-X -Z) outward, so near terrain usually draws first. Then the GPU can skip the
// fragment shader (and its shadow ray) for far terrain that near terrain hides.
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
// craters is not constant. A crater has an effect to 2 * radius from its center. The maximum
// radius must be no more than 0.25 of the cell size, because the shader looks only at the
// 2 x 2 cells nearest to the point.
const LARGE_CRATER_CELL = 8000;
const LARGE_CRATER_PROBABILITY = 0.1;
const LARGE_CRATER_RADIUS = [250, 1500] as const;
const SMALL_CRATER_CELL = 800;
const SMALL_CRATER_PROBABILITY = 0.35;
const SMALL_CRATER_RADIUS = [30, 140] as const;

// Cast shadows. The fragment shader sends a ray from the surface toward the sun, and
// samples the height field at steps along the ray. Each step is SHADOW_STEP_GROWTH times
// longer than the step before it, so near steps are short and far steps are long.
// SHADOW_SOFTNESS sets the width of the soft edge: larger values give sharper shadows.
// The shadow rays use only the first SHADOW_OCTAVES of the noise, because the small octaves
// cost much time and have almost no effect on the shadows.
const SHADOW_STEPS = 18;
const SHADOW_FIRST_STEP = 4;
const SHADOW_STEP_GROWTH = 1.35;
const SHADOW_SOFTNESS = 16;
const SHADOW_OCTAVES = 3;
// The ray stops when it is higher than all terrain. This is an approximate upper limit:
// the noise is at most 2 * NOISE_AMPLITUDE and a crater rim is at most 0.06 * radius.
const MAX_TERRAIN_HEIGHT = 2 * NOISE_AMPLITUDE + 0.06 * LARGE_CRATER_RADIUS[1];

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
const SHADOW_STEPS: u32 = ${SHADOW_STEPS}u;
const SHADOW_OCTAVES: u32 = ${SHADOW_OCTAVES}u;
const SHADOW_FIRST_STEP: f32 = ${SHADOW_FIRST_STEP}.0;
const SHADOW_STEP_GROWTH: f32 = ${SHADOW_STEP_GROWTH};
const SHADOW_SOFTNESS: f32 = ${SHADOW_SOFTNESS}.0;
const MAX_TERRAIN_HEIGHT: f32 = ${MAX_TERRAIN_HEIGHT};

struct Uniforms {
  mvp: mat4x4f,
  worldPos: vec3f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) height: f32,
  // The position in the height field, which includes worldPos.
  @location(2) sampleXZ: vec2f,
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

fn hills(p: vec2f, octaves: u32) -> vec3f {
  var sum = vec3f(0.0);
  var frequency = NOISE_FREQUENCY;
  var amplitude = NOISE_AMPLITUDE;
  for (var octave = 0u; octave < octaves; octave++) {
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
  // The 2 x 2 block of cells whose centers are nearest to p.
  let first = vec2i(floor(p / cellSize - 0.5));
  var sum = vec3f(0.0);
  for (var dz = 0; dz <= 1; dz++) {
    for (var dx = 0; dx <= 1; dx++) {
      let cell = first + vec2i(dx, dz);
      // One hash gives four random values of 8 bits: the chance of a crater, the radius,
      // and the position of the center in the cell.
      let h = hash(cell, seed);
      let values = vec4f(vec4u(h, h >> 8u, h >> 16u, h >> 24u) & vec4u(0xffu)) / 256.0;
      if (values.x >= probability) {
        continue;
      }
      let radius = mix(minRadius, maxRadius, values.y);
      let center = (vec2f(cell) + values.zw) * cellSize;
      sum += crater(p, center, radius);
    }
  }
  return sum;
}

fn terrainHeight(p: vec2f, octaves: u32) -> vec3f {
  return hills(p, octaves)
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
  let sampleXZ = gridWorld + uniforms.worldPos.xz;
  let terrain = terrainHeight(sampleXZ, NOISE_OCTAVES);
  var output: VertexOutput;
  output.position = uniforms.mvp * vec4f(gridCoord.x, terrain.x, gridCoord.y, 1.0);
  output.worldNormal = normalize(vec3f(-terrain.y, 1.0, -terrain.z));
  output.height = terrain.x;
  output.sampleXZ = sampleXZ;
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

// The fraction of the sun that a surface point can see, from 0 to 1.
// Where the terrain is above the ray toward the sun, the point is in shadow. Where the terrain is
// a short distance below the ray, the point is in the soft edge of a shadow.
fn sunVisibility(sampleXZ: vec2f) -> f32 {
  // The ray starts on the same simplified surface that it tests against. A small offset above
  // that surface prevents the surface from shadowing itself.
  let startHeight = terrainHeight(sampleXZ, SHADOW_OCTAVES).x;
  let origin = vec3f(sampleXZ.x, startHeight + 0.5, sampleXZ.y);
  var visibility = 1.0;
  var t = SHADOW_FIRST_STEP;
  for (var i = 0u; i < SHADOW_STEPS; i++) {
    let ray = origin + light.direction * t;
    if (ray.y > MAX_TERRAIN_HEIGHT) {
      break;
    }
    let clearance = ray.y - terrainHeight(ray.xz, SHADOW_OCTAVES).x;
    visibility = min(visibility, SHADOW_SOFTNESS * clearance / t);
    if (visibility <= 0.0) {
      return 0.0;
    }
    t *= SHADOW_STEP_GROWTH;
  }
  return visibility;
}

@fragment
fn fs_solid(input: VertexOutput) -> @location(0) vec4f {
  // Low ground is darker than high ground.
  let shade = mix(0.3, 0.55, saturate(input.height / 400.0 + 0.5));
  // A surface that faces away from the sun gets only ambient light, so it needs no shadow ray.
  var visibility = 0.0;
  if (dot(input.worldNormal, light.direction) > 0.0) {
    visibility = sunVisibility(input.sampleXZ);
  }
  return vec4f(applyShadowedLight(vec3f(shade, shade, shade), input.worldNormal, visibility), 1.0);
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

  constructor(device: Device, format: TextureFormat, depthFormat: DepthFormat, light: DirectionalLight) {
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
    const depthStencil = { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' } as const;
    this.solidPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_solid' },
      fragment: { module: shaderModule, entryPoint: 'fs_solid', targets: [{ format }] },
      primitive: { topology: 'triangle-strip' },
      depthStencil,
    });
    this.wirePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_wire' },
      fragment: { module: shaderModule, entryPoint: 'fs_wire', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil,
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
