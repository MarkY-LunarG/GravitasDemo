// A minimal loader for binary glTF 2.0 (.glb) files, and a sampler for glTF animations.
// The loader supports only the features that the models in this project use: float vertex
// attributes, 16-bit or 32-bit indices, morph targets, node TRS transforms, material base colors,
// KHR_materials_unlit, and LINEAR animation channels. It throws an error for other features,
// so that a model does not draw incorrectly without a message.

import fs from 'node:fs';
import type { Quat, Vec3 } from './mat4.js';

export interface GltfMaterial {
  readonly name: string;
  readonly baseColor: readonly [number, number, number, number];
  readonly unlit: boolean;
  // True for alphaMode BLEND.
  readonly blend: boolean;
  readonly doubleSided: boolean;
}

export interface GltfPrimitive {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  // RGBA vertex colors (COLOR_0), or null if the primitive has no vertex colors.
  readonly colors: Float32Array | null;
  readonly indices: Uint16Array | Uint32Array;
  // The position offsets of each morph target.
  readonly targets: readonly Float32Array[];
  readonly material: GltfMaterial;
  // The bounding box of the positions, from the accessor min and max.
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface GltfMesh {
  readonly name: string;
  readonly primitives: readonly GltfPrimitive[];
  readonly weights: readonly number[];
}

export interface GltfNode {
  readonly name: string;
  readonly mesh: GltfMesh | null;
  readonly children: readonly number[];
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
  // The morph target weights of the node, or of its mesh if the node has none.
  readonly weights: readonly number[];
}

export type GltfPath = 'translation' | 'rotation' | 'scale' | 'weights';

export interface GltfChannel {
  readonly node: number;
  readonly path: GltfPath;
  readonly times: Float32Array;
  // For each keyframe: 3 values for translation and scale, 4 for rotation, and one value for
  // each morph target for weights.
  readonly values: Float32Array;
}

export interface GltfAnimation {
  readonly name: string;
  readonly duration: number;
  readonly channels: readonly GltfChannel[];
}

export interface GltfModel {
  readonly nodes: readonly GltfNode[];
  // The root nodes of the default scene.
  readonly roots: readonly number[];
  readonly animations: readonly GltfAnimation[];
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const TRIANGLES = 4;

// The parts of the glTF JSON that the loader reads.
interface Json {
  scene?: number;
  scenes: { nodes: number[] }[];
  nodes: {
    name?: string;
    mesh?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    matrix?: number[];
    weights?: number[];
    skin?: number;
  }[];
  meshes?: { name?: string; weights?: number[]; primitives: JsonPrimitive[] }[];
  materials?: {
    name?: string;
    alphaMode?: string;
    doubleSided?: boolean;
    pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: unknown };
    extensions?: Record<string, unknown>;
  }[];
  accessors: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
    sparse?: unknown;
  }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  animations?: {
    name?: string;
    channels: { sampler: number; target: { node?: number; path: string } }[];
    samplers: { input: number; output: number; interpolation?: string }[];
  }[];
}

interface JsonPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
}

const DEFAULT_MATERIAL: GltfMaterial = {
  name: 'default',
  baseColor: [1, 1, 1, 1],
  unlit: false,
  blend: false,
  doubleSided: false,
};

