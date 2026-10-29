// A field of 3D asteroids around the ship. The GPU does all of the work after the start:
//
// 1. At the start, a compute shader makes ASTEROID_SHAPES rock shapes from an icosphere. The
//    surface uses the design of the terrain in 3D: Perlin noise and small craters with the same
//    bowl and rim. Each shape has two levels of detail (LOD) from the same surface function.
// 2. In each frame, a compute shader moves and turns each asteroid, removes the asteroids that
//    are outside the view, selects the LOD from the size on the screen, and adds the asteroid to
//    the list of its shape and LOD. It counts the instances of each list in an indirect draw buffer.
// 3. The render pass draws each list with one instanced drawIndexedIndirect call. The vertex
//    shader reads the shape vertices and the asteroid data from storage buffers.
//
// All world units are meters. The asteroids use the shared sun. The start positions come from a
// random number generator with a fixed seed, so each run of the benchmark is the same.

import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { type DirectionalLight, LIGHT_WGSL } from './light.js';
import { type Mat4, type Vec3, frustumPlanes } from './mat4.js';
import { NOISE_WGSL } from './noise.js';

const ASTEROID_COUNT = 4000;
const ASTEROID_SHAPES = 8;
// The icosphere subdivisions of each LOD: 4 gives 5120 triangles, and 2 gives 320 triangles.
const LOD_SUBDIVISIONS = [4, 2] as const;
// An asteroid uses LOD 0 when radius / distance is larger than this value. At 1920 x 1080 with a
// 45-degree vertical field of view, 0.02 is a radius of approximately 26 pixels.
const LOD_THRESHOLD = 0.02;
// The radius of an asteroid is between ASTEROID_RADIUS[0] and ASTEROID_RADIUS[1] meters.
// Small asteroids are much more common than large asteroids.
const ASTEROID_RADIUS = [2, 60] as const;
// The surface is at most this many times the radius from the center. The culling uses it.
const BOUNDING_SCALE = 1.5;

// The surface of each shape: Perlin noise with SHAPE_OCTAVES octaves, and SHAPE_CRATERS small
// craters. The values are relative to a radius of 1. SHAPE_STRETCH is the range of the random
// scale on each axis, so that the shapes are not round.
const SHAPE_NOISE_FREQUENCY = 1.5;
const SHAPE_NOISE_AMPLITUDE = 0.22;
const SHAPE_OCTAVES = 4;
const SHAPE_CRATERS = 14;
const SHAPE_CRATER_RADIUS = [0.08, 0.3] as const;
const SHAPE_STRETCH = [0.65, 1.0] as const;

// The asteroids move in a box around the ship. The box axes are the heading (toward the front of
// the ship), right, and up, and the values are meters from the ship center. An asteroid that
// leaves the box on one side comes back on the other side.
// All asteroids move toward the camera at FLOW_SPEED (times the speed scale from the scene), and
// each asteroid also has a random velocity of up to VELOCITY_SPREAD in each direction.
// CLEAR_RADIUS is the radius of a tube along the heading, through the ship center, where no
// asteroid can go. The tube contains the ship and all camera positions.
const BOX_HEADING = [-400, 4000] as const;
const BOX_RIGHT = [-1500, 1500] as const;
const BOX_UP = [-600, 600] as const;
const FLOW_SPEED = 150;
const VELOCITY_SPREAD = 15;
const SPIN_SPEED = [0.05, 0.6] as const;
const CLEAR_RADIUS = 130;
// The speed in meters per second at which an asteroid in the tube moves out of it.
const CLEAR_PUSH_SPEED = 200;

const RANDOM_SEED = 20261029;
const WORKGROUP_SIZE = 64;

const LOD_COUNT = LOD_SUBDIVISIONS.length;
const DRAW_COUNT = ASTEROID_SHAPES * LOD_COUNT;
// Each indirect draw has 5 u32 values: indexCount, instanceCount, firstIndex, baseVertex, and
// firstInstance.
const DRAW_ARGS_SIZE = 5;
// position + radius, velocity + shape, spinAxis + spinSpeed, orientation: 16 floats.
const ASTEROID_FLOATS = 16;
// planes (6 vec4f), shipCenter, right, up, heading, cameraPosition (5 vec4f), and
// seconds, flowSpeed, and 2 unused floats.
const UPDATE_PARAMS_FLOATS = 48;

