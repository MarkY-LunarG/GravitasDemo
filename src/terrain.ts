// A ground grid that draws as a solid surface or as a wireframe.
// All world units are meters. The height of the ground comes from Perlin noise and craters.
//
// The grid is a sector of rings around the point below the camera, and it covers the view of the
// camera. The columns are at equal angles, and the radius of each row is GRID_RING_RATIO times the
// radius of the row before it. Thus a cell has approximately the same size on the screen at all
// distances: near cells are small and far cells are large. The grid is correct only for a camera
// at the grid center that looks approximately along the grid heading. When the camera moves,
// call setGridCenter() again.
//
// The grid itself does not move. worldPos offsets the point where the vertex shader samples the
// height field, so the terrain features move across the grid.

import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { type DirectionalLight, LIGHT_WGSL } from './light.js';
import type { Mat4, Vec3 } from './mat4.js';

export type TerrainRenderMode = 'solid' | 'wireframe';

// The look of the terrain. Low ground has lowColor and high ground has highColor, and slopes are a
// little darker. heightScale multiplies the height of the hills and craters, and craterScale
// multiplies the depth of the craters (0 for no craters).
export interface TerrainStyle {
  readonly lowColor: Vec3;
  readonly highColor: Vec3;
  readonly heightScale: number;
  readonly craterScale: number;
}

// Gray ground with the full height.
export const DEFAULT_TERRAIN_STYLE: TerrainStyle = {
  lowColor: [0.3, 0.3, 0.3],
  highColor: [0.55, 0.55, 0.55],
  heightScale: 1,
  craterScale: 1,
};

// The distance from the grid center to the last ring, in meters.
export const TERRAIN_RADIUS = 20000;
// The distance from the grid center to the first ring. Hills near the camera can hide the ground
// below them, so the first ring is nearer than the bottom edge of the view.
const GRID_NEAR = 100;
// The grid covers GRID_HALF_ANGLE to each side of the heading. The horizontal field of view of
// a 45-degree vertical field of view at 16:9 is approximately 36 degrees to each side.
const GRID_HALF_ANGLE = (50 * Math.PI) / 180;
// Approximately 2.7 pixels for each column at 1920 x 1080 with a 45-degree vertical field of view.
const GRID_COLUMNS = 900;
const GRID_ROWS = 600;
const GRID_RING_RATIO = (TERRAIN_RADIUS / GRID_NEAR) ** (1 / (GRID_ROWS - 1));

// The solid terrain is an indexed triangle list. The GPU keeps recent vertex shader results,
// so it runs the vertex shader approximately once for each grid point.
// The rows draw from the camera outward, so near terrain usually draws first. Then the depth test
// prevents the fragment shader from running for far terrain that near terrain hides.
const SOLID_INDEX_COUNT = (GRID_ROWS - 1) * (GRID_COLUMNS - 1) * 6;
// Each ring has GRID_COLUMNS - 1 segments, and each column line has GRID_ROWS - 1 segments.
const WIRE_VERTEX_COUNT = 2 * (GRID_ROWS * (GRID_COLUMNS - 1) + GRID_COLUMNS * (GRID_ROWS - 1));

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
const LARGE_CRATER_CELL = 2000;
const LARGE_CRATER_PROBABILITY = 0.1;
const LARGE_CRATER_RADIUS = [500, 1000] as const;
const SMALL_CRATER_CELL = 800;
const SMALL_CRATER_PROBABILITY = 0.35;
const SMALL_CRATER_RADIUS = [30, 140] as const;

// Cast shadows. The vertex shader sends a ray from each grid point toward the sun, and
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
// The fragment shader interpolates the result between the grid points.
// The ray stops when it is higher than all terrain. This is an approximate upper limit:
// the noise is at most 2 * NOISE_AMPLITUDE and a crater rim is at most 0.06 * radius.
const MAX_TERRAIN_HEIGHT = 2 * NOISE_AMPLITUDE + 0.06 * LARGE_CRATER_RADIUS[1];

