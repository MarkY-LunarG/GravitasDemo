// The clouds (src/app/clouds.cpp). It needs light.wgsl and noise.wgsl.

struct Cloud {
  center: vec3f,
  radius: f32,
  seed: f32,
  opacity: f32,
}

struct Uniforms {
  viewProjection: mat4x4f,
  camera: vec4f,
  // x: the brightness of a lightning flash. yz: its position in clip space. w: the width of the
  // view divided by its height.
  flash: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
// Sorted from far to near.
@group(0) @binding(1) var<storage, read> clouds: array<Cloud>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
  @location(1) @interpolate(flat) seed: f32,
  @location(2) @interpolate(flat) opacity: f32,
  @location(3) clip: vec2f,
}

// The index buffer has the 6 corners of a quad. The vertex index (0 to 3) selects the corner.
@vertex
fn vs_cloud(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let cloud = clouds[instance];
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u)) * 2.0 - 1.0;
  // The quad faces the camera.
  let forward = normalize(cloud.center - uniforms.camera.xyz);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let world = cloud.center + (right * corner.x + up * corner.y) * cloud.radius;
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(world, 1.0);
  output.clip = output.position.xy / output.position.w;
  output.corner = corner;
  output.seed = cloud.seed;
  output.opacity = cloud.opacity;
  return output;
}

// A soft round shape with noise at its edges. The top of the cloud is lit and the bottom is in
// shade. The color has the yellow-brown of the atmosphere. Lightning makes the clouds bright.
@fragment
fn fs_cloud(input: VertexOutput) -> @location(0) vec4f {
  let r2 = dot(input.corner, input.corner);
  if (r2 >= 1.0) {
    discard;
  }
  let p = vec3f(input.corner * 1.6, input.seed);
  let noise = perlin3(p, 800u) + 0.5 * perlin3(p * 2.1, 801u) + 0.25 * perlin3(p * 4.3, 802u);
  let falloff = (1.0 - r2) * (1.0 - r2);
  let density = saturate((noise * 0.8 + 0.55) * falloff * 1.8);
  let alpha = density * input.opacity;
  let lit = 0.55 + 0.45 * saturate(input.corner.y * 0.6 + 0.5);
  var color = vec3f(0.82, 0.68, 0.46) * lit * light.color;
  // Lightning lights the clouds near the flash position, and a little everywhere.
  let flashOffset = (input.clip - uniforms.flash.yz) * vec2f(uniforms.flash.w, 1.0);
  let flash = uniforms.flash.x * (0.06 + 0.55 * exp(-dot(flashOffset, flashOffset) * 2.0));
  color += vec3f(0.8, 0.82, 1.0) * flash * (0.6 + 0.4 * noise);
  // Premultiplied alpha.
  return vec4f(color * alpha, alpha);
}
