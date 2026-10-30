// The LunarG ship: a glTF model with engine flames that ignite, run, and shut down.
// All world units are meters. In the model, +Y is up and +Z is the front of the ship.
//
// Solid parts use the shared sun. The flames are unlit: they use their vertex colors and
// additive blending, as lunarg-ship/viewer.html does. While the engines run, one point light
// behind each engine flickers and lights the solid parts of the ship. The engine lights do not
// light other objects. A glow sprite at each engine light gives a bloom effect: it is a quad that
// faces the camera and adds a soft halo of the light color.

import { type GltfAnimation, type GltfModel, type GltfPrimitive, sampleChannel } from './gltf.js';
import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { type DirectionalLight, LIGHT_WGSL } from './light.js';
import { type Mat4, type Quat, type Vec3, compose, invert, multiply, transformPoint } from './mat4.js';
import { NOISE_WGSL } from './noise.js';

// The animation names and the flame root node name, from lunarg-ship/README.md.
const IGNITE_ANIMATION = 'EnginesIgnite';
const RUNNING_ANIMATION = 'EnginesRunning';
const SHUTDOWN_ANIMATION = 'EnginesShutdown';
const FLAME_ROOT_NODE = 'EngineL_Flames';
// Each node with a name that ends with this text is the flame root of one engine. Its parent is
// the engine node.
const FLAME_ROOT_SUFFIX = '_Flames';

// The engine lights, from lunarg-ship/viewer.html: an orange light 2.5 m behind each nozzle, in
// the coordinates of the engine node. The strength follows the flame size, so the light fades in
// when the engines ignite and fades out when they shut down.
// At ENGINE_LIGHT_REFERENCE meters the light has half of ENGINE_LIGHT_INTENSITY, and at
// ENGINE_LIGHT_RANGE meters it has none. The ship is approximately 50 m long, so a reference
// distance of 30 m keeps much of the light across the whole ship.
// The flicker is the product of two sine waves of ENGINE_LIGHT_FLICKER_RATES (radians per second),
// so it does not repeat in a short regular pattern. ENGINE_LIGHT_FLICKER is the amplitude.
const ENGINE_LIGHT_COUNT = 2;
const ENGINE_LIGHT_OFFSET = [0, 0, -2.5] as const;
const ENGINE_LIGHT_COLOR = [1.0, 0.6, 0.25] as const;
const ENGINE_LIGHT_INTENSITY = 3.0;
const ENGINE_LIGHT_REFERENCE = 30;
const ENGINE_LIGHT_RANGE = 50;
const ENGINE_LIGHT_FLICKER = 0.3;
const ENGINE_LIGHT_FLICKER_RATES = [37, 23] as const;

// The glow sprite of each engine light. GLOW_RADIUS is the half width of the quad in meters.
// The quad moves GLOW_PULL meters from the light toward the camera, so that it does not cut into
// the engine. The glow has the flicker and the fade of the light.
const GLOW_RADIUS = 13;
const GLOW_PULL = 6;
const GLOW_BRIGHTNESS = 0.9;

// Re-entry heating. setHeat() sets the level from 0 to 1. The hull surfaces that face forward glow,
// from orange to white. A heat shell, the hull moved HEAT_SHELL meters out along its normals (more
// at the front, and stretched back by HEAT_TRAIL), adds a glowing bow shock around the outline of
// the ship. The shell draws only its back faces, so the ship hides the shell, except at the outline.
// The glow is brightest near the hull and fades to 0 at the outer edge of the shell.
const HEAT_SHELL = 1.5;
const HEAT_SHELL_FRONT = 5;
const HEAT_TRAIL = 3;
const HEAT_SHELL_BRIGHTNESS = 0.45;