// The vertex shaders make the grid positions from the vertex index, so no vertex buffers are
// necessary.
const SHADER = /* wgsl */ `
${LIGHT_WGSL}
const GRID_COLUMNS: u32 = ${GRID_COLUMNS}u;
const GRID_ROWS: u32 = ${GRID_ROWS}u;
const GRID_NEAR: f32 = ${GRID_NEAR}.0;
const GRID_HALF_ANGLE: f32 = ${GRID_HALF_ANGLE};
const GRID_RING_RATIO: f32 = ${GRID_RING_RATIO};
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
  viewProjection: mat4x4f,
  worldPos: vec3f,
  // The angle of the grid heading from +Z toward +X.
  gridYaw: f32,
  // The world X and Z of the grid center.
  gridCenter: vec2f,
  // The colors of low and high ground (TerrainStyle).
  lowColor: vec4f,
  highColor: vec4f,
  // x: the scale of the height. y: the scale of the craters.
  style: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) height: f32,
  @location(2) sunVisibility: f32,
}

// The weight of a feature of a given size on a grid with a given cell size. Features smaller than
// approximately 4 cells fade out, and features smaller than 2 cells are removed. Without this, far
// features that are smaller than a cell would flicker as the terrain moves.
fn detail(featureSize: f32, cellSize: f32) -> f32 {
  return saturate(featureSize / cellSize * 0.5 - 1.0);
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

fn hills(p: vec2f, octaves: u32, cellSize: f32) -> vec3f {
  var sum = vec3f(0.0);
  var frequency = NOISE_FREQUENCY;
  var amplitude = NOISE_AMPLITUDE;
  for (var octave = 0u; octave < octaves; octave++) {
    let weight = detail(1.0 / frequency, cellSize);
    // The octaves after this one are smaller, so they also have a weight of 0.
    if (weight <= 0.0) {
      break;
    }
    let n = perlin(p * frequency, octave) * weight;
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
               seed: u32, gridCellSize: f32) -> vec3f {
  if (detail(2.0 * maxRadius, gridCellSize) <= 0.0) {
    return vec3f(0.0);
  }
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
      sum += crater(p, center, radius) * detail(2.0 * radius, gridCellSize);
    }
  }
  return sum;
}

// cellSize is the size of a grid cell at p. Features that are small relative to it fade out.
fn terrainHeight(p: vec2f, octaves: u32, cellSize: f32) -> vec3f {
  let craterScale = uniforms.style.y;
  var height = hills(p, octaves, cellSize);
  if (craterScale > 0.0) {
    height += (craterLayer(p, ${LARGE_CRATER_CELL}.0, ${LARGE_CRATER_PROBABILITY}, ${LARGE_CRATER_RADIUS[0]}.0,
                           ${LARGE_CRATER_RADIUS[1]}.0, 100u, cellSize)
      + craterLayer(p, ${SMALL_CRATER_CELL}.0, ${SMALL_CRATER_PROBABILITY}, ${SMALL_CRATER_RADIUS[0]}.0,
                    ${SMALL_CRATER_RADIUS[1]}.0, 200u, cellSize)) * craterScale;
  }
  return height;
}

// The fraction of the sun that a surface point can see, from 0 to 1.
// Where the terrain is above the ray toward the sun, the point is in shadow. Where the terrain is
// a short distance below the ray, the point is in the soft edge of a shadow.
fn sunVisibility(sampleXZ: vec2f, cellSize: f32) -> f32 {
  // The ray starts on the same simplified surface that it tests against. A small offset above
  // that surface prevents the surface from shadowing itself.
  let startHeight = scaledHeight(sampleXZ, SHADOW_OCTAVES, cellSize).x;
  let origin = vec3f(sampleXZ.x, startHeight + 0.5, sampleXZ.y);
  var visibility = 1.0;
  var t = SHADOW_FIRST_STEP;
  for (var i = 0u; i < SHADOW_STEPS; i++) {
    let ray = origin + light.direction * t;
    if (ray.y > MAX_TERRAIN_HEIGHT) {
      break;
    }
    let clearance = ray.y - scaledHeight(ray.xz, SHADOW_OCTAVES, cellSize).x;
    visibility = min(visibility, SHADOW_SOFTNESS * clearance / t);
    if (visibility <= 0.0) {
      return 0.0;
    }
    t *= SHADOW_STEP_GROWTH;
  }
  return visibility;
}

// The wireframe does not use the light, so it does not need the shadow ray.
fn makeVertex(column: u32, row: u32, withShadow: bool) -> VertexOutput {
  let radius = GRID_NEAR * pow(GRID_RING_RATIO, f32(row));
  // The distance to the next ring. It is larger than the distance to the next column.
  let cellSize = radius * (GRID_RING_RATIO - 1.0);
  let angle = uniforms.gridYaw + (f32(column) / f32(GRID_COLUMNS - 1u) * 2.0 - 1.0) * GRID_HALF_ANGLE;
  let gridXZ = uniforms.gridCenter + radius * vec2f(sin(angle), cos(angle));
  let sampleXZ = gridXZ + uniforms.worldPos.xz;
  let terrain = scaledHeight(sampleXZ, NOISE_OCTAVES, cellSize);
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(gridXZ.x, terrain.x, gridXZ.y, 1.0);
  output.worldNormal = normalize(vec3f(-terrain.y, 1.0, -terrain.z));
  output.height = terrain.x;
  // A surface that faces away from the sun gets only ambient light, so it needs no shadow ray.
  output.sunVisibility = 0.0;
  if (withShadow && dot(output.worldNormal, light.direction) > 0.0) {
    output.sunVisibility = sunVisibility(sampleXZ, cellSize);
  }
  return output;
}

// The index buffer gives the vertex index of each triangle corner: row * GRID_COLUMNS + column.
@vertex
fn vs_solid(@builtin(vertex_index) index: u32) -> VertexOutput {
  return makeVertex(index % GRID_COLUMNS, index / GRID_COLUMNS, true);
}

@vertex
fn vs_wire(@builtin(vertex_index) index: u32) -> VertexOutput {
  let ringSegments = GRID_ROWS * (GRID_COLUMNS - 1u);
  var segment = index / 2u;
  let end = index % 2u;
  if (segment < ringSegments) {
    // Lines along the rings.
    return makeVertex(segment % (GRID_COLUMNS - 1u) + end, segment / (GRID_COLUMNS - 1u), false);
  }
  // Lines from the center outward.
  segment -= ringSegments;
  return makeVertex(segment / (GRID_ROWS - 1u), segment % (GRID_ROWS - 1u) + end, false);
}

// The height and its slope with the height scale of the style. The scale also changes the slope.
fn scaledHeight(p: vec2f, octaves: u32, cellSize: f32) -> vec3f {
  return terrainHeight(p, octaves, cellSize) * uniforms.style.x;
}

@fragment
fn fs_solid(input: VertexOutput) -> @location(0) vec4f {
  // Low ground has the low color, high ground has the high color, and slopes are a little darker.
  let height = saturate(input.height / (400.0 * max(uniforms.style.x, 0.01)) + 0.5);
  let normal = normalize(input.worldNormal);
  let base = mix(uniforms.lowColor.rgb, uniforms.highColor.rgb, height) * (0.75 + 0.25 * normal.y);
  return vec4f(applyShadowedLight(base, normal, input.sunVisibility), 1.0);
}

@fragment
fn fs_wire(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.0);
}
`;

