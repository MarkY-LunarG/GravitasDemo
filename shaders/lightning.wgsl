// The lightning flash (src/app/lightning.cpp).

struct Uniforms {
  // xy: the flash position in clip space. z: the width of the view divided by its height.
  values: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}

@vertex
fn vs_flash(@builtin(vertex_index) index: u32) -> VertexOutput {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(corners[index], 0.0, 1.0);
  output.clip = corners[index];
  return output;
}

// A bright glow at the flash position near the edge, and a very weak glow over the whole screen.
@fragment
fn fs_flash(input: VertexOutput) -> @location(0) vec4f {
  let offset = (input.clip - uniforms.values.xy) * vec2f(uniforms.values.z, 1.0);
  let distance2 = dot(offset, offset);
  let glow = exp(-distance2 * 3.0) * 0.7 + 0.03;
  return vec4f(vec3f(0.82, 0.86, 1.0) * glow, 0.0);
}
