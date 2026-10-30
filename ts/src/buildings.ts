// Reflective glass towers that move past the ship. The towers reflect their surroundings, and the
// reflections also show the reflections in other towers.
//
// The reflections come from two cube maps, A and B, around a point among the towers. In each frame:
// 1. Six passes (one for each cube face) render the surroundings into A. The towers in these passes
//    reflect B, as it was at the end of the previous frame.
// 2. Six passes render the surroundings into B. The towers in these passes reflect A.
// 3. The main pass draws the towers, which reflect B.
// Thus a frame has two levels of reflection, and each frame starts from the result of the frame
// before it, so the reflections in reflections continue to build up.
//
// All draws are in render bundles, which are recorded one time and then executed in each frame:
// one bundle for each cube face of each cube map, and one bundle for the main pass. A bundle
// keeps its bind groups, so each cube face has its own camera uniform buffer, and update()
// changes the contents of the buffers. The bundles use debug groups and debug markers, which
// show in GPU debuggers. The background of a cube face is one triangle with drawIndirect, and the
// towers are one instanced drawIndexedIndirect.
//
// The ship is not in the cube maps. Its reflections are exact mirror images instead: each frame,
// the CPU selects the tower walls (up to MAX_MIRRORS) that face the camera and the ship and are
// near the ship. One pass draws the ship mirrored through each of these walls into a reflection
// image the size of the view, with the id of the wall in a second image. The main pass of a wall
// adds the reflection image where the id is its own id, so a wall shows only its own image.
//
// The cube passes do not draw the terrain and the ship, because they are expensive. The background
// shader draws a simple version of the sky and dark ground below the horizon. All world units are
// meters.

import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { type DirectionalLight, LIGHT_WGSL } from './light.js';
import { type Mat4, type Vec3, multiply, perspective } from './mat4.js';
import {
  MIRROR_COLOR_FORMAT,
  MIRROR_DEPTH_FORMAT,
  MIRROR_FLOATS,
  MIRROR_ID_FORMAT,
  MIRROR_VIEW_FLOATS,
  type Ship,
} from './ship.js';

const TOWER_COUNT = 64;
// The ship reflections: at most MAX_MIRRORS walls, which are less than MIRROR_DISTANCE meters from
// the ship.
const MAX_MIRRORS = 48;
const MIRROR_DISTANCE = 900;
// The towers are in a band along the heading: ALONG is the range in front of and behind the ship
// center, and SIDE is the range to the right of the ship (negative values are at the far side of
// the ship from the camera). A tower that goes past the back of the band comes back at the front.
const ALONG = [-1400, 2600] as const;
const SIDE = [-1800, -120] as const;
// The first FRONT_COUNT towers are a row of tall glass towers on the far edge of the street, at
// equal intervals along the band. Their walls are near the ship, so they show its reflection.
const FRONT_COUNT = 12;
const FRONT_SIDE = [-320, -200] as const;
const FRONT_WIDTH = [120, 200] as const;
const FRONT_DEPTH = [60, 100] as const;
const FRONT_HEIGHT = [540, 640] as const;
// The heights and widths of the towers. The bottom of each tower is at TOWER_BASE, in the ground.
// Many towers are taller than the camera height (500 meters), so that their upper walls reflect the
// sky. Walls that the camera sees from above reflect the ground.
const TOWER_HEIGHT = [220, 760] as const;
const TOWER_WIDTH = [40, 120] as const;
const TOWER_BASE = -150;
// Each tower turns from the heading by an angle in this range (degrees), to the left or the right.
// A wall that is parallel to the heading shows the ship reflection directly behind the ship, where
// the ship hides it. A turned wall shows the reflection farther along the street.
const TOWER_TURN = [10, 28] as const;
const RANDOM_SEED = 112233;

// The cube maps: their size in pixels, and their center relative to the ship center (right, up,
// and heading). The center is on a street with no towers, because a tower that moves through the
// center would hide all of the surroundings, and the reflections would go dark.
const CUBE_SIZE = 256;
const CUBE_CENTER = [-500, -200, 0] as const;
const CUBE_FORMAT: GPUTextureFormat = 'rgba8unorm';
const CUBE_DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
// The sine of the angle of the horizon below the horizontal, for the background of the cube faces.
const HORIZON_SIN = 0.03;

