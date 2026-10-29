// A flat square ground grid that draws as a solid surface or as a wireframe.
// All world units are meters. The grid is on the Y = 0 plane, centered on the origin.

import gpu from '@kmamal/gpu';
import type { Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { type Mat4, multiply, translationScale } from './mat4.js';

export type TerrainRenderMode = 'solid' | 'wireframe';

// The length of one side of the square grid, in meters.
export const TERRAIN_EXTENT = 10000;

const GRID_POINTS = 5000;
const HALF_EXTENT = TERRAIN_EXTENT / 2;

const CELLS_PER_ROW = GRID_POINTS - 1;
// Two triangles (six vertices) for each grid cell.
const SOLID_VERTEX_COUNT = CELLS_PER_ROW * CELLS_PER_ROW * 6;
// Each grid line along X and along Z is made of CELLS_PER_ROW segments of two vertices.
const WIRE_VERTEX_COUNT = 2 * GRID_POINTS * CELLS_PER_ROW * 2;

// The vertex shaders make the grid positions from the vertex index, so no vertex or
// index buffers are necessary. Grid coordinates are in [0, 1] and the model matrix
// moves them into world space.
const SHADER = /* wgsl */ `
const CELLS_PER_ROW: u32 = ${CELLS_PER_ROW}u;
const GRID_POINTS: u32 = ${GRID_POINTS}u;

struct Uniforms {
  mvp: mat4x4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) gridCoord: vec2f,
}

fn makeVertex(column: u32, row: u32) -> VertexOutput {
  let gridCoord = vec2f(f32(column), f32(row)) / f32(CELLS_PER_ROW);
  var output: VertexOutput;
  output.position = uniforms.mvp * vec4f(gridCoord.x, 0.0, gridCoord.y, 1.0);
  output.gridCoord = gridCoord;
  return output;
}

@vertex
fn vs_solid(@builtin(vertex_index) index: u32) -> VertexOutput {
  var cornerOffsets = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u),
  );
  let cell = index / 6u;
  let corner = cornerOffsets[index % 6u];
  return makeVertex(cell % CELLS_PER_ROW + corner.x, cell / CELLS_PER_ROW + corner.y);
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
  // A 100 m checkerboard makes the perspective of the flat surface visible.
  let checker = vec2u(floor(input.gridCoord * 10.0));
  let shade = select(0.35, 0.5, (checker.x + checker.y) % 2u == 0u);
  return vec4f(0.1, shade, 0.1, 1.0);
}

@fragment
fn fs_wire(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.0);
}
`;

export class Terrain {
  private readonly device: Device;
  private readonly uniformBuffer;
  private readonly bindGroup;
  private readonly solidPipeline;
  private readonly wirePipeline;
  private readonly modelMatrix: Mat4;
  private mode: TerrainRenderMode = 'solid';

  constructor(device: Device, format: TextureFormat) {
    this.device = device;
    this.modelMatrix = translationScale([-HALF_EXTENT, 0, -HALF_EXTENT], [TERRAIN_EXTENT, 1, TERRAIN_EXTENT]);

    this.uniformBuffer = device.createBuffer({
      size: 16 * Float32Array.BYTES_PER_ELEMENT,
      usage: gpu.GPUBufferUsage.UNIFORM | gpu.GPUBufferUsage.COPY_DST,
    });

    // Both pipelines share one layout so that one bind group works for both.
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: gpu.GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const shaderModule = device.createShaderModule({ code: SHADER });
    this.solidPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_solid' },
      fragment: { module: shaderModule, entryPoint: 'fs_solid', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
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
  }

  draw(pass: RenderPassEncoder): void {
    pass.setBindGroup(0, this.bindGroup);
    if (this.mode === 'wireframe') {
      pass.setPipeline(this.wirePipeline);
      pass.draw(WIRE_VERTEX_COUNT);
    } else {
      pass.setPipeline(this.solidPipeline);
      pass.draw(SOLID_VERTEX_COUNT);
    }
  }
}