// Make an icosphere: an icosahedron with each triangle divided into 4, subdivisions times.
// All vertices are on the unit sphere. The triangles are counterclockwise from the outside.
function makeIcosphere(subdivisions: number): { vertices: number[][]; indices: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const vertices = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
  });
  let triangles = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let level = 0; level < subdivisions; ++level) {
    // The two triangles on each side of an edge use the same new vertex.
    const midpoints = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      let index = midpoints.get(key);
      if (index === undefined) {
        const [pa, pb] = [vertices[a], vertices[b]];
        const m = [pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]];
        const length = Math.hypot(m[0], m[1], m[2]);
        index = vertices.push([m[0] / length, m[1] / length, m[2] / length]) - 1;
        midpoints.set(key, index);
      }
      return index;
    };
    triangles = triangles.flatMap(([a, b, c]) => {
      const [ab, bc, ca] = [midpoint(a, b), midpoint(b, c), midpoint(c, a)];
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }
  return { vertices, indices: triangles.flat() };
}

// A small random number generator (mulberry32) with a fixed seed. Math.random() has no seed.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Code that the shape shader and the render shader both use.
const COMMON_WGSL = /* wgsl */ `
${NOISE_WGSL}
struct ShapeVertex {
  position: vec4f,
  normal: vec4f,
}

struct Asteroid {
  position: vec3f,
  radius: f32,
  velocity: vec3f,
  shape: u32,
  spinAxis: vec3f,
  spinSpeed: f32,
  // A unit quaternion [x, y, z, w].
  orientation: vec4f,
}

// A random number in [0, 1) for an integer key and a seed.
fn random(key: u32, seed: u32) -> f32 {
  return f32(hash3(vec3i(i32(key), 0, 0), seed) >> 8u) / 16777216.0;
}

fn rotate(q: vec4f, v: vec3f) -> vec3f {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
`;

