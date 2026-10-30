// A lens flare from the sun: a glow with rays and a horizontal streak at the sun, and a line of
// colored ghosts (images of the lens aperture) from the sun through the center of the screen. Each
// ghost is a hexagon, a circle, or an oval, which a seeded random value selects. An oval is
// squashed along the line from the sun through the center of the screen.
//
// Occlusion queries measure how much of the sun is visible:
//
// 1. In the main pass, after the opaque objects and the ship, drawProbes() draws a disk over the sun
//    two times, with no color writes. Query 0 counts the samples of the disk that pass the depth
//    test, so towers, land, and the ship in front of the sun remove samples. Query 1 counts all of
//    the samples of the disk on the screen, with no depth test.
// 2. Between the main pass and the post pass, resolve() writes the two counts into a storage
//    buffer.
// 3. In the post pass, the vertex shader of the flare reads the two counts. The visible part of the
//    sun is the first count divided by the second, and the flare has that brightness.
//
// The counts stay on the GPU, so the flare changes in the same frame, with no read back to the CPU.

import type { Mat4, Vec3 } from './mat4.js';
import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';

// The radius of the probe disk, in radians around the sun direction. The sun disk of the sky has a
// radius of approximately 0.03 radians.
const PROBE_RADIUS = 0.03;
// The total brightness of the flare.
const FLARE_STRENGTH = 1.0;
// The query indices.
const VISIBLE_QUERY = 0;
const TOTAL_QUERY = 1;
const QUERY_COUNT = 2;
const UNIFORM_FLOATS = 24;

// The ghosts: the position along the line from the sun (1) through the center of the screen (0),
// the radius in screen heights, and the color and brightness.
const GHOSTS: readonly { at: number; radius: number; color: Vec3 }[] = [
  { at: 0.55, radius: 0.04, color: [0.5, 0.32, 0.1] },
  { at: 0.2, radius: 0.025, color: [0.35, 0.45, 0.15] },
  { at: -0.2, radius: 0.08, color: [0.12, 0.22, 0.4] },
  { at: -0.45, radius: 0.035, color: [0.45, 0.25, 0.08] },
  { at: -0.75, radius: 0.12, color: [0.1, 0.3, 0.3] },
  { at: -1.2, radius: 0.07, color: [0.3, 0.12, 0.4] },
];
// The brightness of the ghosts, relative to the glow at the sun.
const GHOST_BRIGHTNESS = 0.5;
// The ghost shapes. The seed makes the same shapes in each run, so that the benchmark is the same.
const HEXAGON = 0;
const CIRCLE = 1;
const OVAL = 2;
const SHAPE_SEED = 271828;
// An oval is this wide along the line through the sun, relative to its width across the line.
const OVAL_SQUASH = 0.55;

// A small seeded random number generator (mulberry32). It gives values from 0 to 1.
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

const shapeRandom = makeRandom(SHAPE_SEED);
const ghostTable = GHOSTS.map(
  (ghost) =>
    `Ghost(${ghost.at}, ${ghost.radius}, vec3f(${ghost.color.join(', ')}), ${Math.floor(shapeRandom() * 3)}u)`,
).join(',\n  ');