export function loadGlb(path: string): GltfModel {
  const file = fs.readFileSync(path);
  if (file.readUInt32LE(0) !== GLB_MAGIC || file.readUInt32LE(4) !== 2) {
    throw new Error(`${path} is not a glTF 2.0 binary file`);
  }

  // The JSON chunk is first, and the optional BIN chunk follows it.
  const jsonLength = file.readUInt32LE(12);
  if (file.readUInt32LE(16) !== CHUNK_JSON) {
    throw new Error(`${path} does not start with a JSON chunk`);
  }
  const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString('utf8')) as Json;
  const binHeader = 20 + jsonLength;
  let bin = Buffer.alloc(0);
  if (binHeader + 8 <= file.length && file.readUInt32LE(binHeader + 4) === CHUNK_BIN) {
    bin = file.subarray(binHeader + 8, binHeader + 8 + file.readUInt32LE(binHeader));
  }

  // Copy an accessor into a new typed array. The copy has the correct alignment for the type.
  const readAccessor = (index: number): Float32Array | Uint16Array | Uint32Array => {
    const accessor = json.accessors[index];
    if (accessor.bufferView === undefined || accessor.sparse !== undefined) {
      throw new Error(`Accessor ${index}: sparse accessors and accessors without data are not supported`);
    }
    const view = json.bufferViews[accessor.bufferView];
    if (view.buffer !== 0) {
      throw new Error(`Accessor ${index}: only the GLB binary chunk is supported`);
    }
    const ArrayType =
      accessor.componentType === FLOAT
        ? Float32Array
        : accessor.componentType === UNSIGNED_SHORT
          ? Uint16Array
          : accessor.componentType === UNSIGNED_INT
            ? Uint32Array
            : null;
    if (ArrayType === null || (accessor.normalized && ArrayType !== Float32Array)) {
      throw new Error(`Accessor ${index}: component type ${accessor.componentType} is not supported`);
    }
    const components = COMPONENT_COUNT[accessor.type];
    const elementSize = components * ArrayType.BYTES_PER_ELEMENT;
    const stride = view.byteStride ?? elementSize;
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const output = new ArrayType(accessor.count * components);
    const outputBytes = new Uint8Array(output.buffer);
    for (let i = 0; i < accessor.count; ++i) {
      outputBytes.set(bin.subarray(start + i * stride, start + i * stride + elementSize), i * elementSize);
    }
    return output;
  };

  const readFloats = (index: number): Float32Array => {
    const data = readAccessor(index);
    if (!(data instanceof Float32Array)) {
      throw new Error(`Accessor ${index}: expected float data`);
    }
    return data;
  };

  const materials = (json.materials ?? []).map((material): GltfMaterial => {
    if (material.pbrMetallicRoughness?.baseColorTexture !== undefined) {
      throw new Error(`Material ${material.name}: textures are not supported`);
    }
    const color = material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    return {
      name: material.name ?? '',
      baseColor: [color[0], color[1], color[2], color[3]],
      unlit: material.extensions?.KHR_materials_unlit !== undefined,
      blend: material.alphaMode === 'BLEND',
      doubleSided: material.doubleSided ?? false,
    };
  });

  const meshes = (json.meshes ?? []).map((mesh): GltfMesh => {
    const primitives = mesh.primitives.map((primitive): GltfPrimitive => {
      if ((primitive.mode ?? TRIANGLES) !== TRIANGLES) {
        throw new Error(`Mesh ${mesh.name}: only triangle lists are supported`);
      }
      if (primitive.indices === undefined || primitive.attributes.NORMAL === undefined) {
        throw new Error(`Mesh ${mesh.name}: primitives must have indices and normals`);
      }
      const indices = readAccessor(primitive.indices);
      if (indices instanceof Float32Array) {
        throw new Error(`Mesh ${mesh.name}: indices must be unsigned integers`);
      }
      const positionAccessor = json.accessors[primitive.attributes.POSITION];
      const min = positionAccessor.min ?? [0, 0, 0];
      const max = positionAccessor.max ?? [0, 0, 0];
      return {
        positions: readFloats(primitive.attributes.POSITION),
        normals: readFloats(primitive.attributes.NORMAL),
        colors: primitive.attributes.COLOR_0 !== undefined ? readFloats(primitive.attributes.COLOR_0) : null,
        indices,
        targets: (primitive.targets ?? []).map((target) => readFloats(target.POSITION)),
        material: primitive.material !== undefined ? materials[primitive.material] : DEFAULT_MATERIAL,
        min: [min[0], min[1], min[2]],
        max: [max[0], max[1], max[2]],
      };
    });
    const targetCount = primitives[0]?.targets.length ?? 0;
    return {
      name: mesh.name ?? '',
      primitives,
      weights: mesh.weights ?? new Array<number>(targetCount).fill(0),
    };
  });

  const nodes = json.nodes.map((node): GltfNode => {
    if (node.matrix !== undefined || node.skin !== undefined) {
      throw new Error(`Node ${node.name}: matrix transforms and skins are not supported`);
    }
    const mesh = node.mesh !== undefined ? meshes[node.mesh] : null;
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];
    return {
      name: node.name ?? '',
      mesh,
      children: node.children ?? [],
      translation: [t[0], t[1], t[2]],
      rotation: [r[0], r[1], r[2], r[3]],
      scale: [s[0], s[1], s[2]],
      weights: node.weights ?? mesh?.weights ?? [],
    };
  });

  const animations = (json.animations ?? []).map((animation): GltfAnimation => {
    const channels = animation.channels.map((channel): GltfChannel => {
      const sampler = animation.samplers[channel.sampler];
      if ((sampler.interpolation ?? 'LINEAR') !== 'LINEAR') {
        throw new Error(`Animation ${animation.name}: only LINEAR interpolation is supported`);
      }
      if (channel.target.node === undefined) {
        throw new Error(`Animation ${animation.name}: channels must have a target node`);
      }
      return {
        node: channel.target.node,
        path: channel.target.path as GltfPath,
        times: readFloats(sampler.input),
        values: readFloats(sampler.output),
      };
    });
    return {
      name: animation.name ?? '',
      duration: Math.max(0, ...channels.map((channel) => channel.times[channel.times.length - 1])),
      channels,
    };
  });

  return { nodes, roots: json.scenes[json.scene ?? 0].nodes, animations };
}