// The center (3 floats) and reflectivity, the size (3) and an unused float, and the tint (4).
const TOWER_FLOATS = 12;
// viewProjection (16 floats), position (4), right (4), up (4), and forward (4).
const CAMERA_FLOATS = 32;

const SHADER = /* wgsl */ `
${LIGHT_WGSL}

struct Camera {
  viewProjection: mat4x4f,
  position: vec4f,
  // The directions of the screen right, the screen up, and the view, for the background.
  right: vec4f,
  up: vec4f,
  forward: vec4f,
}

struct Tower {
  // xyz: the center. w: how much the glass reflects (0 to 1).
  center: vec4f,
  // xyz: the size. w: the rotation around the vertical axis (radians).
  size: vec4f,
  tint: vec4f,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> towers: array<Tower>;
// The cube map that the towers reflect.
@group(0) @binding(2) var environment: texture_cube<f32>;
@group(0) @binding(3) var environmentSampler: sampler;

// A simple sky: yellow-brown haze, brighter near the horizon and the sun, with the sun and its
// glow. Below the horizon, dark brown ground that fades into the haze far away.
fn background(dir: vec3f) -> vec3f {
  let horizon = -${HORIZON_SIN};
  let toSun = max(dot(dir, light.direction), 0.0);
  let height = saturate((dir.y - horizon) * 2.5);
  var haze = mix(vec3f(0.82, 0.64, 0.36), vec3f(0.36, 0.25, 0.12), height) * light.color;
  haze += vec3f(0.35, 0.25, 0.1) * pow(toSun, 8.0);
  var color = haze;
  if (dir.y < horizon) {
    let ground = vec3f(0.16, 0.11, 0.07) * (light.ambient + light.color * 0.5);
    color = mix(ground, haze, exp(-(horizon - dir.y) * 12.0));
  }
  color += light.color * (smoothstep(0.99925, 0.99955, toSun) * 2.5 + pow(toSun, 300.0) * 0.9);
  return color;
}

struct BackgroundOutput {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}

@vertex
fn vs_background(@builtin(vertex_index) index: u32) -> BackgroundOutput {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: BackgroundOutput;
  output.position = vec4f(corners[index], 1.0, 1.0);
  output.clip = corners[index];
  return output;
}

// A cube face has a 90-degree field of view, so the view direction at a clip position is the
// forward direction plus the clip position along the right and up directions.
@fragment
fn fs_background(input: BackgroundOutput) -> @location(0) vec4f {
  let dir = normalize(camera.forward.xyz + camera.right.xyz * input.clip.x + camera.up.xyz * input.clip.y);
  return vec4f(background(dir), 1.0);
}

struct TowerOutput {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) normal: vec3f,
  // The position on the tower in meters, from its center, before the rotation.
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) tint: vec3f,
  @location(4) @interpolate(flat) reflectivity: f32,
  @location(5) @interpolate(flat) instance: u32,
  // The normal before the rotation.
  @location(6) localNormal: vec3f,
}

// Rotate v around the vertical axis by yaw. The local x axis goes to (cos, 0, -sin).
fn rotateYaw(v: vec3f, yaw: f32) -> vec3f {
  let c = cos(yaw);
  let s = sin(yaw);
  return vec3f(c * v.x + s * v.z, v.y, c * v.z - s * v.x);
}

@vertex
fn vs_tower(@location(0) position: vec3f, @location(1) normal: vec3f,
            @builtin(instance_index) instance: u32) -> TowerOutput {
  let tower = towers[instance];
  let local = position * tower.size.xyz;
  let world = tower.center.xyz + rotateYaw(local, tower.size.w);
  var output: TowerOutput;
  output.position = camera.viewProjection * vec4f(world, 1.0);
  output.worldPosition = world;
  output.normal = rotateYaw(normal, tower.size.w);
  output.localNormal = normal;
  output.local = local;
  output.tint = tower.tint.rgb;
  output.reflectivity = tower.center.w;
  output.instance = instance;
  return output;
}

// The color of a tower (rgb), and how much its glass reflects at this point (a). Glass panes are
// between dark frames. The glass reflects the cube map, more at grazing angles (Fresnel), and it
// shows the bright reflection of the sun.
fn shadeTower(input: TowerOutput) -> vec4f {
  let n = normalize(input.normal);
  let toCamera = normalize(camera.position.xyz - input.worldPosition);
  let reflected = reflect(-toCamera, n);
  // Sample and take the derivatives first: they must be in uniform control flow.
  let mirror = textureSample(environment, environmentSampler, reflected).rgb;
  let floorScale = fwidth(input.local.y / 4.0);
  let columnScale = max(fwidth(input.local.x / 3.0), fwidth(input.local.z / 3.0));

  // The floors are 4 meters high, and the columns are 3 meters wide. The roof has no windows.
  let across = select(input.local.x, input.local.z, abs(input.localNormal.x) > 0.5);
  let floorPosition = fract(input.local.y / 4.0);
  let columnPosition = fract(across / 3.0);
  var pane = smoothstep(0.0, 0.08, floorPosition) * smoothstep(1.0, 0.92, floorPosition)
    * smoothstep(0.0, 0.06, columnPosition) * smoothstep(1.0, 0.94, columnPosition);
  // Where a pane is smaller than approximately a pixel, the pattern changes to its average, so far
  // towers do not show moire patterns.
  let detail = saturate(1.5 - max(floorScale, columnScale) * 4.0);
  pane = mix(0.8, pane, detail);
  pane = select(pane, 0.6, n.y > 0.5);

  let fresnel = 0.55 + 0.45 * pow(1.0 - saturate(dot(n, toCamera)), 4.0);
  let glass = mix(applyLight(input.tint * 0.35, n), mirror * input.tint * 1.2, fresnel * input.reflectivity);
  let frame = applyLight(vec3f(0.12, 0.11, 0.1), n);
  var color = mix(frame, glass, pane);
  color += light.color * pow(saturate(dot(reflected, light.direction)), 400.0) * 3.0 * pane;
  return vec4f(color, fresnel * input.reflectivity * pane);
}

@fragment
fn fs_tower(input: TowerOutput) -> @location(0) vec4f {
  return vec4f(shadeTower(input).rgb, 1.0);
}

// The mirror images of the ship, and the id (plus 1) of the wall of each image. Only the main pass
// uses them.
@group(2) @binding(0) var shipImage: texture_2d<f32>;
@group(2) @binding(1) var shipImageId: texture_2d<u32>;

// The id of a wall: 4 for each tower, in the order +X, -X, +Z, and -Z of the tower before its
// rotation. The roof and the floor have no id.
fn wallId(normal: vec3f, instance: u32) -> u32 {
  var side = 4u;
  if (normal.x > 0.5) {
    side = 0u;
  } else if (normal.x < -0.5) {
    side = 1u;
  } else if (normal.z > 0.5) {
    side = 2u;
  } else if (normal.z < -0.5) {
    side = 3u;
  }
  return select(instance * 4u + side, 0xffffffffu, side == 4u);
}

@fragment
fn fs_tower_main(input: TowerOutput) -> @location(0) vec4f {
  let shaded = shadeTower(input);
  var color = shaded.rgb;
  let pixel = vec2i(input.position.xy);
  if (textureLoad(shipImageId, pixel, 0).r == wallId(input.localNormal, input.instance) + 1u) {
    // The ship is brighter than most of the environment, so its reflection is stronger and less
    // tinted than the reflection of the cube map.
    let shipColor = textureLoad(shipImage, pixel, 0).rgb * mix(input.tint, vec3f(1.0), 0.5) * 1.2;
    color = mix(color, shipColor, saturate(shaded.a * 1.5));
  }
  return vec4f(color, 1.0);
}
`;

