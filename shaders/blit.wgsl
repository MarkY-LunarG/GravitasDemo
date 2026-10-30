// Copy a texture to the render target with one full-screen triangle (src/app/blit.cpp).

@group(0) @binding(0) var source: texture_2d<f32>;

@vertex
fn vs_blit(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment
fn fs_blit(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureLoad(source, vec2i(position.xy), 0);
}