// Write the value of a channel at a time into output. Times before the first keyframe or after
// the last keyframe use the value of that keyframe.
export function sampleChannel(channel: GltfChannel, time: number, output: number[]): void {
  const { times, values } = channel;
  const size = values.length / times.length;
  const last = times.length - 1;
  if (time <= times[0] || last === 0) {
    copyKeyframe(values, 0, size, output);
    return;
  }
  if (time >= times[last]) {
    copyKeyframe(values, last, size, output);
    return;
  }

  // Find the keyframe pair that contains the time.
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const fraction = (time - times[low]) / (times[high] - times[low]);

  if (channel.path === 'rotation') {
    slerp(values, low * 4, high * 4, fraction, output);
    return;
  }
  for (let i = 0; i < size; ++i) {
    const a = values[low * size + i];
    output[i] = a + (values[high * size + i] - a) * fraction;
  }
}

function copyKeyframe(values: Float32Array, keyframe: number, size: number, output: number[]): void {
  for (let i = 0; i < size; ++i) {
    output[i] = values[keyframe * size + i];
  }
}

// Spherical linear interpolation between the quaternions at offsets a and b.
function slerp(values: Float32Array, a: number, b: number, fraction: number, output: number[]): void {
  let dot = 0;
  for (let i = 0; i < 4; ++i) {
    dot += values[a + i] * values[b + i];
  }
  // Use the shorter path: q and -q are the same rotation.
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let weightA = 1 - fraction;
  let weightB = fraction;
  // For nearly equal quaternions, linear interpolation is accurate and avoids a division by zero.
  if (dot < 0.9995) {
    const angle = Math.acos(dot);
    const sinAngle = Math.sin(angle);
    weightA = Math.sin((1 - fraction) * angle) / sinAngle;
    weightB = Math.sin(fraction * angle) / sinAngle;
  }
  let length = 0;
  for (let i = 0; i < 4; ++i) {
    output[i] = weightA * values[a + i] + weightB * sign * values[b + i];
    length += output[i] * output[i];
  }
  length = Math.sqrt(length);
  for (let i = 0; i < 4; ++i) {
    output[i] /= length;
  }
}