// Plasma streaks of the re-entry. Each streak starts at a random point on the surface of a solid
// part of the ship (the hull, the pylon, or an engine), where the normal points forward or to the
// side by more than STREAK_FRONT, and goes back along the flow. A streak is a ribbon that faces the
// camera and gets wider toward its end. Its brightness moves along it with noise, so the plasma
// seems to flow. The color goes from almost white at the ship, through pink and orange, to violet
// at the end. Streaks at the outline of the ship, as the camera sees it, are brightest. Streaks over
// the body have STREAK_BODY_BRIGHTNESS of that brightness, so they do not hide the body.
const HULL_NODE = 'Hull';
// The streaks are only an accent of the large flame of the scene: each streak shows only at random
// times.
const STREAK_COUNT = 160;
// The light of the re-entry fire on the ship, at full heat: orange, strongest on the surfaces that
// face back into the flame, and it flickers.
const FIRE_LIGHT = [1.0, 0.42, 0.12] as const;
const FIRE_LIGHT_STRENGTH = 1.3;
const STREAK_FRONT = -0.05;
const STREAK_BODY_BRIGHTNESS = 0.3;
const STREAK_LENGTH = [25, 75] as const;
const STREAK_WIDTH = [0.6, 2.2] as const;
const STREAK_SPEED = [2, 5] as const;
const STREAK_BRIGHTNESS = 0.4;
const STREAK_SEED = 9031;
// The local position (3 floats), local normal (3), and length, width, seed, and speed (4).
const STREAK_FLOATS = 10;

// The uniform with the effects of the whole ship: the engine lights, the heat, and the camera.
// The ship shader and the glow shader both use it.
const SHIP_EFFECTS_WGSL = /* wgsl */ `
const ENGINE_LIGHT_COUNT: u32 = ${ENGINE_LIGHT_COUNT}u;
const ENGINE_LIGHT_INTENSITY: f32 = ${ENGINE_LIGHT_INTENSITY};

struct EngineLight {
  // The world position of the light. w is not used.
  position: vec4f,
  // The color multiplied by the current strength. It is 0 when the engines are off.
  color: vec4f,
}

struct ShipEffects {
  lights: array<EngineLight, ENGINE_LIGHT_COUNT>,
  // xyz is the world direction of the ship front, and w is the heat level (0 to 1).
  heat: vec4f,
  // The camera position. w is the time in seconds, for the plasma streaks.
  camera: vec4f,
  viewProjection: mat4x4f,
}
@group(0) @binding(1) var<uniform> effects: ShipEffects;

// The color of hot metal and plasma: orange, then yellow, then white.
fn heatColor(level: f32) -> vec3f {
  let t = saturate(level);
  return mix(mix(vec3f(1.0, 0.22, 0.04), vec3f(1.0, 0.65, 0.2), saturate(t * 2.0)),
             vec3f(1.0, 0.95, 0.85), saturate(t * 2.0 - 1.0));
}
`;
// The engine lights (8 floats each), heat (4), camera (4), and viewProjection (16).
const SHIP_EFFECTS_FLOATS = ENGINE_LIGHT_COUNT * 8 + 24;

const GLOW_SHADER = /* wgsl */ `
${SHIP_EFFECTS_WGSL}
const GLOW_RADIUS: f32 = ${GLOW_RADIUS}.0;
const GLOW_PULL: f32 = ${GLOW_PULL}.0;
const GLOW_BRIGHTNESS: f32 = ${GLOW_BRIGHTNESS};

struct GlowUniforms {
  viewProjection: mat4x4f,
  // The camera position and the world directions of the camera right and up. w is not used.
  cameraPosition: vec4f,
  cameraRight: vec4f,
  cameraUp: vec4f,
}
@group(0) @binding(0) var<uniform> glow: GlowUniforms;

struct GlowOutput {
  @builtin(position) position: vec4f,
  // The position in the quad, from -1 to 1 on each axis.
  @location(0) corner: vec2f,
  @location(1) color: vec3f,
}

// Six vertices for each instance: two triangles of the quad of engine light instance_index.
@vertex
fn vs_glow(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> GlowOutput {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
  let light = effects.lights[index];
  let toCamera = normalize(glow.cameraPosition.xyz - light.position.xyz);
  let center = light.position.xyz + toCamera * GLOW_PULL;
  let world = center + (glow.cameraRight.xyz * corner.x + glow.cameraUp.xyz * corner.y) * GLOW_RADIUS;
  var output: GlowOutput;
  output.position = glow.viewProjection * vec4f(world, 1.0);
  output.corner = corner;
  // The light color includes the strength, the fade, and the flicker.
  output.color = light.color.rgb / ENGINE_LIGHT_INTENSITY;
  return output;
}

// A bright core and a wide soft halo. Both are 0 at the edge of the quad.
@fragment
fn fs_glow(input: GlowOutput) -> @location(0) vec4f {
  let r2 = dot(input.corner, input.corner);
  let edge = saturate(1.0 - r2);
  let shape = (exp(-r2 * 30.0) * 1.5 + exp(-r2 * 5.0) * 0.6) * edge * edge;
  return vec4f(input.color * shape * GLOW_BRIGHTNESS, 0.0);
}
`;

