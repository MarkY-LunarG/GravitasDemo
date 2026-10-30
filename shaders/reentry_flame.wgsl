// The re-entry fire (src/app/reentry.cpp). The constants come from reentry.cpp, and the noise from
// noise.wgsl.

struct Uniforms {
  viewProjection: mat4x4f,
  camera: vec4f,
  // xyz: the start of the flame. w: its length.
  start: vec4f,
  // xyz: the unit direction of the flow (from the front of the ship to its back). w: the width.
  back: vec4f,
  // x: the level (0 to 1). y: the time in seconds.
  params: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  // x: from 0 at the start of the flame to 1 at its end. y: -1 to 1 across the flame.
  @location(0) uv: vec2f,
}

@vertex
fn vs_flame(@builtin(vertex_index) vertex: u32) -> VertexOutput {
  var corners = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
  let back = uniforms.back.xyz;
  let center = uniforms.start.xyz + back * uniforms.start.w * 0.5;
  let side = normalize(cross(back, normalize(uniforms.camera.xyz - center)));
  let world = uniforms.start.xyz + back * uniforms.start.w * corner.x + side * uniforms.back.w * 0.5 * corner.y;
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(world, 1.0);
  output.uv = corner;
  return output;
}

// The color of the fire for a heat from 0 to 1: orange, yellow, and white.
fn fireColor(heat: f32) -> vec3f {
  var color = mix(vec3f(1.0, 0.38, 0.06), vec3f(1.0, 0.68, 0.18), saturate(heat * 2.5));
  color = mix(color, vec3f(1.0, 0.9, 0.45), saturate(heat * 2.5 - 1.0));
  return mix(color, vec3f(1.0, 0.98, 0.9), saturate(heat * 3.0 - 1.8));
}

@fragment
fn fs_flame(input: VertexOutput) -> @location(0) vec4f {
  let u = input.uv.x;
  let v = input.uv.y;
  let level = uniforms.params.x;
  let time = uniforms.params.y;
  let flow = time * FLAME_FLOW;

  // The position in meters: x from the start of the fire, and y across it.
  let x = u * uniforms.start.w;
  let y = v * uniforms.back.w * 0.5;

  // The radius of the fire: a round front, and then slowly wider.
  let frontRadius = FIRE_RADIUS * sqrt(saturate(x / FIRE_FRONT));
  let radius = max(frontRadius + max(x - FIRE_FRONT, 0.0) * FIRE_GROWTH, 1.0);

  // Turbulent noise that flows back. The warp bends the flames, and the fine noise makes tongues of
  // flame at the edges.
  let p = vec3f(x * 0.018 - flow * 5.0, y * 0.035, time * 0.4);
  let warp = perlin3(p * 0.7, 950u);
  let noise = perlin3(p + vec3f(warp * 1.8, warp * 1.2, 0.0), 951u) * 0.6
    + perlin3(p * 2.3 + vec3f(0.0, 0.0, time * 0.8), 952u) * 0.3
    + perlin3(p * 5.0 + vec3f(warp, 0.0, 0.0), 953u) * 0.2;
  let inside = 1.0 - abs(y) / radius;
  let flames = saturate((inside + noise * 1.1 - 0.05) * 1.4);

  // Hotter near the front of the ship and in the middle.
  let front = 1.0 - smoothstep(0.0, 150.0, x);
  let fade = 1.0 - smoothstep(0.5, 1.0, u);
  let heat = saturate(flames * (0.55 + 0.6 * front + 0.3 * saturate(inside))) * fade * level;
  return vec4f(fireColor(heat) * heat * FLAME_BRIGHTNESS, 0.0);
}