const SHAPE_SHADER = /* wgsl */ `
${COMMON_WGSL}
const VERTEX_COUNT_0: u32 = __VERTEX_COUNT_0__u;
const VERTEX_COUNT_1: u32 = __VERTEX_COUNT_1__u;
const SHAPES: u32 = ${ASTEROID_SHAPES}u;
const NOISE_FREQUENCY: f32 = ${SHAPE_NOISE_FREQUENCY};
const NOISE_AMPLITUDE: f32 = ${SHAPE_NOISE_AMPLITUDE};
const OCTAVES: u32 = ${SHAPE_OCTAVES}u;
const CRATERS: u32 = ${SHAPE_CRATERS}u;
const CRATER_RADIUS_MIN: f32 = ${SHAPE_CRATER_RADIUS[0]};
const CRATER_RADIUS_MAX: f32 = ${SHAPE_CRATER_RADIUS[1]};
const STRETCH_MIN: f32 = ${SHAPE_STRETCH[0]};
const STRETCH_MAX: f32 = ${SHAPE_STRETCH[1]};

// The unit sphere directions of the vertices of LOD 0, then of LOD 1.
@group(0) @binding(0) var<storage, read> directions: array<vec4f>;
// For LOD 0, the vertices of shape 0, then shape 1, and so on. Then the same for LOD 1.
@group(0) @binding(1) var<storage, read_write> shapeVertices: array<ShapeVertex>;

// The crater profile of the terrain: a bowl below the surface inside the radius, and a raised rim
// at the radius. d is the distance from the crater center divided by the radius.
fn craterProfile(d: f32, radius: f32) -> f32 {
  if (d >= 2.0) {
    return 0.0;
  }
  let rimOffset = (d - 1.0) / 0.3;
  var height = 0.06 * radius * exp(-rimOffset * rimOffset);
  if (d < 1.0) {
    height += 0.2 * radius * (d * d - 1.0);
  }
  return height;
}

// A random unit vector for a crater.
fn randomDirection(key: u32, seed: u32) -> vec3f {
  let z = random(key, seed) * 2.0 - 1.0;
  let angle = random(key, seed + 1u) * 6.2831853;
  let r = sqrt(1.0 - z * z);
  return vec3f(r * cos(angle), r * sin(angle), z);
}

// The surface point of a shape in a unit direction.
fn surface(direction: vec3f, shape: u32) -> vec3f {
  var height = 0.0;
  var frequency = NOISE_FREQUENCY;
  var amplitude = NOISE_AMPLITUDE;
  for (var octave = 0u; octave < OCTAVES; octave++) {
    height += perlin3(direction * frequency, shape * 16u + octave) * amplitude;
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  for (var crater = 0u; crater < CRATERS; crater++) {
    let key = shape * 64u + crater;
    let center = randomDirection(key, 1000u);
    let radius = mix(CRATER_RADIUS_MIN, CRATER_RADIUS_MAX, random(key, 2000u));
    // The angle between the directions is the distance on the unit sphere.
    let angle = acos(clamp(dot(direction, center), -1.0, 1.0));
    height += craterProfile(angle / radius, radius);
  }
  let stretch = mix(vec3f(STRETCH_MIN), vec3f(STRETCH_MAX),
                    vec3f(random(shape, 3000u), random(shape, 3001u), random(shape, 3002u)));
  return direction * (1.0 + height) * stretch;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn cs_shapes(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= SHAPES * (VERTEX_COUNT_0 + VERTEX_COUNT_1)) {
    return;
  }
  var local = index;
  var vertexCount = VERTEX_COUNT_0;
  var directionBase = 0u;
  if (index >= SHAPES * VERTEX_COUNT_0) {
    local = index - SHAPES * VERTEX_COUNT_0;
    vertexCount = VERTEX_COUNT_1;
    directionBase = VERTEX_COUNT_0;
  }
  let shape = local / vertexCount;
  let direction = directions[directionBase + local % vertexCount].xyz;

  // The normal comes from two near points on the surface, in two tangent directions.
  var tangent = cross(direction, vec3f(0.0, 1.0, 0.0));
  if (length(tangent) < 0.1) {
    tangent = cross(direction, vec3f(1.0, 0.0, 0.0));
  }
  tangent = normalize(tangent);
  let bitangent = cross(direction, tangent);
  let step = 0.002;
  let center = surface(direction, shape);
  let a = surface(normalize(direction + tangent * step), shape);
  let b = surface(normalize(direction + bitangent * step), shape);
  var normal = normalize(cross(a - center, b - center));
  if (dot(normal, direction) < 0.0) {
    normal = -normal;
  }
  shapeVertices[index] = ShapeVertex(vec4f(center, 1.0), vec4f(normal, 0.0));
}
`;