// The flame colors are multiplied by this value. The viewer uses HDR colors and bloom to make
// the flames glow. This renderer has no HDR, so a smaller value keeps more of the color.
// This is the brightness during a boost. Outside a boost, see BOOST_BASE_LEVEL.
const FLAME_BRIGHTNESS = 1.5;

// The engine boost. setBoost() turns the boost on and off. The boost works only while the engines
// run.
// Outside a boost, the flames, the engine lights, and the glow have BOOST_BASE_LEVEL of their full
// brightness. During a boost, they have full brightness, and the flames are BOOST_FLAME_LENGTH
// times longer. The boost level goes from 0 to 1 in BOOST_RISE_TIME seconds, and from 1 to 0 in
// BOOST_FALL_TIME seconds, so the change is smooth.
const BOOST_RISE_TIME = 0.4;
const BOOST_FALL_TIME = 1.2;
const BOOST_BASE_LEVEL = 0.5;
const BOOST_FLAME_LENGTH = 1.6;
// A mesh with a world scale smaller than this is not drawn. The flames have a scale of 0.0001
// when the engines are off.
const MIN_DRAW_SCALE = 0.001;

// Morph target positions are offsets from the base positions. A primitive can have at most
// MAX_MORPH_TARGETS targets. Primitives with fewer targets use zero offsets.
const MAX_MORPH_TARGETS = 2;

