// The re-entry smoke (src/app/reentry.cpp). It needs noise.wgsl.

struct Uniforms {
  viewProjection: mat4x4f,
  camera: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct Puff {
  center: vec3f,
  radius: f32,
  opacity: f32,
  // 0 when the puff starts, and 1 at the end of its life.
  age: f32,
  seed: f32,
  unused: f32,
}
// Sorted from far to near.
@group(0) @binding(1) var<storage, read> puffs: array<Puff>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
  @location(1) @interpolate(flat) opacity: f32,
  @location(2) @interpolate(flat) age: f32,
  @location(3) @interpolate(flat) seed: f32,
}

@vertex
fn vs_smoke(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let puff = puffs[instance];
  let corner = corners[vertex];
  let forward = normalize(puff.center - uniforms.camera.xyz);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  var output: VertexOutput;
  let world = puff.center + (right * corner.x + up * corner.y) * puff.radius;
  output.position = uniforms.viewProjection * vec4f(world, 1.0);
  output.corner = corner;
  output.opacity = puff.opacity;
  output.age = puff.age;
  output.seed = puff.seed;
  return output;
}

// A soft, uneven puff. A young puff is near the fire, so the fire lights it orange.
@fragment
fn fs_smoke(input: VertexOutput) -> @location(0) vec4f {
  let r2 = dot(input.corner, input.corner);
  if (r2 >= 1.0) {
    discard;
  }
  let p = vec3f(input.corner * 1.7, input.seed + input.age * 1.5);
  let noise = perlin3(p, 960u) + 0.5 * perlin3(p * 2.1, 961u);
  let density = saturate((noise * 0.7 + 0.55) * (1.0 - r2) * (1.0 - r2) * 1.6);
  let alpha = density * input.opacity;
  let glow = (1.0 - smoothstep(0.0, 0.35, input.age)) * 0.6;
  let color = mix(vec3f(0.17, 0.14, 0.12), vec3f(0.85, 0.35, 0.08), glow);
  return vec4f(color * alpha, alpha);
}
