// Code that the asteroid shape, update, and render shaders share (src/app/asteroids.cpp). It
// needs noise.wgsl.

struct ShapeVertex {
  position: vec4f,
  normal: vec4f,
}

struct Asteroid {
  position: vec3f,
  radius: f32,
  velocity: vec3f,
  shape: u32,
  spinAxis: vec3f,
  spinSpeed: f32,
  // A unit quaternion [x, y, z, w].
  orientation: vec4f,
}

// A random number in [0, 1) for an integer key and a seed.
fn random(key: u32, seed: u32) -> f32 {
  return f32(hash3(vec3i(i32(key), 0, 0), seed) >> 8u) / 16777216.0;
}

fn rotate(q: vec4f, v: vec3f) -> vec3f {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