const UPDATE_SHADER = /* wgsl */ `
${COMMON_WGSL}
const COUNT: u32 = ${ASTEROID_COUNT}u;
const LODS: u32 = ${LOD_COUNT}u;
const LOD_THRESHOLD: f32 = ${LOD_THRESHOLD};
const BOUNDING_SCALE: f32 = ${BOUNDING_SCALE};
const BOX_MIN: vec3f = vec3f(${BOX_RIGHT[0]}.0, ${BOX_UP[0]}.0, ${BOX_HEADING[0]}.0);
const BOX_MAX: vec3f = vec3f(${BOX_RIGHT[1]}.0, ${BOX_UP[1]}.0, ${BOX_HEADING[1]}.0);
const CLEAR_RADIUS: f32 = ${CLEAR_RADIUS}.0;
const CLEAR_PUSH_SPEED: f32 = ${CLEAR_PUSH_SPEED}.0;

struct Params {
  planes: array<vec4f, 6>,
  shipCenter: vec4f,
  right: vec4f,
  up: vec4f,
  heading: vec4f,
  cameraPosition: vec4f,
  seconds: f32,
  flowSpeed: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> asteroids: array<Asteroid>;
// DRAW_ARGS_SIZE u32 values for each draw. The shader adds 1 to instanceCount (the second
// value) for each visible asteroid of the draw.
@group(0) @binding(2) var<storage, read_write> drawArgs: array<atomic<u32>>;
// COUNT entries for each draw: the asteroid indices of the visible instances.
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;

fn wrap(value: f32, low: f32, high: f32) -> f32 {
  return low + (value - low) - floor((value - low) / (high - low)) * (high - low);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn cs_update(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= COUNT) {
    return;
  }
  var asteroid = asteroids[index];
  let dt = params.seconds;

  // Move, and turn around the spin axis.
  asteroid.position += (asteroid.velocity - params.heading.xyz * params.flowSpeed) * dt;
  let spin = vec4f(asteroid.spinAxis * asteroid.spinSpeed, 0.0);
  let q = asteroid.orientation;
  // The derivative of the orientation is 0.5 * spin * q (quaternion product).
  let dq = 0.5 * vec4f(spin.w * q.xyz + q.w * spin.xyz + cross(spin.xyz, q.xyz), spin.w * q.w - dot(spin.xyz, q.xyz));
  asteroid.orientation = normalize(q + dq * dt);

  // Keep the asteroid in the box, and out of the clear tube, in the coordinates of the box.
  let relative = asteroid.position - params.shipCenter.xyz;
  var local = vec3f(dot(relative, params.right.xyz), dot(relative, params.up.xyz), dot(relative, params.heading.xyz));
  local = vec3f(wrap(local.x, BOX_MIN.x, BOX_MAX.x), wrap(local.y, BOX_MIN.y, BOX_MAX.y),
                wrap(local.z, BOX_MIN.z, BOX_MAX.z));
  let bound = asteroid.radius * BOUNDING_SCALE;
  let lateral = length(local.xy);
  let minimum = CLEAR_RADIUS + bound;
  if (lateral < minimum) {
    let outward = select(vec2f(1.0, 0.0), local.xy / lateral, lateral > 1e-3);
    local = vec3f(local.xy + outward * min(minimum - lateral, CLEAR_PUSH_SPEED * dt), local.z);
  }
  asteroid.position = params.shipCenter.xyz + params.right.xyz * local.x + params.up.xyz * local.y
    + params.heading.xyz * local.z;
  asteroids[index] = asteroid;

  // Remove the asteroid if its bounding sphere is outside one of the planes of the view.
  for (var i = 0u; i < 6u; i++) {
    let plane = params.planes[i];
    if (dot(plane.xyz, asteroid.position) + plane.w < -bound) {
      return;
    }
  }

  let distance = length(asteroid.position - params.cameraPosition.xyz);
  let lod = select(1u, 0u, asteroid.radius > LOD_THRESHOLD * distance);
  let draw = asteroid.shape * LODS + lod;
  let slot = atomicAdd(&drawArgs[draw * ${DRAW_ARGS_SIZE}u + 1u], 1u);
  visible[draw * COUNT + slot] = index;
}
`;

const RENDER_SHADER = /* wgsl */ `
${LIGHT_WGSL}
${COMMON_WGSL}
const COUNT: u32 = ${ASTEROID_COUNT}u;

@group(0) @binding(0) var<uniform> viewProjection: mat4x4f;
// x is the first entry of the visible list of this draw.
@group(0) @binding(1) var<uniform> drawInfo: vec4u;
@group(0) @binding(2) var<storage, read> asteroids: array<Asteroid>;
@group(0) @binding(3) var<storage, read> visible: array<u32>;
@group(0) @binding(4) var<storage, read> shapeVertices: array<ShapeVertex>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) color: vec3f,
}

// vertex_index includes the baseVertex of the draw, so it selects the shape and the LOD.
@vertex
fn vs_asteroid(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32)
    -> VertexOutput {
  let index = visible[drawInfo.x + instance];
  let asteroid = asteroids[index];
  let vertex = shapeVertices[vertexIndex];
  let world = asteroid.position + rotate(asteroid.orientation, vertex.position.xyz * asteroid.radius);
  var output: VertexOutput;
  output.position = viewProjection * vec4f(world, 1.0);
  output.worldNormal = rotate(asteroid.orientation, vertex.normal.xyz);
  // A gray rock color, a little different for each asteroid.
  let shade = mix(0.35, 0.6, random(index, 5000u));
  output.color = vec3f(shade, shade * 0.95, shade * 0.9);
  return output;
}

@fragment
fn fs_asteroid(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(applyLight(input.color, input.worldNormal), 1.0);
}
`;