// The float offsets in the Uniforms struct: viewProjection (16 floats), worldPos (3), gridYaw (1),
// and gridCenter (2). The struct size is a multiple of 16 bytes.
const WORLD_POS_OFFSET = 16;
const GRID_YAW_OFFSET = 19;
// lowColor (4 floats), highColor (4), and style (4) follow gridCenter.
const STYLE_OFFSET = 24;
const UNIFORM_FLOATS = 36;

export class Terrain {
  private readonly device: Device;
  private readonly light: DirectionalLight;
  private readonly uniformBuffer;
  private readonly bindGroup;
  private readonly solidPipeline;
  private readonly wirePipeline;
  private readonly indexBuffer;
  private worldPosition: Vec3;
  private mode: TerrainRenderMode = 'solid';

  constructor(device: Device, format: TextureFormat, depthFormat: DepthFormat, light: DirectionalLight) {
    this.device = device;
    this.light = light;
    this.worldPosition = [0, 0, 0];

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Two triangles for each grid cell. The rows go from the camera outward.
    const indices = new Uint32Array(SOLID_INDEX_COUNT);
    let next = 0;
    for (let row = 0; row < GRID_ROWS - 1; ++row) {
      for (let column = 0; column < GRID_COLUMNS - 1; ++column) {
        const near = row * GRID_COLUMNS + column;
        const far = near + GRID_COLUMNS;
        indices.set([near, near + 1, far, far, near + 1, far + 1], next);
        next += 6;
      }
    }
    this.indexBuffer = device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, indices);

    // Both pipelines share one layout so that the same bind groups work for both.
    const bindGroupLayout = device.createBindGroupLayout({
      // The fragment shader reads the colors of the style.
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
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
      primitive: { topology: 'triangle-list' },
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

  // The grid vertices are in world space, so the terrain needs no model matrix.
  // Set the colors and the height scale of the terrain.
  setStyle(style: TerrainStyle): void {
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      STYLE_OFFSET * Float32Array.BYTES_PER_ELEMENT,
      new Float32Array([...style.lowColor, 0, ...style.highColor, 0, style.heightScale, style.craterScale, 0, 0]),
    );
  }

  setViewProjection(viewProjection: Mat4): void {
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProjection);
  }

  // Put the grid center below the camera, and turn the grid to the horizontal camera heading.
  // Only X and Z of position and heading are used. Call this each time the camera moves.
  setGridCenter(position: Vec3, heading: Vec3): void {
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      GRID_YAW_OFFSET * Float32Array.BYTES_PER_ELEMENT,
      new Float32Array([Math.atan2(heading[0], heading[2]), position[0], position[2]]),
    );
  }

  // Set the point of the height field that is at the center of the grid. Only X and Z are used.
  // When worldPos moves along a direction, the terrain features move the opposite direction.
  update(currentPos: Vec3): void {
    this.worldPosition = currentPos;
    this.writeWorldPosition();
  }

  private writeWorldPosition(): void {
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      WORLD_POS_OFFSET * Float32Array.BYTES_PER_ELEMENT,
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
      pass.setIndexBuffer(this.indexBuffer, 'uint32');
      pass.drawIndexed(SOLID_INDEX_COUNT);
    }
  }
}
