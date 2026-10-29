// The LunarG ship: a glTF model with engine flames that ignite, run, and shut down.
// All world units are meters. In the model, +Y is up and +Z is the front of the ship.
//
// Solid parts use the shared sun. The flames are unlit: they use their vertex colors and
// additive blending, as lunarg-ship/viewer.html does. The flames do not light other objects.

import gpu from '@kmamal/gpu';
import { type GltfAnimation, type GltfModel, type GltfPrimitive, sampleChannel } from './gltf.js';
import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { type DirectionalLight, LIGHT_WGSL } from './light.js';
import { type Mat4, type Quat, type Vec3, compose, multiply, transformPoint } from './mat4.js';

// The animation names and the flame root node name, from lunarg-ship/README.md.
const IGNITE_ANIMATION = 'EnginesIgnite';
const RUNNING_ANIMATION = 'EnginesRunning';
const SHUTDOWN_ANIMATION = 'EnginesShutdown';
const FLAME_ROOT_NODE = 'EngineL_Flames';

// The flame colors are multiplied by this value. The viewer uses HDR colors and bloom to make
// the flames glow. This renderer has no HDR, so a smaller value keeps more of the color.
const FLAME_BRIGHTNESS = 1.5;
// A mesh with a world scale smaller than this is not drawn. The flames have a scale of 0.0001
// when the engines are off.
const MIN_DRAW_SCALE = 0.001;

// Morph target positions are offsets from the base positions. A primitive can have at most
// MAX_MORPH_TARGETS targets. Primitives with fewer targets use zero offsets.
const MAX_MORPH_TARGETS = 2;

const SHADER = /* wgsl */ `
${LIGHT_WGSL}
const FLAME_BRIGHTNESS: f32 = ${FLAME_BRIGHTNESS};

struct DrawUniforms {
  mvp: mat4x4f,
  model: mat4x4f,
  baseColor: vec4f,
  morphWeights: vec4f,
}
@group(0) @binding(0) var<uniform> draw: DrawUniforms;

struct LitOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
}

// The model matrix has only rotation, translation, and uniform scale, so it can also
// transform the normals.
@vertex
fn vs_lit(@location(0) position: vec3f, @location(1) normal: vec3f) -> LitOutput {
  var output: LitOutput;
  output.position = draw.mvp * vec4f(position, 1.0);
  output.worldNormal = (draw.model * vec4f(normal, 0.0)).xyz;
  return output;
}

@fragment
fn fs_lit(input: LitOutput) -> @location(0) vec4f {
  return vec4f(applyLight(draw.baseColor.rgb, input.worldNormal), draw.baseColor.a);
}

struct UnlitOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@vertex
fn vs_unlit(@location(0) position: vec3f, @location(1) color: vec4f, @location(2) target0: vec3f,
            @location(3) target1: vec3f) -> UnlitOutput {
  let morphed = position + target0 * draw.morphWeights.x + target1 * draw.morphWeights.y;
  var output: UnlitOutput;
  output.position = draw.mvp * vec4f(morphed, 1.0);
  output.color = color;
  return output;
}

@fragment
fn fs_unlit(input: UnlitOutput) -> @location(0) vec4f {
  let color = input.color * draw.baseColor;
  return vec4f(color.rgb * FLAME_BRIGHTNESS, color.a);
}
`;

// mvp (16 floats), model (16), baseColor (4), morphWeights (4).
const DRAW_UNIFORM_FLOATS = 40;

type Buffer = ReturnType<Device['createBuffer']>;
type BindGroup = ReturnType<Device['createBindGroup']>;
type RenderPipeline = ReturnType<Device['createRenderPipeline']>;

interface GpuPrimitive {
  readonly vertexBuffers: readonly Buffer[];
  readonly indexBuffer: Buffer;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly indexCount: number;
}

interface DrawItem {
  readonly node: number;
  readonly primitive: GltfPrimitive;
  readonly gpuPrimitive: GpuPrimitive;
  readonly pipeline: RenderPipeline;
  readonly uniformBuffer: Buffer;
  readonly bindGroup: BindGroup;
}

// The current transform and morph weights of a node, after the animations.
interface NodePose {
  translation: number[];
  rotation: number[];
  scale: number[];
  weights: number[];
}

