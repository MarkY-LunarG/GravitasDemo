// Random values and 3D Perlin noise. The asteroid, sky, and ship shaders use them.

// An integer hash of a 3D cell and a seed. Different seeds give values that are not related.
fn hash3(cell: vec3i, seed: u32) -> u32 {
  var h = (bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u)
    ^ (bitcast<u32>(cell.z) * 0xcb1ab31fu) ^ (seed * 0x165667b1u);
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

// A random gradient with components in [-1, 1], from 10 bits of the hash for each component.
fn gradient3(cell: vec3i, seed: u32) -> vec3f {
  let h = hash3(cell, seed);
  return vec3f(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) / 511.5 - 1.0;
}

// 3D Perlin gradient noise with a quintic fade curve.
fn perlin3(p: vec3f, seed: u32) -> f32 {
  let cell = vec3i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var corners: array<f32, 8>;
  for (var i = 0u; i < 8u; i++) {
    let offset = vec3i(i32(i & 1u), i32((i >> 1u) & 1u), i32(i >> 2u));
    corners[i] = dot(gradient3(cell + offset, seed), f - vec3f(offset));
  }
  let x0 = mix(corners[0], corners[1], u.x);
  let x1 = mix(corners[2], corners[3], u.x);
  let x2 = mix(corners[4], corners[5], u.x);
  let x3 = mix(corners[6], corners[7], u.x);
  return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z);
}
