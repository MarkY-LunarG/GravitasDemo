// The background of a scene: stars, and as options, a nebula and a planet with a ring and moons.
// One full-screen shader calculates the background color for each view direction, so the
// background is infinitely far away and the camera position does not change it.
//
// Draw the sky after the opaque objects of a scene and before blended objects. The sky is at the
// far plane and does not write depth, so the depth test skips the pixels that objects cover.
// The planet and the moons use the shared sun.

import type { DepthFormat, Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';
import { type DirectionalLight, LIGHT_WGSL } from './light.js';
import { type Mat4, type Vec3, invert, multiply, translationScale } from './mat4.js';
import { NOISE_WGSL } from './noise.js';

// The star layers. Each layer divides the directions into cells of 1 / grid radians. A cell has a
// star with the given probability, at a random position in the cell. Bright stars have a glow and
// four spikes, as stars in photographs do.
const STAR_LAYERS = [
  { grid: 500, probability: 0.02, brightness: 0.6, spikes: false },
  { grid: 250, probability: 0.03, brightness: 1.0, spikes: false },
  { grid: 20, probability: 0.012, brightness: 1.5, spikes: true },
] as const;

export interface PlanetOptions {
  // The direction of the planet center, from the horizontal heading: degrees to the right of the
  // heading, and degrees above the horizon.
  readonly rightDegrees: number;
  readonly elevationDegrees: number;
  // The angular radius of the planet, in degrees.
  readonly radiusDegrees: number;
}

export interface SkyOptions {
  // A dark blue background with a purple and green nebula. Without it, the background is black.
  readonly nebula: boolean;
  readonly planet: PlanetOptions | null;
  // A yellow-brown planet below the horizon, with an atmosphere. setAtmosphere() sets how deep the
  // camera is in the atmosphere. Without it, the sky ignores setAtmosphere().
  readonly atmosphere?: boolean;
  // A sun disk with a glow, in the direction of the shared light.
  readonly sunDisk?: boolean;
}

// The ring and the moons, relative to the planet radius R.
const RING_RADIUS = [1.35, 2.2] as const;
// The ring normal leans away from the planet up direction, to the left and toward the viewer.
const RING_LEAN_LEFT = 0.4;
const RING_LEAN_TOWARD_VIEWER = 0.28;
// Each moon: an offset from the planet center in R (to the right and up as the viewer sees it), a
// radius in R, and a distance relative to the planet distance. A distance smaller than 1 puts the
// moon in front of the planet.
const MOONS = [
  { right: -0.6, up: -0.78, radius: 0.22, distance: 0.95, seed: 1 },
  { right: 1.9, up: 1.45, radius: 0.09, distance: 1.3, seed: 2 },
] as const;

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function wgslVec3(v: Vec3): string {
  return `vec3f(${v[0]}, ${v[1]}, ${v[2]})`;
}

// The WGSL constants of the planet, the ring, and the moons, in a space where the camera is at the
// origin and the planet center is 1 unit away.
function planetConstants(planet: PlanetOptions, heading: Vec3): string {
  const toRadians = Math.PI / 180;
  const right: Vec3 = [-heading[2], 0, heading[0]];
  const turn = planet.rightDegrees * toRadians;
  const horizontal = [0, 1, 2].map((i) => heading[i] * Math.cos(turn) + right[i] * Math.sin(turn));
  const elevation = planet.elevationDegrees * toRadians;
  const center = normalize([
    horizontal[0] * Math.cos(elevation),
    Math.sin(elevation),
    horizontal[2] * Math.cos(elevation),
  ]);
  const radius = Math.sin(planet.radiusDegrees * toRadians);
  // The right and up directions of the viewer at the planet.
  const planetRight = normalize(cross(center, [0, 1, 0]));
  const planetUp = cross(planetRight, center);
  const combine = (f: (i: number) => number): Vec3 => [f(0), f(1), f(2)];
  const ringNormal = normalize(
    combine((i) => planetUp[i] - planetRight[i] * RING_LEAN_LEFT - center[i] * RING_LEAN_TOWARD_VIEWER),
  );
  const moons = MOONS.map((moon) => {
    const direction = normalize(
      combine((i) => center[i] + (planetRight[i] * moon.right + planetUp[i] * moon.up) * radius),
    );
    const moonCenter = combine((i) => direction[i] * moon.distance);
    return `Body(${wgslVec3(moonCenter)}, ${moon.radius * radius * moon.distance}, ${moon.seed}u)`;
  });
  return `
const PLANET_CENTER: vec3f = ${wgslVec3(center)};
const PLANET_RADIUS: f32 = ${radius};
const RING_NORMAL: vec3f = ${wgslVec3(ringNormal)};
const RING_INNER: f32 = ${RING_RADIUS[0]};
const RING_OUTER: f32 = ${RING_RADIUS[1]};
const MOON_COUNT: u32 = ${MOONS.length}u;
const MOONS = array<Body, ${MOONS.length}>(${moons.join(', ')});

// The distance along the ray to the near surface of a sphere, and the coverage of the pixel
// (0 to 1) with a smooth edge of one pixel. The ray starts at the origin.
fn raySphere(dir: vec3f, center: vec3f, radius: f32, pixelAngle: f32) -> vec2f {
  let along = dot(dir, center);
  let closest2 = max(dot(center, center) - along * along, 0.0);
  let coverage = saturate((radius - sqrt(closest2)) / (pixelAngle * along) + 0.5);
  let inside = max(radius * radius - closest2, 0.0);
  return vec2f(along - sqrt(inside), select(0.0, coverage, along > 0.0));
}

// The light of the sun on a surface with normal n. The terminator is soft, and the night side
// has a little light, as in the reference image.
fn sunLight(n: vec3f) -> f32 {
  return smoothstep(-0.08, 0.4, dot(n, light.direction));
}

fn shadePlanet(n: vec3f, dir: vec3f) -> vec3f {
  // Bands that are parallel to the ring, with swirls.
  let latitude = dot(n, RING_NORMAL);
  let warp = perlin3(n * 4.0, 400u) * 0.8 + perlin3(n * 9.0, 401u) * 0.3;
  let bands = sin(latitude * 14.0 + warp * 3.0) * 0.5 + 0.5;
  var base = mix(vec3f(0.36, 0.28, 0.2), vec3f(0.62, 0.52, 0.38), bands);
  base = mix(base, vec3f(0.33, 0.37, 0.42), smoothstep(0.15, 0.6, perlin3(n * 7.0 + warp, 402u)));
  base *= 0.85 + 0.3 * perlin3(n * 22.0, 403u);
  let lit = sunLight(n);
  var color = base * (lit * light.color + vec3f(0.025, 0.03, 0.05));
  // A thin gold atmosphere at the edge of the lit side.
  let edge = pow(1.0 - max(dot(n, -dir), 0.0), 4.0);
  color += vec3f(1.0, 0.72, 0.32) * edge * smoothstep(-0.2, 0.5, dot(n, light.direction)) * 0.9;
  return color;
}

fn shadeMoon(n: vec3f, seed: u32) -> vec3f {
  let base = vec3f(0.5, 0.45, 0.4) * (0.75 + 0.5 * perlin3(n * 6.0, 500u + seed));
  return base * (sunLight(n) * light.color + vec3f(0.02, 0.025, 0.04));
}

// The ring at a distance along the ray: color and alpha. alpha is 0 outside the ring.
fn shadeRing(dir: vec3f, rayDistance: f32, pixelAngle: f32) -> vec4f {
  let point = dir * rayDistance;
  let r = length(point - PLANET_CENTER) / PLANET_RADIUS;
  let edge = pixelAngle * rayDistance / PLANET_RADIUS;
  let inRing = smoothstep(RING_INNER - edge, RING_INNER + edge, r)
    * (1.0 - smoothstep(RING_OUTER - edge, RING_OUTER + edge, r));
  if (inRing <= 0.0) {
    return vec4f(0.0);
  }
  // Light and dark bands, and gaps.
  let density = saturate(0.55 + 0.9 * perlin3(vec3f(r * 22.0, 0.5, 0.5), 600u));
  // The planet shadow: the ray from the ring point toward the sun goes through the planet.
  let toPlanet = PLANET_CENTER - point;
  let along = dot(toPlanet, light.direction);
  let shadowed = along > 0.0 && length(toPlanet - light.direction * along) < PLANET_RADIUS;
  let lit = select(0.25 + 0.75 * abs(dot(RING_NORMAL, light.direction)), 0.06, shadowed);
  let color = vec3f(0.78, 0.67, 0.5) * lit * light.color;
  return vec4f(color, inRing * density * 0.85);
}

`;
}

// The part of the fragment shader that draws the planet, the ring, and the moons over the
// background color.
const PLANET_FRAGMENT = /* wgsl */ `
    // The planet, the ring, and the moons, from far to near.
    var layers: array<Layer, ${2 + MOONS.length}>;
    var count = 0u;
    let planet = raySphere(dir, PLANET_CENTER, PLANET_RADIUS, pixelAngle);
    if (planet.y > 0.0) {
      let n = normalize(dir * planet.x - PLANET_CENTER);
      layers[count] = Layer(planet.x, vec4f(shadePlanet(n, dir), planet.y));
      count++;
    }
    let ringDistance = dot(PLANET_CENTER, RING_NORMAL) / dot(dir, RING_NORMAL);
    if (ringDistance > 0.0) {
      let ring = shadeRing(dir, ringDistance, pixelAngle);
      if (ring.a > 0.0) {
        layers[count] = Layer(ringDistance, ring);
        count++;
      }
    }
    var moons = MOONS;
    for (var i = 0u; i < MOON_COUNT; i++) {
      let moon = moons[i];
      let hit = raySphere(dir, moon.center, moon.radius, pixelAngle);
      if (hit.y > 0.0) {
        let n = normalize(dir * hit.x - moon.center);
        layers[count] = Layer(hit.x, vec4f(shadeMoon(n, moon.seed), hit.y));
        count++;
      }
    }
    // Sort from far to near, then blend each layer over the color.
    for (var i = 1u; i < count; i++) {
      var j = i;
      while (j > 0u && layers[j - 1u].distance < layers[j].distance) {
        let swap = layers[j];
        layers[j] = layers[j - 1u];
        layers[j - 1u] = swap;
        j--;
      }
    }
    for (var i = 0u; i < count; i++) {
      color = mix(color, layers[i].color.rgb, layers[i].color.a);
    }
`;

function makeShader(options: SkyOptions, heading: Vec3): string {
  const starLayers = STAR_LAYERS.map(
    (layer, i) =>
      `color += starLayer(dir, pixelAngle, screenX, screenY, ${layer.grid}.0, ${layer.probability}, ` +
      `${layer.brightness}, ${layer.spikes}, ${100 + i * 10}u);`,
  ).join('\n  ');
  return /* wgsl */ `
${LIGHT_WGSL}
${NOISE_WGSL}

struct Body {
  center: vec3f,
  radius: f32,
  seed: u32,
}

const NEBULA: bool = ${options.nebula};
const ATMOSPHERE: bool = ${options.atmosphere ?? false};
const SUN_DISK: bool = ${options.sunDisk ?? false};
// The horizontal heading. The tilt of the horizon goes up along it.
const HEADING: vec3f = ${wgslVec3(heading)};
${options.planet ? planetConstants(options.planet, heading) : ''}

struct SkyUniforms {
  // The inverse of the view-projection matrix without the camera translation. It changes a clip
  // position to a view direction.
  inverseViewProjection: mat4x4f,
  // x: how deep the camera is in the atmosphere (0 is space, 1 is deep).
  // y: the brightness of a lightning flash.
  // z: the sine of the angle of the horizon below the horizontal.
  // w: the tangent of the tilt of the horizon. The horizon is higher along the heading.
  atmosphere: vec4f,
  // xy: the flash position in clip space. z: the width of the view divided by its height.
  flashPosition: vec4f,
}
@group(0) @binding(0) var<uniform> sky: SkyUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}

// One triangle that covers the view, at the far plane (depth 1).
@vertex
fn vs_sky(@builtin(vertex_index) index: u32) -> VertexOutput {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(corners[index], 1.0, 1.0);
  output.clip = corners[index];
  return output;
}

fn random01(h: u32) -> f32 {
  return f32(h >> 8u) / 16777216.0;
}

// One layer of stars. pixelAngle is the angle of one pixel, and screenX and screenY are the world
// directions of the screen axes. They give the stars a size of approximately one pixel.
fn starLayer(dir: vec3f, pixelAngle: f32, screenX: vec3f, screenY: vec3f, grid: f32, probability: f32,
             brightness: f32, spikes: bool, seed: u32) -> vec3f {
  let cell = vec3i(floor(dir * grid));
  let h = hash3(cell, seed);
  if (random01(h) >= probability) {
    return vec3f(0.0);
  }
  // The star is in the center half of the cell, so that it is not cut at the cell edges.
  let h2 = hash3(cell, seed + 1u);
  let offset = vec3f(f32(h2 & 1023u), f32((h2 >> 10u) & 1023u), f32((h2 >> 20u) & 1023u)) / 1023.0;
  let starDir = normalize(vec3f(cell) + 0.25 + offset * 0.5);
  // The offset from the star in pixels, along the screen axes.
  let delta = dir - starDir;
  let pixels = vec2f(dot(delta, screenX), dot(delta, screenY)) / pixelAngle;
  let r2 = dot(pixels, pixels);

  let h3 = hash3(cell, seed + 2u);
  // Most stars are faint, and few are bright.
  let strength = brightness * (0.15 + 0.85 * pow(random01(h3), 4.0));
  // White stars, with some blue, yellow, and red stars.
  let tint = random01(h3 * 747796405u);
  var color = vec3f(1.0);
  if (tint < 0.15) {
    color = vec3f(0.7, 0.8, 1.0);
  } else if (tint < 0.25) {
    color = vec3f(1.0, 0.9, 0.6);
  } else if (tint < 0.3) {
    color = vec3f(1.0, 0.55, 0.45);
  }
  var glow = exp(-r2 * 1.2);
  if (spikes) {
    let spikeX = exp(-abs(pixels.x) * 0.22) * exp(-pixels.y * pixels.y * 1.5);
    let spikeY = exp(-abs(pixels.y) * 0.22) * exp(-pixels.x * pixels.x * 1.5);
    glow += (spikeX + spikeY) * 0.5 + exp(-sqrt(r2) * 0.3) * 0.35;
  }
  return color * strength * glow;
}

fn fbm3(p: vec3f, seed: u32) -> f32 {
  return perlin3(p, seed) + 0.5 * perlin3(p * 2.0, seed + 1u) + 0.25 * perlin3(p * 4.0, seed + 2u);
}

// A dark blue background, brighter near the sun, with purple and green clouds.
fn nebula(dir: vec3f) -> vec3f {
  let sunGlow = pow(max(dot(dir, light.direction), 0.0), 6.0);
  var color = vec3f(0.025, 0.025, 0.075) + vec3f(0.12, 0.12, 0.3) * sunGlow;
  let purple = smoothstep(0.0, 0.7, fbm3(dir * 2.5, 300u));
  let green = smoothstep(0.15, 0.8, fbm3(dir * 2.0 + 7.0, 310u));
  color += vec3f(0.16, 0.05, 0.18) * purple + vec3f(0.05, 0.11, 0.06) * green;
  return color;
}

struct Layer {
  distance: f32,
  color: vec4f,
}

// 2D noise from the 3D noise, for the cloud tops of the planet.
fn fbm2(p: vec2f, seed: u32) -> f32 {
  return fbm3(vec3f(p, 0.5), seed);
}

// The planet below the horizon, its glowing edge, and the haze of the atmosphere over the
// background color.
fn atmosphere(dir: vec3f, background: vec3f, clip: vec2f) -> vec3f {
  let depth = sky.atmosphere.x;
  // The flash lights the haze near the flash position, and a little everywhere.
  let flashOffset = (clip - sky.flashPosition.xy) * vec2f(sky.flashPosition.z, 1.0);
  let flash = sky.atmosphere.y * (0.08 + 0.6 * exp(-dot(flashOffset, flashOffset) * 2.0));
  // The tilt makes the horizon higher in the directions along the heading, and lower behind.
  let horizon = -sky.atmosphere.z + sky.atmosphere.w * dot(dir, HEADING);
  let sun = saturate(dot(dir, light.direction));
  var color = background;
  if (dir.y < horizon) {
    // The cloud tops of the planet, on a plane below the camera, so far clouds are smaller.
    let below = max(horizon - dir.y, 0.003);
    let ground = dir.xz / below * 0.15;
    let bands = fbm2(vec2f(ground.x * 0.6, ground.y * 1.6), 700u);
    let detail = fbm2(ground * 3.0, 710u);
    var surface = mix(vec3f(0.42, 0.3, 0.14), vec3f(0.78, 0.62, 0.34), saturate(bands * 0.7 + 0.5));
    surface *= 0.8 + 0.35 * detail;
    surface *= light.color * (0.55 + 0.45 * light.direction.y);
    // Far cloud tops fade into the haze at the horizon.
    color = mix(surface, vec3f(0.85, 0.68, 0.4), exp(-below * 18.0));
  }
  // The thin bright edge of the atmosphere at the horizon, seen from space.
  let edge = exp(-abs(dir.y - horizon) * 45.0);
  color += vec3f(0.95, 0.7, 0.35) * edge * (1.0 - depth) * 0.8;
  // In the atmosphere, the haze covers the stars and the far cloud tops. It is brighter near the
  // horizon and toward the sun, and darker above.
  let height = saturate((dir.y - horizon) * 2.5);
  var haze = mix(vec3f(0.82, 0.64, 0.36), vec3f(0.36, 0.25, 0.12), height);
  haze += vec3f(0.35, 0.25, 0.1) * pow(sun, 8.0);
  let cover = depth * select(1.0, 0.75, dir.y < horizon);
  color = mix(color, haze * light.color, cover);
  // Lightning lights the haze.
  color += vec3f(0.6, 0.6, 0.7) * flash * depth;
  return color;
}

@fragment
fn fs_sky(input: VertexOutput) -> @location(0) vec4f {
  let p = sky.inverseViewProjection * vec4f(input.clip, 0.5, 1.0);
  let dir = normalize(p.xyz / p.w);
  // The derivatives must be in uniform control flow, so calculate them first.
  let ddx = dpdx(dir);
  let ddy = dpdy(dir);
  let pixelAngle = max(length(ddx), length(ddy));
  let screenX = normalize(ddx);
  let screenY = normalize(ddy);

  var color = vec3f(0.0);
  if (NEBULA) {
    color = nebula(dir);
  }
  ${starLayers}

  ${options.planet ? PLANET_FRAGMENT : ''}
  if (ATMOSPHERE) {
    color = atmosphere(dir, color, input.clip);
  }
  if (SUN_DISK) {
    // A disk of approximately 2 degrees, a bright glow near it, and a wide weak glow.
    let toSun = dot(dir, light.direction);
    let disk = smoothstep(0.99925, 0.99955, toSun);
    let glow = pow(max(toSun, 0.0), 300.0) * 0.9 + pow(max(toSun, 0.0), 12.0) * 0.25;
    color += light.color * (disk * 2.5 + glow);
  }
  return vec4f(color, 1.0);
}
`;
}

export class Sky {
  private readonly device: Device;
  private readonly light: DirectionalLight;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly pipeline: GPURenderPipeline;

  // heading is the horizontal direction that the planet direction is relative to.
  constructor(
    device: Device,
    format: TextureFormat,
    depthFormat: DepthFormat,
    light: DirectionalLight,
    heading: Vec3,
    options: SkyOptions,
  ) {
    this.device = device;
    this.light = light;
    // The inverse view-projection matrix (16 floats), and the atmosphere and flash position
    // vectors (4 floats each).
    this.uniformBuffer = device.createBuffer({
      size: 24 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    const module = device.createShaderModule({ code: makeShader(options, heading) });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, light.bindGroupLayout] }),
      vertex: { module, entryPoint: 'vs_sky' },
      fragment: { module, entryPoint: 'fs_sky', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      // The sky is at depth 1, the depth clear value. It shows only where nothing was drawn.
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
    });
  }

  // The sky needs only the camera rotation. Without the camera translation, the view direction
  // keeps its precision far from the origin.
  setCamera(viewProjection: Mat4, cameraPosition: Vec3): void {
    const atOrigin = multiply(viewProjection, translationScale(cameraPosition, [1, 1, 1]));
    this.device.queue.writeBuffer(this.uniformBuffer, 0, invert(atOrigin));
  }

  // Set how deep the camera is in the atmosphere (0 is space, 1 is deep), the brightness of a
  // lightning flash and its position in clip space, the angle in radians of the horizon below the
  // horizontal, the tilt of the horizon in radians (higher along the heading), and the width of the
  // view divided by its height.
  setAtmosphere(
    depth: number,
    flash: number,
    flashPosition: [number, number],
    horizonDip: number,
    horizonTilt: number,
    aspect: number,
  ): void {
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      16 * Float32Array.BYTES_PER_ELEMENT,
      new Float32Array([
        depth,
        flash,
        Math.sin(horizonDip),
        Math.tan(horizonTilt),
        flashPosition[0],
        flashPosition[1],
        aspect,
        0,
      ]),
    );
  }

  draw(pass: RenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    this.light.bind(pass);
    pass.draw(3);
  }
}
