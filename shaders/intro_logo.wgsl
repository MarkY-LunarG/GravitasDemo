// The LunarG logo of the intro (src/app/intro_logo.cpp). The constants come from intro_logo.cpp.

struct Uniforms {
  // xy: the screen position (pixels) of the upper-left corner of the logo. z: screen pixels for
  // each logo pixel.
  placement: vec4f,
  // x: colorToNeon. y: neonToTube. z: brightness. w: panel.
  mix: vec4f,
  // The brightness of each tube.
  tubes: array<vec4f, 3>,
  // x: flash.
  effects: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var colorLogo: texture_2d<f32>;
@group(0) @binding(2) var neon: texture_2d<f32>;
@group(0) @binding(3) var neonTube: texture_2d<f32>;
@group(0) @binding(4) var linearSampler: sampler;


@vertex
fn vs_logo(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

// The tube of a logo position (pixels of the neon images), in the order of TUBES.
fn tubeAt(p: vec2f) -> u32 {
  if (p.y > 580.0 && p.x < 900.0) {
    return 8u;
  }
  if (p.x >= 1458.0) {
    return 7u;
  }
  if (p.x >= 1245.0) {
    return 6u;
  }
  if (p.x >= 1140.0 || (p.x >= 1095.0 && (p.y < 330.0 || p.y > 590.0))) {
    return 5u;
  }
  let edges = array<f32, 4>(395.0, 583.0, 776.0, 985.0);
  for (var tube = 0u; tube < 4u; tube++) {
    if (p.x < edges[tube]) {
      return tube;
    }
  }
  return 4u;
}

// The part of a neon tube image color that is a tube (near white), not glow.
fn tubeMaskOf(color: vec3f) -> f32 {
  return smoothstep(0.35, 0.75, color.r) * smoothstep(0.5, 0.8, min(color.g, color.b));
}

fn tubeLevel(p: vec2f) -> f32 {
  let tube = tubeAt(p);
  return uniforms.tubes[tube / 4u][tube % 4u];
}

// The brightness of the glow at a logo position: the tube brightness, averaged across
// approximately 70 pixels, so the glow has no sharp edge where two tubes meet.
fn glowLevel(p: vec2f) -> f32 {
  var sum = 0.0;
  for (var i = -2; i <= 2; i++) {
    sum += tubeLevel(p + vec2f(f32(i) * 17.0, 0.0)) + tubeLevel(p + vec2f(0.0, f32(i) * 17.0));
  }
  return sum / 10.0;
}

fn sampleImage(image: texture_2d<f32>, p: vec2f, size: vec2f) -> vec4f {
  let uv = p / size;
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  let color = textureSampleLevel(image, linearSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
  return select(vec4f(0.0), color, inside);
}

@fragment
fn fs_logo(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = (position.xy - uniforms.placement.xy) / uniforms.placement.z;

  // The color logo: blue text with a transparent background, on black.
  let colorSample = sampleImage(colorLogo, p - COLOR_OFFSET, vec2f(textureDimensions(colorLogo)));
  let colorImage = colorSample.rgb * colorSample.a;

  // The neon images, on black.
  let neonSample = sampleImage(neon, p, LOGO_SIZE);
  let neonImage = neonSample.rgb * neonSample.a;
  let tubeSample = sampleImage(neonTube, p, LOGO_SIZE);
  let tubeImage = tubeSample.rgb * tubeSample.a;

  // The tubes are near white, and the glow panel is blue. Each tube has its own brightness. An
  // unlit tube is dim gray glass.
  let level = tubeLevel(p);
  let tubeMask = tubeMaskOf(tubeImage);
  let glass = vec3f(0.1, 0.13, 0.16);
  let lit = tubeImage * tubeMask * level + glass * tubeMask * (1.0 - level);
  // The glow around a tube has the brightness of the tube.
  let tubeLogo = tubeImage * (1.0 - tubeMask) * uniforms.mix.w * glowLevel(p) + lit;

  let neonLogo = mix(neonImage, tubeLogo, uniforms.mix.y) * uniforms.mix.z;
  var color = mix(colorImage, neonLogo, uniforms.mix.x);
  color = mix(color, vec3f(1.0), uniforms.effects.x);
  return vec4f(color, 1.0);
}