export class Asteroids {
  private readonly device: Device;
  private readonly light: DirectionalLight;
  private readonly shipCenter: Vec3;
  private readonly basis: { right: Vec3; up: Vec3; heading: Vec3 };
  private readonly indexBuffer: GPUBuffer;
  private readonly drawArgsBuffer: GPUBuffer;
  // The draw arguments with instanceCount 0. Each frame starts from these values.
  private readonly drawArgsTemplate: Uint32Array;
  private readonly updateParamsBuffer: GPUBuffer;
  private readonly updateParams = new Float32Array(UPDATE_PARAMS_FLOATS);
  private readonly updatePipeline: GPUComputePipeline;
  private readonly updateBindGroup: GPUBindGroup;
  private readonly renderPipeline: GPURenderPipeline;
  private readonly renderBindGroups: GPUBindGroup[];
  private readonly viewProjectionBuffer: GPUBuffer;

  // shipCenter is the center of the box. heading is the horizontal direction of the front of the
  // ship. The asteroids move from the front of the ship toward the camera.
  constructor(
    device: Device,
    format: TextureFormat,
    depthFormat: DepthFormat,
    light: DirectionalLight,
    shipCenter: Vec3,
    heading: Vec3,
  ) {
    this.device = device;
    this.light = light;
    this.shipCenter = shipCenter;
    const up: Vec3 = [0, 1, 0];
    // right = heading x up, for a right-handed system with +Y up.
    const right: Vec3 = [-heading[2], 0, heading[0]];
    this.basis = { right, up, heading };

    // The icosphere of each LOD. One index buffer has the indices of LOD 0, then of LOD 1.
    const spheres = LOD_SUBDIVISIONS.map((subdivisions) => makeIcosphere(subdivisions));
    const vertexCounts = spheres.map((sphere) => sphere.vertices.length);
    const indexCounts = spheres.map((sphere) => sphere.indices.length);
    const directions = new Float32Array(spheres.flatMap((sphere) => sphere.vertices.flatMap((v) => [...v, 0])));
    const indices = new Uint32Array(spheres.flatMap((sphere) => sphere.indices));
    this.indexBuffer = this.createBuffer(indices, GPUBufferUsage.INDEX);

    // The draw for shape s and LOD l is s * LOD_COUNT + l. Its vertices start at baseVertex,
    // its indices start at firstIndex, and its visible list starts at draw * ASTEROID_COUNT.
    this.drawArgsTemplate = new Uint32Array(DRAW_COUNT * DRAW_ARGS_SIZE);
    const lodVertexStart = [0, ASTEROID_SHAPES * vertexCounts[0]];
    const lodIndexStart = [0, indexCounts[0]];
    for (let shape = 0; shape < ASTEROID_SHAPES; ++shape) {
      for (let lod = 0; lod < LOD_COUNT; ++lod) {
        const draw = shape * LOD_COUNT + lod;
        this.drawArgsTemplate.set(
          [indexCounts[lod], 0, lodIndexStart[lod], lodVertexStart[lod] + shape * vertexCounts[lod], 0],
          draw * DRAW_ARGS_SIZE,
        );
      }
    }
    this.drawArgsBuffer = this.createBuffer(
      this.drawArgsTemplate,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
    );

    const shapeVertexCount = ASTEROID_SHAPES * (vertexCounts[0] + vertexCounts[1]);
    // Two vec4f for each vertex.
    const shapeVertexBuffer = device.createBuffer({
      size: shapeVertexCount * 8 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE,
    });
    this.makeShapes(this.createBuffer(directions, GPUBufferUsage.STORAGE), shapeVertexBuffer, vertexCounts);

    const asteroidBuffer = this.createBuffer(this.makeAsteroids(), GPUBufferUsage.STORAGE);
    const visibleBuffer = device.createBuffer({
      size: DRAW_COUNT * ASTEROID_COUNT * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE,
    });

    // The update and cull pass.
    this.updateParamsBuffer = device.createBuffer({
      size: UPDATE_PARAMS_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const updateModule = device.createShaderModule({ code: UPDATE_SHADER });
    this.updatePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: updateModule, entryPoint: 'cs_update' },
    });
    this.updateBindGroup = device.createBindGroup({
      layout: this.updatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.updateParamsBuffer } },
        { binding: 1, resource: { buffer: asteroidBuffer } },
        { binding: 2, resource: { buffer: this.drawArgsBuffer } },
        { binding: 3, resource: { buffer: visibleBuffer } },
      ],
    });

    // The render pass. Each draw has its own bind group, because the start of its visible list is
    // different. firstInstance must be 0 in an indirect draw without the indirect-first-instance
    // feature, so the start of the list cannot come from firstInstance.
    this.viewProjectionBuffer = device.createBuffer({
      size: 16 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const vertexStage = GPUShaderStage.VERTEX;
    const renderLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vertexStage, buffer: { type: 'uniform' } },
        { binding: 1, visibility: vertexStage, buffer: { type: 'uniform' } },
        { binding: 2, visibility: vertexStage, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: vertexStage, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: vertexStage, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.renderBindGroups = [];
    for (let draw = 0; draw < DRAW_COUNT; ++draw) {
      const drawInfo = this.createBuffer(new Uint32Array([draw * ASTEROID_COUNT, 0, 0, 0]), GPUBufferUsage.UNIFORM);
      this.renderBindGroups.push(
        device.createBindGroup({
          layout: renderLayout,
          entries: [
            { binding: 0, resource: { buffer: this.viewProjectionBuffer } },
            { binding: 1, resource: { buffer: drawInfo } },
            { binding: 2, resource: { buffer: asteroidBuffer } },
            { binding: 3, resource: { buffer: visibleBuffer } },
            { binding: 4, resource: { buffer: shapeVertexBuffer } },
          ],
        }),
      );
    }
    const renderModule = device.createShaderModule({ code: RENDER_SHADER });
    this.renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [renderLayout, light.bindGroupLayout] }),
      vertex: { module: renderModule, entryPoint: 'vs_asteroid' },
      fragment: { module: renderModule, entryPoint: 'fs_asteroid', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
  }

  // Set the camera for the culling, the LOD selection, and the render pass.
  setCamera(viewProjection: Mat4, cameraPosition: Vec3): void {
    const planes = frustumPlanes(viewProjection);
    planes.forEach((plane, i) => this.updateParams.set(plane, i * 4));
    this.updateParams.set([...this.shipCenter, 0], 24);
    this.updateParams.set([...this.basis.right, 0], 28);
    this.updateParams.set([...this.basis.up, 0], 32);
    this.updateParams.set([...this.basis.heading, 0], 36);
    this.updateParams.set([...cameraPosition, 0], 40);
    this.device.queue.writeBuffer(this.viewProjectionBuffer, 0, viewProjection);
  }

  // Record the update and cull pass for a time step in seconds. speedScale multiplies FLOW_SPEED.
  // Call this before the render pass that draws the asteroids.
  update(encoder: GPUCommandEncoder, seconds: number, speedScale: number): void {
    this.updateParams.set([seconds, FLOW_SPEED * speedScale], 44);
    this.device.queue.writeBuffer(this.updateParamsBuffer, 0, this.updateParams);
    // Start each frame with no visible instances.
    this.device.queue.writeBuffer(this.drawArgsBuffer, 0, this.drawArgsTemplate);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.updatePipeline);
    pass.setBindGroup(0, this.updateBindGroup);
    pass.dispatchWorkgroups(Math.ceil(ASTEROID_COUNT / WORKGROUP_SIZE));
    pass.end();
  }

  draw(pass: RenderPassEncoder): void {
    pass.setPipeline(this.renderPipeline);
    this.light.bind(pass);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    for (let draw = 0; draw < DRAW_COUNT; ++draw) {
      pass.setBindGroup(0, this.renderBindGroups[draw]);
      pass.drawIndexedIndirect(this.drawArgsBuffer, draw * DRAW_ARGS_SIZE * Uint32Array.BYTES_PER_ELEMENT);
    }
  }

  // Run the shape shader once, to make the vertices of all shapes and LODs.
  private makeShapes(directionBuffer: GPUBuffer, shapeVertexBuffer: GPUBuffer, vertexCounts: number[]): void {
    const code = SHAPE_SHADER.replace('__VERTEX_COUNT_0__', String(vertexCounts[0])).replace(
      '__VERTEX_COUNT_1__',
      String(vertexCounts[1]),
    );
    const pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'cs_shapes' },
    });
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: directionBuffer } },
        { binding: 1, resource: { buffer: shapeVertexBuffer } },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil((ASTEROID_SHAPES * (vertexCounts[0] + vertexCounts[1])) / WORKGROUP_SIZE));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  // The start state of all asteroids, at random positions in the box and out of the clear tube.
  private makeAsteroids(): ArrayBuffer {
    const random = makeRandom(RANDOM_SEED);
    const between = (range: readonly [number, number]) => range[0] + (range[1] - range[0]) * random();
    const data = new ArrayBuffer(ASTEROID_COUNT * ASTEROID_FLOATS * 4);
    const floats = new Float32Array(data);
    const uints = new Uint32Array(data);
    const { right, up, heading } = this.basis;
    for (let i = 0; i < ASTEROID_COUNT; ++i) {
      // The cube of a random number makes small radii much more common than large radii.
      const radius = ASTEROID_RADIUS[0] * (ASTEROID_RADIUS[1] / ASTEROID_RADIUS[0]) ** (random() ** 3);
      let x = between(BOX_RIGHT);
      let y = between(BOX_UP);
      const lateral = Math.hypot(x, y);
      const minimum = CLEAR_RADIUS + radius * BOUNDING_SCALE;
      if (lateral < minimum) {
        const scale = minimum / Math.max(lateral, 1e-3);
        x *= scale;
        y *= scale;
      }
      const z = between(BOX_HEADING);
      const position = [0, 1, 2].map((axis) => this.shipCenter[axis] + right[axis] * x + up[axis] * y + heading[axis] * z);
      const velocity = [0, 1, 2].map(() => (random() * 2 - 1) * VELOCITY_SPREAD);
      // A random unit vector for the spin axis.
      const axisZ = random() * 2 - 1;
      const axisAngle = random() * 2 * Math.PI;
      const axisR = Math.sqrt(1 - axisZ * axisZ);
      // A random unit quaternion (Shoemake's method) for the start orientation.
      const [u1, u2, u3] = [random(), random(), random()];
      const orientation = [
        Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
        Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
        Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
        Math.sqrt(u1) * Math.cos(2 * Math.PI * u3),
      ];
      const base = i * ASTEROID_FLOATS;
      floats.set([...position, radius], base);
      floats.set(velocity, base + 4);
      uints[base + 7] = Math.floor(random() * ASTEROID_SHAPES);
      floats.set([axisR * Math.cos(axisAngle), axisR * Math.sin(axisAngle), axisZ, between(SPIN_SPEED)], base + 8);
      floats.set(orientation, base + 12);
    }
    return data;
  }

  // Make a GPU buffer that contains data. The size of a buffer write must be a multiple of 4 bytes.
  private createBuffer(data: ArrayBufferView | ArrayBuffer, usage: number): GPUBuffer {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const size = Math.ceil(bytes.byteLength / 4) * 4;
    const buffer = this.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    const padded = new Uint8Array(size);
    padded.set(bytes);
    this.device.queue.writeBuffer(buffer, 0, padded);
    return buffer;
  }
}
