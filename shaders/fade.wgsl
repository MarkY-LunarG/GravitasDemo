// The fade to black between scenes (src/app/fade.cpp).

@group(0) @binding(0) var<uniform> amount: vec4f;

// One triangle that is larger than the view, so it covers all of the view.
@vertex
fn vs_fade(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

@fragment
fn fs_fade() -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, amount.x);
}