// 'running': the ignite animation plays (and then holds its last frame), and the running
// animation loops. 'shuttingDown': the shutdown animation plays, and the running animation
// continues to loop until the shutdown animation is complete.
type EngineState = 'off' | 'running' | 'shuttingDown';

// Make a GPU buffer that contains data. The size of a buffer write must be a multiple of 4 bytes.
function createBuffer(device: Device, data: ArrayBufferView, usage: number): Buffer {
  const size = Math.ceil(data.byteLength / 4) * 4;
  const buffer = device.createBuffer({ size, usage: usage | gpu.GPUBufferUsage.COPY_DST });
  const padded = new Uint8Array(size);
  padded.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  device.queue.writeBuffer(buffer, 0, padded);
  return buffer;
}

function findAnimation(model: GltfModel, name: string): GltfAnimation {
  const animation = model.animations.find((candidate) => candidate.name === name);
  if (!animation) {
    throw new Error(`The ship model has no animation named ${name}`);
  }
  return animation;
}

export class Ship {
  private readonly device: Device;
  private readonly light: DirectionalLight;
  private readonly model: GltfModel;
  private readonly opaqueItems: DrawItem[] = [];
  private readonly blendedItems: DrawItem[] = [];
  private readonly poses: NodePose[];
  private readonly worldMatrices: Mat4[];
  private readonly flameRoot: number;
  private readonly ignite: GltfAnimation;
  private readonly running: GltfAnimation;
  private readonly shutdown: GltfAnimation;
  private readonly uniformData = new Float32Array(DRAW_UNIFORM_FLOATS);
  // The center of the bounding box of the ship in model space, with the engines off.
  readonly center: Vec3;
  private placement: Mat4 = compose([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  private viewProjection: Mat4 = compose([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  private engineState: EngineState = 'off';
  private igniteTime = 0;
  private runningTime = 0;
  private shutdownTime = 0;

  constructor(
    device: Device,
    format: TextureFormat,
    depthFormat: DepthFormat,
    light: DirectionalLight,
    model: GltfModel,
  ) {
    this.device = device;
    this.light = light;
    this.model = model;
    this.ignite = findAnimation(model, IGNITE_ANIMATION);
    this.running = findAnimation(model, RUNNING_ANIMATION);
    this.shutdown = findAnimation(model, SHUTDOWN_ANIMATION);
    this.flameRoot = model.nodes.findIndex((node) => node.name === FLAME_ROOT_NODE);
    if (this.flameRoot < 0) {
      throw new Error(`The ship model has no node named ${FLAME_ROOT_NODE}`);
    }
    this.poses = model.nodes.map(() => ({ translation: [], rotation: [], scale: [], weights: [] }));
    this.worldMatrices = model.nodes.map(() => new Float32Array(16));

    const drawLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: gpu.GPUShaderStage.VERTEX | gpu.GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [drawLayout, light.bindGroupLayout] });
    const shaderModule = device.createShaderModule({ code: SHADER });

    const float3 = (location: number) => ({
      arrayStride: 12,
      attributes: [{ shaderLocation: location, offset: 0, format: 'float32x3' as const }],
    });
    const litBuffers = [float3(0), float3(1)];
    const unlitBuffers = [
      float3(0),
      { arrayStride: 16, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' as const }] },
      float3(2),
      float3(3),
    ];

    // One pipeline for each combination of material properties that the model uses.
    const pipelines = new Map<string, RenderPipeline>();
    const pipelineFor = (primitive: GltfPrimitive): RenderPipeline => {
      const { unlit, blend, doubleSided } = primitive.material;
      const key = `${unlit} ${blend} ${doubleSided}`;
      let pipeline = pipelines.get(key);
      if (!pipeline) {
        pipeline = device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: {
            module: shaderModule,
            entryPoint: unlit ? 'vs_unlit' : 'vs_lit',
            buffers: unlit ? unlitBuffers : litBuffers,
          },
          fragment: {
            module: shaderModule,
            entryPoint: unlit ? 'fs_unlit' : 'fs_lit',
            targets: [
              {
                format,
                // Additive blending: overlapping flame layers add their light.
                blend: blend
                  ? {
                      color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
                      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                    }
                  : undefined,
              },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: doubleSided ? 'none' : 'back' },
          // Blended surfaces do not write depth, so they do not hide each other.
          depthStencil: { format: depthFormat, depthWriteEnabled: !blend, depthCompare: 'less' },
        });
        pipelines.set(key, pipeline);
      }
      return pipeline;
    };

    // The two engines use the same meshes, so make the GPU buffers once for each primitive.
    const gpuPrimitives = new Map<GltfPrimitive, GpuPrimitive>();
    const gpuPrimitiveFor = (primitive: GltfPrimitive): GpuPrimitive => {
      let gpuPrimitive = gpuPrimitives.get(primitive);
      if (!gpuPrimitive) {
        if (primitive.targets.length > MAX_MORPH_TARGETS) {
          throw new Error(`The ship shader supports at most ${MAX_MORPH_TARGETS} morph targets`);
        }
        const vertex = gpu.GPUBufferUsage.VERTEX;
        let vertexData: Float32Array[];
        if (primitive.material.unlit) {
          const vertexCount = primitive.positions.length / 3;
          const zeroOffsets = new Float32Array(vertexCount * 3);
          vertexData = [
            primitive.positions,
            primitive.colors ?? new Float32Array(vertexCount * 4).fill(1),
            primitive.targets[0] ?? zeroOffsets,
            primitive.targets[1] ?? zeroOffsets,
          ];
        } else {
          vertexData = [primitive.positions, primitive.normals];
        }
        gpuPrimitive = {
          vertexBuffers: vertexData.map((data) => createBuffer(device, data, vertex)),
          indexBuffer: createBuffer(device, primitive.indices, gpu.GPUBufferUsage.INDEX),
          indexFormat: primitive.indices instanceof Uint16Array ? 'uint16' : 'uint32',
          indexCount: primitive.indices.length,
        };
        gpuPrimitives.set(primitive, gpuPrimitive);
      }
      return gpuPrimitive;
    };

    model.nodes.forEach((node, nodeIndex) => {
      for (const primitive of node.mesh?.primitives ?? []) {
        const uniformBuffer = device.createBuffer({
          size: DRAW_UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
          usage: gpu.GPUBufferUsage.UNIFORM | gpu.GPUBufferUsage.COPY_DST,
        });
        const item: DrawItem = {
          node: nodeIndex,
          primitive,
          gpuPrimitive: gpuPrimitiveFor(primitive),
          pipeline: pipelineFor(primitive),
          uniformBuffer,
          bindGroup: device.createBindGroup({
            layout: drawLayout,
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
          }),
        };
        (primitive.material.blend ? this.blendedItems : this.opaqueItems).push(item);
      }
    });

    // The placement is the identity here, so the world matrices are in model space.
    this.updatePose();
    this.center = this.computeCenter();
  }

  private computeCenter(): Vec3 {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const item of [...this.opaqueItems, ...this.blendedItems]) {
      const { min: low, max: high } = item.primitive;
      for (let corner = 0; corner < 8; ++corner) {
        const point = transformPoint(this.worldMatrices[item.node], [
          corner & 1 ? high[0] : low[0],
          corner & 2 ? high[1] : low[1],
          corner & 4 ? high[2] : low[2],
        ]);
        for (let axis = 0; axis < 3; ++axis) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }
    }
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }

  // Set the transform from model space to world space.
  setPlacement(translation: Vec3, rotation: Quat): void {
    this.placement = compose(translation, rotation, [1, 1, 1]);
    this.updateWorldMatrices();
  }

  setViewProjection(viewProjection: Mat4): void {
    this.viewProjection = viewProjection;
  }

  // Ignite the engines, or shut them down. A change in the middle of an ignition or a shutdown
  // starts the other animation at the current flame size, so the flames do not jump.
  setEnginesOn(on: boolean): void {
    if (on && this.engineState !== 'running') {
      if (this.engineState === 'off') {
        this.igniteTime = 0;
        this.runningTime = 0;
      } else {
        this.igniteTime = this.timeAtFlameSize(this.ignite, this.flameSize());
      }
      this.engineState = 'running';
    } else if (!on && this.engineState === 'running') {
      this.shutdownTime = this.timeAtFlameSize(this.shutdown, this.flameSize());
      this.engineState = 'shuttingDown';
    }
  }

  // Advance the animations by a time step in seconds.
  update(seconds: number): void {
    if (this.engineState === 'running') {
      this.igniteTime = Math.min(this.igniteTime + seconds, this.ignite.duration);
      this.runningTime = (this.runningTime + seconds) % this.running.duration;
    } else if (this.engineState === 'shuttingDown') {
      this.shutdownTime += seconds;
      this.runningTime = (this.runningTime + seconds) % this.running.duration;
      if (this.shutdownTime >= this.shutdown.duration) {
        this.engineState = 'off';
      }
    }
    this.updatePose();
  }

  draw(pass: RenderPassEncoder): void {
    this.light.bind(pass);
    // Draw the blended flames after all opaque surfaces, so that the depth test hides the
    // parts of the flames that are behind the ship.
    for (const item of [...this.opaqueItems, ...this.blendedItems]) {
      const world = this.worldMatrices[item.node];
      if (Math.hypot(world[0], world[1], world[2]) < MIN_DRAW_SCALE) {
        continue;
      }
      this.uniformData.set(multiply(this.viewProjection, world), 0);
      this.uniformData.set(world, 16);
      this.uniformData.set(item.primitive.material.baseColor, 32);
      const weights = this.poses[item.node].weights;
      this.uniformData.set([weights[0] ?? 0, weights[1] ?? 0, 0, 0], 36);
      this.device.queue.writeBuffer(item.uniformBuffer, 0, this.uniformData);

      const { vertexBuffers, indexBuffer, indexFormat, indexCount } = item.gpuPrimitive;
      pass.setPipeline(item.pipeline);
      pass.setBindGroup(0, item.bindGroup);
      vertexBuffers.forEach((buffer, slot) => pass.setVertexBuffer(slot, buffer));
      pass.setIndexBuffer(indexBuffer, indexFormat);
      pass.drawIndexed(indexCount);
    }
  }

  // The scale of the flame root node: 0 when the engines are off, and 1 when they are on.
  private flameSize(): number {
    return this.poses[this.flameRoot].scale[0];
  }

  // The time in an animation where the flame root has a given scale.
  private timeAtFlameSize(animation: GltfAnimation, size: number): number {
    const channel = animation.channels.find((c) => c.node === this.flameRoot && c.path === 'scale');
    if (!channel) {
      return 0;
    }
    const value: number[] = [];
    let bestTime = 0;
    let bestError = Infinity;
    const steps = 100;
    for (let step = 0; step <= steps; ++step) {
      const time = (animation.duration * step) / steps;
      sampleChannel(channel, time, value);
      const error = Math.abs(value[0] - size);
      if (error < bestError) {
        bestError = error;
        bestTime = time;
      }
    }
    return bestTime;
  }

  // Start from the rest pose of each node, then apply the active animations.
  private updatePose(): void {
    this.model.nodes.forEach((node, index) => {
      const pose = this.poses[index];
      pose.translation = [...node.translation];
      pose.rotation = [...node.rotation];
      pose.scale = [...node.scale];
      pose.weights = [...node.weights];
    });
    if (this.engineState !== 'off') {
      this.applyAnimation(this.running, this.runningTime);
    }
    if (this.engineState === 'running') {
      this.applyAnimation(this.ignite, this.igniteTime);
    } else if (this.engineState === 'shuttingDown') {
      this.applyAnimation(this.shutdown, this.shutdownTime);
    }
    this.updateWorldMatrices();
  }

  private applyAnimation(animation: GltfAnimation, time: number): void {
    for (const channel of animation.channels) {
      sampleChannel(channel, time, this.poses[channel.node][channel.path]);
    }
  }

  private updateWorldMatrices(): void {
    const visit = (index: number, parent: Mat4): void => {
      const pose = this.poses[index];
      const local = compose(
        [pose.translation[0], pose.translation[1], pose.translation[2]],
        [pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]],
        [pose.scale[0], pose.scale[1], pose.scale[2]],
      );
      this.worldMatrices[index] = multiply(parent, local);
      for (const child of this.model.nodes[index].children) {
        visit(child, this.worldMatrices[index]);
      }
    };
    for (const root of this.model.roots) {
      visit(root, this.placement);
    }
  }
}
