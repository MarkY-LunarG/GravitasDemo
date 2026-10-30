// The glow sprites of the engine lights (src/app/ship.cpp). The constants come from ship.cpp, and
// the effects from ship_effects.wgsl.

struct GlowUniforms {
  viewProjection: mat4x4f,
  // The camera position and the world directions of the camera right and up. w is not used.
  cameraPosition: vec4f,
  cameraRight: vec4f,
  cameraUp: vec4f,
}
@group(0) @binding(0) var<uniform> glow: GlowUniforms;

struct GlowOutput {
  @builtin(position) position: vec4f,
  // The position in the quad, from -1 to 1 on each axis.
  @location(0) corner: vec2f,
  @location(1) color: vec3f,
}

// Six vertices for each instance: two triangles of the quad of engine light instance_index.
@vertex
fn vs_glow(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> GlowOutput {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
  let light = effects.lights[index];
  let toCamera = normalize(glow.cameraPosition.xyz - light.position.xyz);
  let center = light.position.xyz + toCamera * GLOW_PULL;
  let world = center + (glow.cameraRight.xyz * corner.x + glow.cameraUp.xyz * corner.y) * GLOW_RADIUS;
  var output: GlowOutput;
  output.position = glow.viewProjection * vec4f(world, 1.0);
  output.corner = corner;
  // The light color includes the strength, the fade, and the flicker.
  output.color = light.color.rgb / ENGINE_LIGHT_INTENSITY;
  return output;
}

// A bright core and a wide soft halo. Both are 0 at the edge of the quad.
@fragment
fn fs_glow(input: GlowOutput) -> @location(0) vec4f {
  let r2 = dot(input.corner, input.corner);
  let edge = saturate(1.0 - r2);
  let shape = (exp(-r2 * 30.0) * 1.5 + exp(-r2 * 5.0) * 0.6) * edge * edge;
  return vec4f(input.color * shape * GLOW_BRIGHTNESS, 0.0);
}