const SHADER = /* wgsl */ `
struct Uniforms {
  viewProjection: mat4x4f,
  // xyz: the unit direction to the sun. w: the aspect ratio of the view (width / height).
  sun: vec4f,
  // rgb: the sun color. a: the flare brightness.
  color: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// The position of a point at an infinite distance in the direction dir, as for the sky.
fn projectDirection(dir: vec3f) -> vec4f {
  return uniforms.viewProjection * vec4f(dir, 0.0);
}

// The probe disk: a quad around the sun, at the far plane. The fragment shader removes the corners.
struct ProbeOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
}

const QUAD = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                             vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

@vertex
fn vs_probe(@builtin(vertex_index) index: u32) -> ProbeOutput {
  let dir = uniforms.sun.xyz;
  let u = normalize(cross(dir, vec3f(0.0, 1.0, 0.0)));
  let v = cross(u, dir);
  let corner = QUAD[index];
  var position = projectDirection(dir + (u * corner.x + v * corner.y) * ${PROBE_RADIUS});
  // At the far plane, so that all objects in front of the sun hide the disk.
  position.z = position.w;
  var output: ProbeOutput;
  output.position = position;
  output.local = corner;
  return output;
}

@fragment
fn fs_probe(input: ProbeOutput) -> @location(0) vec4f {
  if (dot(input.local, input.local) > 1.0) {
    discard;
  }
  return vec4f(0.0);
}

// The flare. The occlusion counts are 64-bit values: x is the low 32 bits.
@group(0) @binding(1) var<storage, read> occlusion: array<vec2u, ${QUERY_COUNT}>;

struct Ghost {
  at: f32,
  radius: f32,
  color: vec3f,
  shape: u32,
}
const HEXAGON = ${HEXAGON}u;
const CIRCLE = ${CIRCLE}u;
const OVAL = ${OVAL}u;
const OVAL_SQUASH = ${OVAL_SQUASH};
const GHOST_BRIGHTNESS = ${GHOST_BRIGHTNESS};
const GHOST_COUNT = ${GHOSTS.length}u;
const GHOSTS = array<Ghost, GHOST_COUNT>(
  ${ghostTable}
);

// The elements: 0 is the glow and the rays at the sun, 1 is the horizontal streak, and the others
// are the ghosts.
struct FlareOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) color: vec3f,
  @location(2) @interpolate(flat) element: u32,
  @location(3) @interpolate(flat) shape: u32,
  // The unit direction on the screen from the center to the sun, in units of the screen height.
  @location(4) @interpolate(flat) axis: vec2f,
}

@vertex
fn vs_flare(@builtin(vertex_index) index: u32, @builtin(instance_index) element: u32) -> FlareOutput {
  var output: FlareOutput;
  let clip = projectDirection(uniforms.sun.xyz);
  let total = f32(occlusion[${TOTAL_QUERY}].x);
  let visible = select(0.0, f32(occlusion[${VISIBLE_QUERY}].x) / max(total, 1.0), total > 0.0);
  // The sun is behind the camera, or no part of it is visible: no flare.
  if (clip.w <= 0.0 || visible <= 0.0) {
    output.position = vec4f(0.0, 0.0, 0.0, 1.0);
    return output;
  }
  let sun = clip.xy / clip.w;
  // The flare becomes weaker as the sun goes to the edge of the screen.
  let edge = 1.0 - smoothstep(0.8, 1.2, max(abs(sun.x), abs(sun.y)));
  let strength = visible * edge * uniforms.color.a;

  // The size of the element in screen heights (x, y), and its center.
  var size = vec2f(0.45, 0.45);
  var center = sun;
  var color = uniforms.color.rgb;
  if (element == 1u) {
    size = vec2f(1.4, 0.035);
    color = color * vec3f(0.8, 0.85, 1.0);
  } else if (element >= 2u) {
    let ghost = GHOSTS[element - 2u];
    size = vec2f(ghost.radius);
    center = sun * ghost.at;
    color = ghost.color;
    output.shape = ghost.shape;
  }
  let corner = QUAD[index];
  let aspect = uniforms.sun.w;
  let toSun = vec2f(sun.x * aspect, sun.y);
  output.axis = select(vec2f(1.0, 0.0), normalize(toSun), length(toSun) > 1e-4);
  output.position = vec4f(center + corner * vec2f(size.x / aspect, size.y) * 2.0, 0.0, 1.0);
  output.local = corner;
  output.color = color * strength;
  output.element = element;
  return output;
}

// The distance to the center of a hexagon with a flat top and bottom, 1 at the edge.
fn hexagon(p: vec2f) -> f32 {
  let q = abs(p);
  return max(q.x * 0.866025 + q.y * 0.5, q.y);
}

@fragment
fn fs_flare(input: FlareOutput) -> @location(0) vec4f {
  let p = input.local;
  let r = length(p);
  var brightness = 0.0;
  if (input.element == 0u) {
    // A bright core, a soft glow, and 12 thin rays that fade with distance.
    let angle = atan2(p.y, p.x);
    let rays = pow(abs(cos(angle * 6.0)), 60.0) * 0.6 + pow(abs(cos(angle * 6.0 + 0.5)), 200.0) * 0.4;
    brightness = exp(-r * r * 60.0) * 1.2 + exp(-r * 6.0) * 0.25 + rays * exp(-r * 4.5) * 0.5;
    brightness *= 1.0 - smoothstep(0.8, 1.0, r);
  } else if (input.element == 1u) {
    // Bright at the center line, and weaker to the ends.
    let across = exp(-abs(p.y) * 6.0);
    let along = pow(1.0 - abs(p.x), 3.0);
    brightness = across * along * 0.35;
  } else {
    // A shape with a soft edge and a brighter rim. d is 1 at the edge.
    var d = r;
    if (input.shape == HEXAGON) {
      d = hexagon(p);
    } else if (input.shape == OVAL) {
      let along = dot(p, input.axis);
      let across = dot(p, vec2f(-input.axis.y, input.axis.x));
      d = length(vec2f(along / OVAL_SQUASH, across));
    }
    brightness = (1.0 - smoothstep(0.85, 1.0, d)) * (0.35 + 0.65 * d * d) * GHOST_BRIGHTNESS;
  }
  return vec4f(input.color * brightness, 0.0);
}
`;