// A unit box from -0.5 to 0.5, with the normal of each face: 4 vertices for each face, and
// triangles that are counterclockwise from the outside.
function makeBox(): { vertices: Float32Array; indices: Uint16Array } {
  const faces: [Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0]],
    [[-1, 0, 0], [0, 1, 0]],
    [[0, 0, 1], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1]],
    [[0, -1, 0], [0, 0, 1]],
  ];
  const vertices: number[] = [];
  const indices: number[] = [];
  faces.forEach(([n, v], face) => {
    // u = v x n, so u x v = n, and the corners in the order below are counterclockwise from the
    // outside.
    const u: Vec3 = [v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      vertices.push(
        ...[0, 1, 2].map((i) => (n[i] + u[i] * a + v[i] * b) * 0.5),
        ...n,
      );
    }
    const first = face * 4;
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  });
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

// The view directions of the 6 cube faces, in the order of the cube layers (+X, -X, +Y, -Y, +Z,
// -Z), with the world directions of the screen right and up of each face. These are the directions
// that the GPU uses to sample a cube map, so a face image is mirrored compared with a normal view.
const CUBE_FACES: { forward: Vec3; right: Vec3; up: Vec3; name: string }[] = [
  { forward: [1, 0, 0], right: [0, 0, -1], up: [0, 1, 0], name: '+X' },
  { forward: [-1, 0, 0], right: [0, 0, 1], up: [0, 1, 0], name: '-X' },
  { forward: [0, 1, 0], right: [1, 0, 0], up: [0, 0, -1], name: '+Y' },
  { forward: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1], name: '-Y' },
  { forward: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], name: '+Z' },
  { forward: [0, 0, -1], right: [-1, 0, 0], up: [0, 1, 0], name: '-Z' },
];