const SHADER = /* wgsl */ `
${LIGHT_WGSL}
${NOISE_WGSL}
${SHIP_EFFECTS_WGSL}
const FLAME_BRIGHTNESS: f32 = ${FLAME_BRIGHTNESS};
const ENGINE_LIGHT_REFERENCE: f32 = ${ENGINE_LIGHT_REFERENCE}.0;
const ENGINE_LIGHT_RANGE: f32 = ${ENGINE_LIGHT_RANGE}.0;

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
  @location(1) worldPosition: vec3f,
}

// The diffuse light from the engine lights. The light falls off with distance, and it is 0 at
// ENGINE_LIGHT_RANGE. The engine lights do not cast shadows.
fn engineLighting(worldPosition: vec3f, normal: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0u; i < ENGINE_LIGHT_COUNT; i++) {
    let toLight = effects.lights[i].position.xyz - worldPosition;
    let dist = length(toLight);
    let diffuse = max(dot(normal, toLight / dist), 0.0);
    let falloff = 1.0 / (1.0 + (dist * dist) / (ENGINE_LIGHT_REFERENCE * ENGINE_LIGHT_REFERENCE));
    let window = saturate(1.0 - pow(dist / ENGINE_LIGHT_RANGE, 4.0));
    sum += effects.lights[i].color.rgb * diffuse * falloff * window * window;
  }
  return sum;
}

// The model matrix has only rotation, translation, and uniform scale, so it can also
// transform the normals.
@vertex
fn vs_lit(@location(0) position: vec3f, @location(1) normal: vec3f) -> LitOutput {
  var output: LitOutput;
  output.position = draw.mvp * vec4f(position, 1.0);
  output.worldNormal = (draw.model * vec4f(normal, 0.0)).xyz;
  output.worldPosition = (draw.model * vec4f(position, 1.0)).xyz;
  return output;
}

@fragment
fn fs_lit(input: LitOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);
  let engineLight = draw.baseColor.rgb * engineLighting(input.worldPosition, normal);
  // Re-entry heating: the surfaces that face forward glow.
  let facing = saturate(dot(normal, effects.heat.xyz));
  let glow = effects.heat.w * pow(facing, 1.5) * 1.6;
  let heat = heatColor(glow) * glow;
  // The fire around the ship lights it. The light wraps around the ship, and it is strongest on the
  // surfaces that face back into the flame.
  let time = effects.camera.w;
  let flicker = 0.8 + 0.2 * sin(time * 23.0) * sin(time * 37.0 + 1.3);
  let wrap = 0.35 + 0.65 * saturate(dot(normal, -effects.heat.xyz) * 0.5 + 0.5);
  let fireColor = vec3f(${FIRE_LIGHT.join(', ')}) * ${FIRE_LIGHT_STRENGTH};
  let fire = draw.baseColor.rgb * fireColor * effects.heat.w * flicker * wrap;
  return vec4f(applyLight(draw.baseColor.rgb, normal) + engineLight + heat + fire, draw.baseColor.a);
}

struct HeatOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) worldPosition: vec3f,
  @location(2) front: f32,
}

// The heat shell: the hull moved out along its normals, more at the front. The back of the shell
// is stretched back, as the hot gas flows past the ship.
@vertex
fn vs_heat(@location(0) position: vec3f, @location(1) normal: vec3f) -> HeatOutput {
  let worldNormal = normalize((draw.model * vec4f(normal, 0.0)).xyz);
  let forward = effects.heat.xyz;
  let front = saturate(dot(worldNormal, forward));
  let back = saturate(-dot(worldNormal, forward));
  let world = (draw.model * vec4f(position, 1.0)).xyz + worldNormal * (${HEAT_SHELL} + ${HEAT_SHELL_FRONT}.0 * front)
    - forward * ${HEAT_TRAIL}.0 * back;
  var output: HeatOutput;
  output.position = effects.viewProjection * vec4f(world, 1.0);
  output.worldNormal = worldNormal;
  output.worldPosition = world;
  output.front = front;
  return output;
}

// The back faces of the shell face away from the camera. Where they face directly away, the shell
// is behind the hull or near it, and the glow is bright. At the outer edge of the shell, the view is
// along its surface, and the glow is 0, so the edge is soft. The front of the shell is brightest.
@fragment
fn fs_heat(input: HeatOutput) -> @location(0) vec4f {
  let toCamera = normalize(effects.camera.xyz - input.worldPosition);
  let facing = abs(dot(normalize(input.worldNormal), toCamera));
  let level = effects.heat.w * pow(facing, 2.5) * (0.15 + 0.85 * input.front);
  return vec4f(heatColor(level * 1.4) * level * ${HEAT_SHELL_BRIGHTNESS}, 0.0);
}

struct StreakOutput {
  @builtin(position) position: vec4f,
  // 0 at the hull and 1 at the end of the streak.
  @location(0) along: f32,
  // -1 to 1 across the streak.
  @location(1) across: f32,
  @location(2) @interpolate(flat) seed: f32,
  @location(3) @interpolate(flat) speed: f32,
  // The brightness of the streak, from its start point: 1 at the outline of the hull.
  @location(4) @interpolate(flat) weight: f32,
}

// Six vertices for each streak instance: two triangles of the ribbon. The model matrix of the hull
// moves the start point with the ship.
@vertex
fn vs_streak(@builtin(vertex_index) vertex: u32, @location(0) localPosition: vec3f,
             @location(1) localNormal: vec3f, @location(2) params: vec4f) -> StreakOutput {
  var corners = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
  let normal = normalize((draw.model * vec4f(localNormal, 0.0)).xyz);
  let back = -effects.heat.xyz;
  let heat = effects.heat.w;
  let streakLength = params.x * (0.5 + 0.5 * heat);
  // The streak starts a little out from the hull, goes back, and also moves out from the hull, as
  // the gas flows around the ship.
  let start = (draw.model * vec4f(localPosition, 1.0)).xyz + normal * 0.5;
  var point = start + back * streakLength * corner.x + normal * streakLength * corner.x * 0.15;
  let toCamera = normalize(effects.camera.xyz - point);
  let side = normalize(cross(back, toCamera));
  let outline = 1.0 - abs(dot(normal, normalize(effects.camera.xyz - start)));
  point += side * params.y * (1.0 + corner.x * 2.0) * corner.y;
  var output: StreakOutput;
  output.position = effects.viewProjection * vec4f(point, 1.0);
  output.along = corner.x;
  output.across = corner.y;
  output.seed = params.z;
  output.speed = params.w;
  // Each streak shows only at random times, from noise over time.
  let shown = saturate((perlin3(vec3f(effects.camera.w * 0.5, params.z, 0.5), 901u) + 0.05) * 4.0);
  output.weight = mix(${STREAK_BODY_BRIGHTNESS}, 1.0, outline * outline) * shown;
  return output;
}

@fragment
fn fs_streak(input: StreakOutput) -> @location(0) vec4f {
  let time = effects.camera.w;
  let flow = perlin3(vec3f(input.along * 7.0 - time * input.speed, input.across * 1.2, input.seed), 900u);
  let edge = 1.0 - input.across * input.across;
  let fade = pow(1.0 - input.along, 1.4) * smoothstep(0.0, 0.04, input.along);
  let level = effects.heat.w * input.weight * edge * fade * saturate(0.55 + flow) * ${STREAK_BRIGHTNESS};
  let hot = vec3f(1.0, 0.88, 0.95);
  let middle = vec3f(1.0, 0.45, 0.3);
  let cool = vec3f(0.55, 0.35, 1.0);
  let color = mix(mix(hot, middle, saturate(input.along * 2.5)), cool, saturate(input.along * 1.6 - 0.4));
  return vec4f(color * level, 0.0);
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
// viewProjection (16 floats), cameraPosition (4), cameraRight (4), cameraUp (4).
const GLOW_UNIFORM_FLOATS = 28;

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
  const buffer = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
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
  // For each engine: the flame root node and the engine node (its parent).
  private readonly engines: { flameRoot: number; engine: number }[];
  private readonly engineLightBuffer: Buffer;
  private readonly glowUniformBuffer: Buffer;
  private readonly glowBindGroup: BindGroup;
  private readonly glowPipeline: RenderPipeline;
  private readonly heatPipeline: RenderPipeline;
  private readonly streakPipeline: RenderPipeline;
  private readonly streakBuffer: Buffer;
  // The draw of the hull. The streaks use its bind group, for the model matrix of the hull.
  private hullItem: DrawItem | null = null;
  // From 0 (no heating) to 1 (full re-entry heating).
  private heat = 0;
  private cameraPosition: Vec3 = [0, 0, 0];
  // Two vec4f for each engine light: position and color.
  private readonly engineLightData = new Float32Array(SHIP_EFFECTS_FLOATS);
  // The time in seconds since the ship was made. The flicker uses it.
  private clock = 0;
  // True when the boost is on. The boost level moves toward 1 when it is on, and toward 0 when it
  // is off.
  private boostOn = false;
  // From 0 (no boost) to 1 (full boost).
  private boost = 0;
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

    this.engines = [];
    model.nodes.forEach((node, index) => {
      if (node.name.endsWith(FLAME_ROOT_SUFFIX)) {
        const engine = model.nodes.findIndex((parent) => parent.children.includes(index));
        if (engine >= 0) {
          this.engines.push({ flameRoot: index, engine });
        }
      }
    });
    if (this.engines.length !== ENGINE_LIGHT_COUNT) {
      throw new Error(`The ship model must have ${ENGINE_LIGHT_COUNT} engines with flame roots`);
    }
    this.engineLightBuffer = device.createBuffer({
      size: this.engineLightData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const drawLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        // The heat shell reads the effects in its vertex shader.
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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

    // The glow sprites add light, and they do not write depth.
    const glowLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    this.glowUniformBuffer = device.createBuffer({
      size: GLOW_UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.glowBindGroup = device.createBindGroup({
      layout: glowLayout,
      entries: [
        { binding: 0, resource: { buffer: this.glowUniformBuffer } },
        { binding: 1, resource: { buffer: this.engineLightBuffer } },
      ],
    });
    const glowModule = device.createShaderModule({ code: GLOW_SHADER });
    this.glowPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [glowLayout] }),
      vertex: { module: glowModule, entryPoint: 'vs_glow' },
      fragment: {
        module: glowModule,
        entryPoint: 'fs_glow',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });

    // The heat shell adds light, and it does not write depth. It culls front faces, so that only
    // its back faces draw, and the ship hides them except at its outline.
    // The plasma streaks are instances: one start point and its parameters for each streak.
    this.streakBuffer = createBuffer(device, this.makeStreaks(model), GPUBufferUsage.VERTEX);
    this.streakPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_streak',
        buffers: [
          {
            arrayStride: STREAK_FLOATS * Float32Array.BYTES_PER_ELEMENT,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_streak',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });

    this.heatPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_heat', buffers: litBuffers },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_heat',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'front' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });

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
        const vertex = GPUBufferUsage.VERTEX;
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
          indexBuffer: createBuffer(device, primitive.indices, GPUBufferUsage.INDEX),
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
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const item: DrawItem = {
          node: nodeIndex,
          primitive,
          gpuPrimitive: gpuPrimitiveFor(primitive),
          pipeline: pipelineFor(primitive),
          uniformBuffer,
          bindGroup: device.createBindGroup({
            layout: drawLayout,
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: { buffer: this.engineLightBuffer } },
            ],
          }),
        };
        (primitive.material.blend ? this.blendedItems : this.opaqueItems).push(item);
        if (node.name === HULL_NODE && !this.hullItem) {
          this.hullItem = item;
        }
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

  // Set the camera. The glow sprites need the view matrix to face the camera.
  setCamera(view: Mat4, projection: Mat4): void {
    this.viewProjection = multiply(projection, view);
    // The rows of the view rotation are the camera right, up, and back directions, and the
    // translation is -rotation * cameraPosition.
    const t = [view[12], view[13], view[14]];
    const cameraPosition = [0, 1, 2].map(
      (i) => -(view[i * 4] * t[0] + view[i * 4 + 1] * t[1] + view[i * 4 + 2] * t[2]),
    );
    const glowData = new Float32Array(GLOW_UNIFORM_FLOATS);
    glowData.set(this.viewProjection, 0);
    glowData.set([...cameraPosition, 0], 16);
    glowData.set([view[0], view[4], view[8], 0], 20);
    glowData.set([view[1], view[5], view[9], 0], 24);
    this.device.queue.writeBuffer(this.glowUniformBuffer, 0, glowData);
    this.cameraPosition = [cameraPosition[0], cameraPosition[1], cameraPosition[2]];
  }

  // Set the re-entry heating level, from 0 (none) to 1 (full).
  setHeat(level: number): void {
    this.heat = Math.max(0, Math.min(1, level));
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

  // The engine boost level, from 0 (no boost) to 1 (full boost). The scene can use it, for
  // example to change the speed of the terrain.
  get boostLevel(): number {
    return this.boost;
  }

  // Turn the engine boost on or off. The boost level changes smoothly.
  setBoost(on: boolean): void {
    this.boostOn = on;
  }

  // Set the engines on or off at once, with no ignition or shutdown animation. A running engine
  // starts at full flame size.
  resetEngines(on: boolean): void {
    this.engineState = on ? 'running' : 'off';
    this.igniteTime = this.ignite.duration;
    this.runningTime = 0;
    this.updatePose();
  }

  // Advance the animations by a time step in seconds.
  update(seconds: number): void {
    this.clock += seconds;
    this.updateBoost(seconds);
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
    this.writeEngineLights();
    const brightness = this.boostBrightness();
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
      // The boost changes the brightness of the unlit flame materials.
      const [r, g, b, a] = item.primitive.material.baseColor;
      const scale = item.primitive.material.unlit ? brightness : 1;
      this.uniformData.set([r * scale, g * scale, b * scale, a], 32);
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

    // The heat shell of each solid part. The uniforms of these parts are already set.
    if (this.heat > 0.001) {
      pass.setPipeline(this.heatPipeline);
      for (const item of this.opaqueItems) {
        if (item.primitive.material.unlit) {
          continue;
        }
        const { vertexBuffers, indexBuffer, indexFormat, indexCount } = item.gpuPrimitive;
        pass.setBindGroup(0, item.bindGroup);
        vertexBuffers.forEach((buffer, slot) => pass.setVertexBuffer(slot, buffer));
        pass.setIndexBuffer(indexBuffer, indexFormat);
        pass.drawIndexed(indexCount);
      }
    }

    // The plasma streaks of the re-entry.
    if (this.heat > 0.001 && this.hullItem) {
      pass.setPipeline(this.streakPipeline);
      pass.setBindGroup(0, this.hullItem.bindGroup);
      pass.setVertexBuffer(0, this.streakBuffer);
      pass.draw(6, STREAK_COUNT);
    }

    // The glow sprites go last, so that the depth test hides them behind all ship surfaces.
    // When the engines are off, the light color is 0, so the sprites add nothing.
    if (this.engineState !== 'off') {
      pass.setPipeline(this.glowPipeline);
      pass.setBindGroup(0, this.glowBindGroup);
      pass.draw(6, ENGINE_LIGHT_COUNT);
    }
  }

  // Put each engine light behind its nozzle, and set its color from the flame size and the flicker.
  // Also write the heat, the ship front direction, and the camera.
  private writeEngineLights(): void {
    const [rateA, rateB] = ENGINE_LIGHT_FLICKER_RATES;
    this.engines.forEach(({ flameRoot, engine }, i) => {
      const position = transformPoint(this.worldMatrices[engine], ENGINE_LIGHT_OFFSET);
      const size = this.poses[flameRoot].scale[0];
      // The phase offsets make the two engines flicker differently.
      const flicker = Math.sin(this.clock * rateA + i * 2.1) * Math.sin(this.clock * rateB + i);
      // The flicker is in [-1, 1], so the strength changes between (1 - 2 * ENGINE_LIGHT_FLICKER)
      // and 1 times its full value.
      const flickerScale = 1 - ENGINE_LIGHT_FLICKER + ENGINE_LIGHT_FLICKER * flicker;
      // The glow uses the light color, so the boost also changes the glow.
      const strength = size < 0.01 ? 0 : ENGINE_LIGHT_INTENSITY * size * flickerScale * this.boostBrightness();
      this.engineLightData.set([...position, 0], i * 8);
      this.engineLightData.set(
        [ENGINE_LIGHT_COLOR[0] * strength, ENGINE_LIGHT_COLOR[1] * strength, ENGINE_LIGHT_COLOR[2] * strength, 0],
        i * 8 + 4,
      );
    });
    // The ship front is +Z of the model, rotated by the placement.
    const forward = [this.placement[8], this.placement[9], this.placement[10]];
    const length = Math.hypot(forward[0], forward[1], forward[2]);
    const lightFloats = ENGINE_LIGHT_COUNT * 8;
    this.engineLightData.set([forward[0] / length, forward[1] / length, forward[2] / length, this.heat], lightFloats);
    this.engineLightData.set([...this.cameraPosition, this.clock], lightFloats + 4);
    this.engineLightData.set(this.viewProjection, lightFloats + 8);
    this.device.queue.writeBuffer(this.engineLightBuffer, 0, this.engineLightData);
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

  // The boost level moves toward its target at a limited rate, so that it does not jump, also when
  // the engines shut down in the middle of a boost.
  private updateBoost(seconds: number): void {
    const target = this.boostOn && this.engineState === 'running' ? 1 : 0;
    const change = Math.max(-seconds / BOOST_FALL_TIME, Math.min(seconds / BOOST_RISE_TIME, target - this.boost));
    this.boost += change;
  }

  // The brightness of the flames, the engine lights, and the glow, as a fraction of full brightness.
  private boostBrightness(): number {
    return BOOST_BASE_LEVEL + (1 - BOOST_BASE_LEVEL) * this.boost;
  }

  // The instance data of the plasma streaks: random points on the front of the hull, where the
  // normal points forward (+Z in the model). A fixed seed gives the same streaks in each run.
  // The instance data of the plasma streaks: random points on the solid parts of the ship, where the
  // normal points forward (+Z in the model) or to the side. The points are in the space of the hull
  // node, because the streaks use the model matrix of the hull. A fixed seed gives the same streaks
  // in each run.
  private makeStreaks(model: GltfModel): Float32Array {
    const hullIndex = model.nodes.findIndex((node) => node.name === HULL_NODE);
    if (hullIndex < 0 || !model.nodes[hullIndex].mesh) {
      throw new Error(`The ship model has no mesh in the node ${HULL_NODE}`);
    }
    // The rest transform of each node from the root of the scene. The hull is at the root space.
    const parents = new Map<number, number>();
    model.nodes.forEach((node, index) => node.children.forEach((child) => parents.set(child, index)));
    const restMatrix = (index: number): Mat4 => {
      const node = model.nodes[index];
      const local = compose(node.translation, node.rotation, node.scale);
      const parent = parents.get(index);
      return parent === undefined ? local : multiply(restMatrix(parent), local);
    };
    const hullInverse = invert(restMatrix(hullIndex));
    const toHull = (index: number): Mat4 => multiply(hullInverse, restMatrix(index));
    // The candidate points: position and normal in the hull space.
    const points: { position: Vec3; normal: Vec3 }[] = [];
    model.nodes.forEach((node, index) => {
      for (const primitive of node.mesh?.primitives ?? []) {
        if (primitive.material.unlit) {
          continue;
        }
        const matrix = toHull(index);
        for (let i = 0; i < primitive.positions.length / 3; ++i) {
          const normal: Vec3 = [primitive.normals[i * 3], primitive.normals[i * 3 + 1], primitive.normals[i * 3 + 2]];
          // The parts have no rotation, so the normal does not change.
          if (normal[2] > STREAK_FRONT) {
            const position = transformPoint(matrix, [
              primitive.positions[i * 3],
              primitive.positions[i * 3 + 1],
              primitive.positions[i * 3 + 2],
            ]);
            points.push({ position, normal });
          }
        }
      }
    });
    // A small random number generator (mulberry32).
    let state = STREAK_SEED;
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let x = state;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const between = (range: readonly [number, number]) => range[0] + (range[1] - range[0]) * random();
    const data = new Float32Array(STREAK_COUNT * STREAK_FLOATS);
    for (let streak = 0; streak < STREAK_COUNT; ++streak) {
      const point = points[Math.floor(random() * points.length)];
      data.set(point.position, streak * STREAK_FLOATS);
      data.set(point.normal, streak * STREAK_FLOATS + 3);
      data.set(
        [between(STREAK_LENGTH), between(STREAK_WIDTH), random() * 100, between(STREAK_SPEED)],
        streak * STREAK_FLOATS + 6,
      );
    }
    return data;
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
    // The flames point along -Z of their root, so a larger Z scale makes them longer.
    const length = 1 + (BOOST_FLAME_LENGTH - 1) * this.boost;
    for (const { flameRoot } of this.engines) {
      this.poses[flameRoot].scale[2] *= length;
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
