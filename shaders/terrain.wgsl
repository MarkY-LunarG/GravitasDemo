// The terrain grid (src/app/terrain.cpp). The constants come from terrain.cpp, and the light from
// light.wgsl.

struct Uniforms {
  viewProjection: mat4x4f,
  worldPos: vec3f,
  // The angle of the grid heading from +Z toward +X.
  gridYaw: f32,
  // The world X and Z of the grid center.
  gridCenter: vec2f,
  // The colors of low and high ground (TerrainStyle).
  lowColor: vec4f,
  highColor: vec4f,
  // x: the scale of the height. y: the scale of the craters.
  style: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) height: f32,
  @location(2) sunVisibility: f32,
}

// The weight of a feature of a given size on a grid with a given cell size. Features smaller than
// approximately 4 cells fade out, and features smaller than 2 cells are removed. Without this, far
// features that are smaller than a cell would flicker as the terrain moves.
fn detail(featureSize: f32, cellSize: f32) -> f32 {
  return saturate(featureSize / cellSize * 0.5 - 1.0);
}

// An integer hash of a cell and a seed. Different seeds give values that are not related.
fn hash(cell: vec2i, seed: u32) -> u32 {
  var h = (bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u) ^ (seed * 0xcb1ab31fu);
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

// A random gradient with components in [-1, 1]. The two halves of the hash give the
// two components, so no trigonometric functions are necessary.
fn gradient(cell: vec2i, seed: u32) -> vec2f {
  let h = hash(cell, seed);
  return vec2f(f32(h & 0xffffu), f32(h >> 16u)) / 32767.5 - 1.0;
}

// The height functions return vec3f(height, d(height)/dx, d(height)/dz).
// The analytic derivatives give the normal without more samples of the height field.

// Perlin gradient noise with a quintic fade curve. The value is approximately in [-1, 1].
fn perlin(p: vec2f, seed: u32) -> vec3f {
  let cell = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  let ga = gradient(cell, seed);
  let gb = gradient(cell + vec2i(1, 0), seed);
  let gc = gradient(cell + vec2i(0, 1), seed);
  let gd = gradient(cell + vec2i(1, 1), seed);

  let va = dot(ga, f);
  let vb = dot(gb, f - vec2f(1.0, 0.0));
  let vc = dot(gc, f - vec2f(0.0, 1.0));
  let vd = dot(gd, f - vec2f(1.0, 1.0));

  let value = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  let gradient = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
    + du * (u.yx * (va - vb - vc + vd) + vec2f(vb, vc) - va);
  return vec3f(value, gradient);
}

fn hills(p: vec2f, octaves: u32, cellSize: f32) -> vec3f {
  var sum = vec3f(0.0);
  var frequency = NOISE_FREQUENCY;
  var amplitude = NOISE_AMPLITUDE;
  for (var octave = 0u; octave < octaves; octave++) {
    let weight = detail(1.0 / frequency, cellSize);
    // The octaves after this one are smaller, so they also have a weight of 0.
    if (weight <= 0.0) {
      break;
    }
    let n = perlin(p * frequency, octave) * weight;
    sum += vec3f(n.x * amplitude, n.yz * amplitude * frequency);
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  return sum;
}

// One crater: a bowl below the ground inside the radius, and a raised rim at the radius.
fn crater(p: vec2f, center: vec2f, radius: f32) -> vec3f {
  let offset = p - center;
  let dist = length(offset);
  if (dist >= 2.0 * radius || dist < 1e-3) {
    return vec3f(0.0);
  }
  let d = dist / radius;
  let depth = 0.2 * radius;
  let rimHeight = 0.06 * radius;
  let rimWidth = 0.3;

  let rimOffset = (d - 1.0) / rimWidth;
  let rimShape = exp(-rimOffset * rimOffset);
  var height = rimHeight * rimShape;
  var slope = rimHeight * rimShape * -2.0 * (d - 1.0) / (rimWidth * rimWidth);
  if (d < 1.0) {
    height += depth * (d * d - 1.0);
    slope += depth * 2.0 * d;
  }
  // slope is d(height)/d(d). Change it to the gradient in world space.
  return vec3f(height, slope * offset / (dist * radius));
}

fn craterLayer(p: vec2f, cellSize: f32, probability: f32, minRadius: f32, maxRadius: f32,
               seed: u32, gridCellSize: f32) -> vec3f {
  if (detail(2.0 * maxRadius, gridCellSize) <= 0.0) {
    return vec3f(0.0);
  }
  // The 2 x 2 block of cells whose centers are nearest to p.
  let first = vec2i(floor(p / cellSize - 0.5));
  var sum = vec3f(0.0);
  for (var dz = 0; dz <= 1; dz++) {
    for (var dx = 0; dx <= 1; dx++) {
      let cell = first + vec2i(dx, dz);
      // One hash gives four random values of 8 bits: the chance of a crater, the radius,
      // and the position of the center in the cell.
      let h = hash(cell, seed);
      let values = vec4f(vec4u(h, h >> 8u, h >> 16u, h >> 24u) & vec4u(0xffu)) / 256.0;
      if (values.x >= probability) {
        continue;
      }
      let radius = mix(minRadius, maxRadius, values.y);
      let center = (vec2f(cell) + values.zw) * cellSize;
      sum += crater(p, center, radius) * detail(2.0 * radius, gridCellSize);
    }
  }
  return sum;
}

// cellSize is the size of a grid cell at p. Features that are small relative to it fade out.
fn terrainHeight(p: vec2f, octaves: u32, cellSize: f32) -> vec3f {
  let craterScale = uniforms.style.y;
  var height = hills(p, octaves, cellSize);
  if (craterScale > 0.0) {
    height += (craterLayer(p, LARGE_CRATER_CELL, LARGE_CRATER_PROBABILITY, LARGE_CRATER_RADIUS_MIN,
                           LARGE_CRATER_RADIUS_MAX, 100u, cellSize)
      + craterLayer(p, SMALL_CRATER_CELL, SMALL_CRATER_PROBABILITY, SMALL_CRATER_RADIUS_MIN,
                    SMALL_CRATER_RADIUS_MAX, 200u, cellSize)) * craterScale;
  }
  return height;
}

// The fraction of the sun that a surface point can see, from 0 to 1.
// Where the terrain is above the ray toward the sun, the point is in shadow. Where the terrain is
// a short distance below the ray, the point is in the soft edge of a shadow.
fn sunVisibility(sampleXZ: vec2f, cellSize: f32) -> f32 {
  // The ray starts on the same simplified surface that it tests against. A small offset above
  // that surface prevents the surface from shadowing itself.
  let startHeight = scaledHeight(sampleXZ, SHADOW_OCTAVES, cellSize).x;
  let origin = vec3f(sampleXZ.x, startHeight + 0.5, sampleXZ.y);
  var visibility = 1.0;
  var t = SHADOW_FIRST_STEP;
  for (var i = 0u; i < SHADOW_STEPS; i++) {
    let ray = origin + light.direction * t;
    if (ray.y > MAX_TERRAIN_HEIGHT) {
      break;
    }
    let clearance = ray.y - scaledHeight(ray.xz, SHADOW_OCTAVES, cellSize).x;
    visibility = min(visibility, SHADOW_SOFTNESS * clearance / t);
    if (visibility <= 0.0) {
      return 0.0;
    }
    t *= SHADOW_STEP_GROWTH;
  }
  return visibility;
}

// The wireframe does not use the light, so it does not need the shadow ray.
fn makeVertex(column: u32, row: u32, withShadow: bool) -> VertexOutput {
  let radius = GRID_NEAR * pow(GRID_RING_RATIO, f32(row));
  // The distance to the next ring. It is larger than the distance to the next column.
  let cellSize = radius * (GRID_RING_RATIO - 1.0);
  let angle = uniforms.gridYaw + (f32(column) / f32(GRID_COLUMNS - 1u) * 2.0 - 1.0) * GRID_HALF_ANGLE;
  let gridXZ = uniforms.gridCenter + radius * vec2f(sin(angle), cos(angle));
  let sampleXZ = gridXZ + uniforms.worldPos.xz;
  let terrain = scaledHeight(sampleXZ, NOISE_OCTAVES, cellSize);
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(gridXZ.x, terrain.x, gridXZ.y, 1.0);
  output.worldNormal = normalize(vec3f(-terrain.y, 1.0, -terrain.z));
  output.height = terrain.x;
  // A surface that faces away from the sun gets only ambient light, so it needs no shadow ray.
  output.sunVisibility = 0.0;
  if (withShadow && dot(output.worldNormal, light.direction) > 0.0) {
    output.sunVisibility = sunVisibility(sampleXZ, cellSize);
  }
  return output;
}

// The index buffer gives the vertex index of each triangle corner: row * GRID_COLUMNS + column.
@vertex
fn vs_solid(@builtin(vertex_index) index: u32) -> VertexOutput {
  return makeVertex(index % GRID_COLUMNS, index / GRID_COLUMNS, true);
}

@vertex
fn vs_wire(@builtin(vertex_index) index: u32) -> VertexOutput {
  let ringSegments = GRID_ROWS * (GRID_COLUMNS - 1u);
  var segment = index / 2u;
  let end = index % 2u;
  if (segment < ringSegments) {
    // Lines along the rings.
    return makeVertex(segment % (GRID_COLUMNS - 1u) + end, segment / (GRID_COLUMNS - 1u), false);
  }
  // Lines from the center outward.
  segment -= ringSegments;
  return makeVertex(segment / (GRID_ROWS - 1u), segment % (GRID_ROWS - 1u) + end, false);
}

// The height and its slope with the height scale of the style. The scale also changes the slope.
fn scaledHeight(p: vec2f, octaves: u32, cellSize: f32) -> vec3f {
  return terrainHeight(p, octaves, cellSize) * uniforms.style.x;
}

@fragment
fn fs_solid(input: VertexOutput) -> @location(0) vec4f {
  // Low ground has the low color, high ground has the high color, and slopes are a little darker.
  let height = saturate(input.height / (400.0 * max(uniforms.style.x, 0.01)) + 0.5);
  let normal = normalize(input.worldNormal);
  let base = mix(uniforms.lowColor.rgb, uniforms.highColor.rgb, height) * (0.75 + 0.25 * normal.y);
  return vec4f(applyShadowedLight(base, normal, input.sunVisibility), 1.0);
}

@fragment
fn fs_wire(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.0);
}