// The view matrix of a camera at eye with the given screen directions. The camera looks along
// forward, so the view-space -Z is forward.
function faceView(eye: Vec3, right: Vec3, up: Vec3, forward: Vec3): Mat4 {
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // prettier-ignore
  return new Float32Array([
    right[0], up[0], -forward[0], 0,
    right[1], up[1], -forward[1], 0,
    right[2], up[2], -forward[2], 0,
    -dot(right, eye), -dot(up, eye), dot(forward, eye), 1,
  ]);
}

// A small random number generator (mulberry32) with a fixed seed.
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

interface TowerState {
  along: number;
  side: number;
  width: number;
  depth: number;
  height: number;
  reflectivity: number;
  // The rotation around the vertical axis, in radians.
  yaw: number;
  tint: Vec3;
}

export class Buildings {
  private readonly device: Device;
  private readonly shipCenter: Vec3;
  private readonly heading: Vec3;
  private readonly right: Vec3;
  private readonly towers: TowerState[] = [];
  private readonly towerData = new Float32Array(TOWER_COUNT * TOWER_FLOATS);
  private readonly towerBuffer: GPUBuffer;
  private readonly faceCameras: GPUBuffer[];
  private readonly mainCamera: GPUBuffer;
  // The two cube maps, and a view of each layer for the render passes.
  private readonly cubeFaceViews: GPUTextureView[][];
  private readonly cubeDepthView: GPUTextureView;
  // The bundles of the cube faces: faceBundles[0] renders into A, and faceBundles[1] into B.
  private readonly faceBundles: GPURenderBundle[][];
  // The main bundle reads the ship reflection images, so it is recorded again when their size
  // changes.
  private mainBundle: GPURenderBundle | null = null;
  private readonly recordMainBundle: (reflections: GPUBindGroup) => GPURenderBundle;
  private readonly ship: Ship;
  private readonly light: DirectionalLight;
  private readonly mirrorBuffer: GPUBuffer;
  private readonly mirrorViewBuffer: GPUBuffer;
  private readonly mirrorBindGroup: GPUBindGroup;
  private readonly mirrorData = new Float32Array(MAX_MIRRORS * MIRROR_FLOATS);
  private readonly reflectionLayout: GPUBindGroupLayout;
  private reflectionTargets: { width: number; height: number; color: GPUTextureView; id: GPUTextureView; depth: GPUTextureView } | null = null;
  private readonly cubeCenter: Vec3;

