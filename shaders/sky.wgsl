// The background of a scene (src/app/sky.cpp): stars, a nebula, a planet, an atmosphere, and a sun
// disk. The constants come from sky.cpp, the light from light.wgsl, and the noise from noise.wgsl.
// sky.cpp fills three placeholders: PLANET with sky_planet.wgsl or nothing, STAR_LAYERS with a
// starLayer() call for each star layer, and PLANET_FRAGMENT with sky_planet_fragment.wgsl or
// nothing.

struct Body {
  center: vec3f,
  radius: f32,
  seed: u32,
}

{{PLANET}}

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
  {{STAR_LAYERS}}

  {{PLANET_FRAGMENT}}
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
