// One directional light (a light source at infinity) that all objects in the scene share.
// Each object adds LIGHT_WGSL to its shader, adds the light bind group layout to its
// pipeline layout at LIGHT_BIND_GROUP, and sets the light bind group before it draws.

import gpu from '@kmamal/gpu';
import type { Device, RenderPassEncoder } from './gpu-types.js';
import type { Vec3 } from './mat4.js';

// The bind group index that each pipeline layout uses for the light.
export const LIGHT_BIND_GROUP = 1;

// Shader code that declares the light uniform and the applyLight() function.
// applyLight() gives the color of a surface with a world-space normal.
export const LIGHT_WGSL = /* wgsl */ `
struct DirectionalLight {
  // The unit vector from a surface toward the light.
  direction: vec3f,
  color: vec3f,
  ambient: vec3f,
}
@group(${LIGHT_BIND_GROUP}) @binding(0) var<uniform> light: DirectionalLight;

fn applyLight(baseColor: vec3f, worldNormal: vec3f) -> vec3f {
  let diffuse = max(dot(normalize(worldNormal), light.direction), 0.0);
  return baseColor * (light.ambient + light.color * diffuse);
}
`;

// Each vec3f in the uniform struct has a 16-byte alignment.
const DIRECTION_OFFSET = 0;
const COLOR_OFFSET = 4;
const AMBIENT_OFFSET = 8;
const UNIFORM_FLOATS = 12;

export class DirectionalLight {
  readonly bindGroupLayout;
  private readonly device: Device;
  private readonly uniformBuffer;
  private readonly bindGroup;
  private readonly values = new Float32Array(UNIFORM_FLOATS);

  constructor(device: Device, direction: Vec3, color: Vec3, ambient: Vec3) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: gpu.GPUBufferUsage.UNIFORM | gpu.GPUBufferUsage.COPY_DST,
    });
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: gpu.GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this.values.set(color, COLOR_OFFSET);
    this.values.set(ambient, AMBIENT_OFFSET);
    this.setDirection(direction);
  }

  // The direction points from a surface toward the light. It does not have to be a unit vector.
  setDirection(direction: Vec3): void {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    this.values.set(
      [direction[0] / length, direction[1] / length, direction[2] / length],
      DIRECTION_OFFSET,
    );
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.values);
  }

  bind(pass: RenderPassEncoder): void {
    pass.setBindGroup(LIGHT_BIND_GROUP, this.bindGroup);
  }
}