  constructor(
    device: Device,
    format: TextureFormat,
    depthFormat: DepthFormat,
    light: DirectionalLight,
    shipCenter: Vec3,
    heading: Vec3,
    ship: Ship,
  ) {
    this.device = device;
    this.ship = ship;
    this.light = light;
    this.shipCenter = shipCenter;
    this.heading = heading;
    this.right = [-heading[2], 0, heading[0]];
    const offset = (i: number) => this.right[i] * CUBE_CENTER[0] + heading[i] * CUBE_CENTER[2];
    this.cubeCenter = [
      shipCenter[0] + offset(0),
      shipCenter[1] + CUBE_CENTER[1],
      shipCenter[2] + offset(2),
    ];

    const random = makeRandom(RANDOM_SEED);
    const between = (range: readonly [number, number]) => range[0] + (range[1] - range[0]) * random();
    // The yaw that puts the local x axis of a tower along the heading.
    const headingYaw = Math.atan2(-heading[2], heading[0]);
    for (let i = 0; i < TOWER_COUNT; ++i) {
      const front = i < FRONT_COUNT;
      const glass = front || random() < 0.6;
      const interval = (ALONG[1] - ALONG[0]) / FRONT_COUNT;
      const along = front ? ALONG[0] + (i + 0.3 + 0.4 * random()) * interval : between(ALONG);
      const side = between(front ? FRONT_SIDE : SIDE);
      const width = between(front ? FRONT_WIDTH : TOWER_WIDTH);
      const depth = between(front ? FRONT_DEPTH : TOWER_WIDTH);
      this.towers.push({
        along,
        side: this.awayFromStreet(side, width, depth),
        width,
        depth,
        height: between(front ? FRONT_HEIGHT : TOWER_HEIGHT),
        reflectivity: front ? 0.85 + 0.1 * random() : 0.6 + 0.35 * random(),
        yaw: headingYaw + (random() < 0.5 ? -1 : 1) * between(TOWER_TURN) * (Math.PI / 180),
        // Blue-gray glass, or bronze glass.
        tint: glass ? [0.55, 0.65, 0.75] : [0.8, 0.62, 0.42],
      });
    }

    const box = makeBox();
    const vertexBuffer = this.createBuffer(box.vertices, GPUBufferUsage.VERTEX);
    const indexBuffer = this.createBuffer(box.indices, GPUBufferUsage.INDEX);
    this.towerBuffer = device.createBuffer({
      size: this.towerData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // indexCount, instanceCount, firstIndex, baseVertex, firstInstance.
    const towerArgs = this.createBuffer(
      new Uint32Array([box.indices.length, TOWER_COUNT, 0, 0, 0]),
      GPUBufferUsage.INDIRECT,
    );
    // vertexCount, instanceCount, firstVertex, firstInstance.
    const backgroundArgs = this.createBuffer(new Uint32Array([3, 1, 0, 0]), GPUBufferUsage.INDIRECT);

    const cameraBuffer = () =>
      device.createBuffer({
        size: CAMERA_FLOATS * Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.faceCameras = CUBE_FACES.map(() => cameraBuffer());
    this.mainCamera = cameraBuffer();

    const cubes = [0, 1].map(() =>
      device.createTexture({
        size: [CUBE_SIZE, CUBE_SIZE, 6],
        format: CUBE_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    this.cubeFaceViews = cubes.map((cube) =>
      CUBE_FACES.map((_, layer) =>
        cube.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
      ),
    );
    const cubeViews = cubes.map((cube) => cube.createView({ dimension: 'cube' }));
    this.cubeDepthView = device
      .createTexture({
        size: [CUBE_SIZE, CUBE_SIZE],
        format: CUBE_DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      .createView();
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    // One bind group layout for all pipelines.
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const bindGroup = (camera: GPUBuffer, environment: GPUTextureView) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: camera } },
          { binding: 1, resource: { buffer: this.towerBuffer } },
          { binding: 2, resource: environment },
          { binding: 3, resource: sampler },
        ],
      });

    const module = device.createShaderModule({ code: SHADER });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout, light.bindGroupLayout] });
    const towerBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ],
      },
    ];
    // The cube face views are mirrored, so the triangles turn the other way. The cube pipelines
    // draw both sides of the triangles.
    const towerPipeline = (target: GPUTextureFormat, depth: GPUTextureFormat, cullMode: GPUCullMode) =>
      device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_tower', buffers: towerBuffers },
        fragment: { module, entryPoint: 'fs_tower', targets: [{ format: target }] },
        primitive: { topology: 'triangle-list', cullMode },
        depthStencil: { format: depth, depthWriteEnabled: true, depthCompare: 'less' },
      });
    const cubeTowerPipeline = towerPipeline(CUBE_FORMAT, CUBE_DEPTH_FORMAT, 'none');
    // The main pipeline also reads the ship reflection images (group 2).
    this.reflectionLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
      ],
    });
    const mainTowerPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, light.bindGroupLayout, this.reflectionLayout] }),
      vertex: { module, entryPoint: 'vs_tower', buffers: towerBuffers },
      fragment: { module, entryPoint: 'fs_tower_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });

    // The ship reflections: the walls (mirrors), and the camera of the main view.
    this.mirrorBuffer = device.createBuffer({
      size: this.mirrorData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.mirrorViewBuffer = device.createBuffer({
      size: MIRROR_VIEW_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.mirrorBindGroup = device.createBindGroup({
      layout: ship.mirrorBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.mirrorViewBuffer } },
        { binding: 1, resource: { buffer: this.mirrorBuffer } },
      ],
    });
    const backgroundPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_background' },
      fragment: { module, entryPoint: 'fs_background', targets: [{ format: CUBE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
      // The background is at the far plane, and it does not write depth.
      depthStencil: { format: CUBE_DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less-equal' },
    });

    // Record the draws of the towers in a bundle, with a debug group and a debug marker.
    const drawTowers = (encoder: GPURenderBundleEncoder, pipeline: GPURenderPipeline, marker: string) => {
      encoder.pushDebugGroup('Towers');
      encoder.insertDebugMarker(marker);
      encoder.setPipeline(pipeline);
      encoder.setVertexBuffer(0, vertexBuffer);
      encoder.setIndexBuffer(indexBuffer, 'uint16');
      encoder.drawIndexedIndirect(towerArgs, 0);
      encoder.popDebugGroup();
    };

    // The cube faces: the background, then the towers. The towers in A reflect B, and the towers in
    // B reflect A.
    this.faceBundles = [0, 1].map((target) =>
      CUBE_FACES.map((face, index) => {
        const encoder = device.createRenderBundleEncoder({
          colorFormats: [CUBE_FORMAT],
          depthStencilFormat: CUBE_DEPTH_FORMAT,
        });
        encoder.pushDebugGroup(`Cube ${target === 0 ? 'A' : 'B'} face ${face.name}`);
        encoder.setBindGroup(0, bindGroup(this.faceCameras[index], cubeViews[1 - target]));
        light.bind(encoder);
        encoder.pushDebugGroup('Background');
        encoder.setPipeline(backgroundPipeline);
        encoder.drawIndirect(backgroundArgs, 0);
        encoder.popDebugGroup();
        drawTowers(encoder, cubeTowerPipeline, `Reflect cube ${target === 0 ? 'B' : 'A'}`);
        encoder.popDebugGroup();
        return encoder.finish();
      }),
    );

    // The main pass: the towers reflect B, and the walls add the mirror images of the ship.
    const mainBindGroup = bindGroup(this.mainCamera, cubeViews[1]);
    this.recordMainBundle = (reflections) => {
      const encoder = device.createRenderBundleEncoder({ colorFormats: [format], depthStencilFormat: depthFormat });
      encoder.setBindGroup(0, mainBindGroup);
      light.bind(encoder);
      encoder.setBindGroup(2, reflections);
      drawTowers(encoder, mainTowerPipeline, 'Reflect cube B and the ship');
      return encoder.finish();
    };
  }

  // Move the towers back along the heading to scroll (in meters, from the start), set the camera,
  // and record the passes of the cube maps and of the ship reflections. width and height are the
  // size of the view in pixels.
  update(
    encoder: GPUCommandEncoder,
    scroll: number,
    viewProjection: Mat4,
    cameraPosition: Vec3,
    width: number,
    height: number,
  ): void {
    const length = ALONG[1] - ALONG[0];
    this.towers.forEach((tower, i) => {
      const along = ALONG[0] + ((((tower.along - scroll - ALONG[0]) % length) + length) % length);
      // The tower goes from TOWER_BASE up to its height, so its center is halfway.
      const center = [
        this.shipCenter[0] + this.heading[0] * along + this.right[0] * tower.side,
        (TOWER_BASE + tower.height) / 2,
        this.shipCenter[2] + this.heading[2] * along + this.right[2] * tower.side,
      ];
      const size = [tower.width, tower.height - TOWER_BASE, tower.depth];
      this.towerData.set([...center, tower.reflectivity, ...size, tower.yaw, ...tower.tint, 0], i * TOWER_FLOATS);
    });
    this.device.queue.writeBuffer(this.towerBuffer, 0, this.towerData);

    const projection = perspective(Math.PI / 2, 1, 2, 8000);
    CUBE_FACES.forEach((face, index) => {
      const data = new Float32Array(CAMERA_FLOATS);
      data.set(multiply(projection, faceView(this.cubeCenter, face.right, face.up, face.forward)), 0);
      data.set([...this.cubeCenter, 0, ...face.right, 0, ...face.up, 0, ...face.forward, 0], 16);
      this.device.queue.writeBuffer(this.faceCameras[index], 0, data);
    });
    const main = new Float32Array(CAMERA_FLOATS);
    main.set(viewProjection, 0);
    main.set([...cameraPosition, 0], 16);
    this.device.queue.writeBuffer(this.mainCamera, 0, main);

    // Render A, then B. Each pass executes the bundle of its face.
    for (let target = 0; target < 2; ++target) {
      for (let face = 0; face < CUBE_FACES.length; ++face) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: this.cubeFaceViews[target][face], loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' },
          ],
          depthStencilAttachment: {
            view: this.cubeDepthView,
            depthClearValue: 1,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
          },
        });
        pass.executeBundles([this.faceBundles[target][face]]);
        pass.end();
      }
    }

    this.renderShipReflections(encoder, viewProjection, cameraPosition, width, height);
  }

  // Draw the towers in the main pass.
  draw(pass: RenderPassEncoder): void {
    if (this.mainBundle) {
      pass.executeBundles([this.mainBundle]);
    }
  }

  // Select the walls that reflect the ship, and draw the mirror images of the ship.
  private renderShipReflections(
    encoder: GPUCommandEncoder,
    viewProjection: Mat4,
    cameraPosition: Vec3,
    width: number,
    height: number,
  ): void {
    const targets = this.reflectionTargetsFor(width, height);
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const walls: { distance: number; values: number[] }[] = [];
    for (let i = 0; i < TOWER_COUNT; ++i) {
      const base = i * TOWER_FLOATS;
      const center = [this.towerData[base], this.towerData[base + 1], this.towerData[base + 2]];
      const size = [this.towerData[base + 4], this.towerData[base + 5], this.towerData[base + 6]];
      // The local x and z axes of the tower after its rotation, as rotateYaw() in the shader.
      const yaw = this.towerData[base + 7];
      const axisX: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const axisZ: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)];
      const negate = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
      // The four walls: +X, -X, +Z, and -Z, as in the wall ids of the shader.
      const sides: [Vec3, number, Vec3, number][] = [
        [axisX, size[0] / 2, axisZ, size[2] / 2],
        [negate(axisX), size[0] / 2, axisZ, size[2] / 2],
        [axisZ, size[2] / 2, axisX, size[0] / 2],
        [negate(axisZ), size[2] / 2, axisX, size[0] / 2],
      ];
      sides.forEach(([normal, offset, sideU, halfU], side) => {
        const wallCenter = [0, 1, 2].map((k) => center[k] + normal[k] * offset);
        const toCamera = [0, 1, 2].map((k) => cameraPosition[k] - wallCenter[k]);
        const toShip = [0, 1, 2].map((k) => this.shipCenter[k] - wallCenter[k]);
        const distance = Math.hypot(toShip[0], toShip[1], toShip[2]);
        if (dot(normal, toCamera) <= 0 || dot(normal, toShip) <= 0 || distance > MIRROR_DISTANCE) {
          return;
        }
        const d = dot(normal, wallCenter);
        const [nx, ny, nz] = normal;
        // The reflection through the plane: I - 2 n n^T, and a translation of 2 d n.
        // prettier-ignore
        const matrix = [
          1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * nz, 0,
          -2 * nx * ny, 1 - 2 * ny * ny, -2 * ny * nz, 0,
          -2 * nx * nz, -2 * ny * nz, 1 - 2 * nz * nz, 0,
          2 * d * nx, 2 * d * ny, 2 * d * nz, 1,
        ];
        walls.push({
          distance,
          values: [
            ...matrix,
            ...normal, d,
            ...wallCenter, i * 4 + side,
            ...sideU, halfU,
            0, 1, 0, size[1] / 2,
          ],
        });
      });
    }
    walls.sort((a, b) => a.distance - b.distance);
    const count = Math.min(walls.length, MAX_MIRRORS);
    for (let i = 0; i < count; ++i) {
      this.mirrorData.set(walls[i].values, i * MIRROR_FLOATS);
    }
    if (count > 0) {
      this.device.queue.writeBuffer(this.mirrorBuffer, 0, this.mirrorData, 0, count * MIRROR_FLOATS);
    }
    const view = new Float32Array(MIRROR_VIEW_FLOATS);
    view.set(viewProjection, 0);
    view.set([...cameraPosition, 0], 16);
    this.device.queue.writeBuffer(this.mirrorViewBuffer, 0, view);

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: targets.color, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' },
        { view: targets.id, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' },
      ],
      depthStencilAttachment: { view: targets.depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    this.ship.drawMirrored(pass, this.mirrorBindGroup, count);
    pass.end();
  }

  // The reflection images of the ship, with the size of the view. A new size makes new images and
  // records the main bundle again.
  private reflectionTargetsFor(width: number, height: number) {
    if (!this.reflectionTargets || this.reflectionTargets.width !== width || this.reflectionTargets.height !== height) {
      const texture = (format: GPUTextureFormat, usage: number) =>
        this.device.createTexture({ size: [width, height], format, usage }).createView();
      const sampled = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      const color = texture(MIRROR_COLOR_FORMAT, sampled);
      const id = texture(MIRROR_ID_FORMAT, sampled);
      const depth = texture(MIRROR_DEPTH_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT);
      this.reflectionTargets = { width, height, color, id, depth };
      const reflections = this.device.createBindGroup({
        layout: this.reflectionLayout,
        entries: [
          { binding: 0, resource: color },
          { binding: 1, resource: id },
        ],
      });
      this.mainBundle = this.recordMainBundle(reflections);
    }
    return this.reflectionTargets;
  }

  // Move a tower out of the street of the cube center. The towers turn by at most TOWER_TURN from
  // the heading, so the size of a tower across the street is less than 0.75 of its largest side.
  private awayFromStreet(side: number, width: number, depth: number): number {
    const clearance = 0.75 * Math.max(width, depth) + 40;
    const offset = side - CUBE_CENTER[0];
    if (Math.abs(offset) >= clearance) {
      return side;
    }
    return CUBE_CENTER[0] + (offset < 0 ? -clearance : clearance);
  }

  // Make a GPU buffer that contains data.
  private createBuffer(data: ArrayBufferView, usage: number): GPUBuffer {
    const size = Math.ceil(data.byteLength / 4) * 4;
    const buffer = this.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    const padded = new Uint8Array(size);
    padded.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    this.device.queue.writeBuffer(buffer, 0, padded);
    return buffer;
  }
}