export class LensFlare {
  private readonly device: Device;
  // Give this query set to the main pass (Scene.occlusionQuerySet).
  readonly querySet: GPUQuerySet;
  private readonly uniformBuffer: GPUBuffer;
  private readonly occlusionBuffer: GPUBuffer;
  private readonly probeBindGroup: GPUBindGroup;
  private readonly flareBindGroup: GPUBindGroup;
  private readonly visiblePipeline: GPURenderPipeline;
  private readonly totalPipeline: GPURenderPipeline;
  private readonly flarePipeline: GPURenderPipeline;

  // format and depthFormat are the formats of the main pass. The post pass has the same color format.
  constructor(device: Device, format: TextureFormat, depthFormat: DepthFormat) {
    this.device = device;
    this.querySet = device.createQuerySet({ type: 'occlusion', count: QUERY_COUNT });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.occlusionBuffer = device.createBuffer({
      size: QUERY_COUNT * BigUint64Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.STORAGE,
    });

    const module = device.createShaderModule({ code: SHADER });
    const probeLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const flareLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const probePipeline = (depthCompare: GPUCompareFunction) =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [probeLayout] }),
        vertex: { module, entryPoint: 'vs_probe' },
        // The probe changes no pixels: it only counts samples.
        fragment: { module, entryPoint: 'fs_probe', targets: [{ format, writeMask: 0 }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare },
      });
    this.visiblePipeline = probePipeline('less-equal');
    this.totalPipeline = probePipeline('always');
    this.flarePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [flareLayout] }),
      vertex: { module, entryPoint: 'vs_flare' },
      fragment: {
        module,
        entryPoint: 'fs_flare',
        targets: [
          {
            format,
            // Light adds to the image.
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.probeBindGroup = device.createBindGroup({
      layout: probeLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.flareBindGroup = device.createBindGroup({
      layout: flareLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.occlusionBuffer } },
      ],
    });
  }

  // Set the camera, the unit direction to the sun, the sun color, and the aspect ratio of the view
  // (width / height).
  update(viewProjection: Mat4, sunDirection: Vec3, sunColor: Vec3, aspect: number): void {
    const data = new Float32Array(UNIFORM_FLOATS);
    data.set(viewProjection, 0);
    data.set([...sunDirection, aspect, ...sunColor, FLARE_STRENGTH], 16);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  // Count the visible samples of the sun. Call this in the main pass, after all of the opaque
  // objects. The pass must use querySet as its occlusion query set.
  drawProbes(pass: RenderPassEncoder): void {
    pass.pushDebugGroup('Sun occlusion');
    pass.setBindGroup(0, this.probeBindGroup);
    pass.setPipeline(this.visiblePipeline);
    pass.beginOcclusionQuery(VISIBLE_QUERY);
    pass.draw(6);
    pass.endOcclusionQuery();
    pass.setPipeline(this.totalPipeline);
    pass.beginOcclusionQuery(TOTAL_QUERY);
    pass.draw(6);
    pass.endOcclusionQuery();
    pass.popDebugGroup();
  }

  // Write the counts for the flare. Call this after the main pass and before the post pass.
  resolve(encoder: GPUCommandEncoder): void {
    encoder.resolveQuerySet(this.querySet, 0, QUERY_COUNT, this.occlusionBuffer, 0);
  }

  // Draw the flare over the image, in the post pass.
  draw(pass: RenderPassEncoder): void {
    pass.setPipeline(this.flarePipeline);
    pass.setBindGroup(0, this.flareBindGroup);
    pass.draw(6, 2 + GHOSTS.length);
  }
}
