// The asteroid shapes (src/app/asteroids.cpp): a compute shader that runs one time. The constants
// come from asteroids.cpp.

// The unit sphere directions of the vertices of LOD 0, then of LOD 1.
@group(0) @binding(0) var<storage, read> directions: array<vec4f>;
// For LOD 0, the vertices of shape 0, then shape 1, and so on. Then the same for LOD 1.
@group(0) @binding(1) var<storage, read_write> shapeVertices: array<ShapeVertex>;

// The crater profile of the terrain: a bowl below the surface inside the radius, and a raised rim
// at the radius. d is the distance from the crater center divided by the radius.
fn craterProfile(d: f32, radius: f32) -> f32 {
  if (d >= 2.0) {
    return 0.0;
  }
  let rimOffset = (d - 1.0) / 0.3;
  var height = 0.06 * radius * exp(-rimOffset * rimOffset);
  if (d < 1.0) {
    height += 0.2 * radius * (d * d - 1.0);
  }
  return height;
}

// A random unit vector for a crater.
fn randomDirection(key: u32, seed: u32) -> vec3f {
  let z = random(key, seed) * 2.0 - 1.0;
  let angle = random(key, seed + 1u) * 6.2831853;
  let r = sqrt(1.0 - z * z);
  return vec3f(r * cos(angle), r * sin(angle), z);
}

// The surface point of a shape in a unit direction.
fn surface(direction: vec3f, shape: u32) -> vec3f {
  var height = 0.0;
  var frequency = NOISE_FREQUENCY;
  var amplitude = NOISE_AMPLITUDE;
  for (var octave = 0u; octave < OCTAVES; octave++) {
    height += perlin3(direction * frequency, shape * 16u + octave) * amplitude;
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  for (var crater = 0u; crater < CRATERS; crater++) {
    let key = shape * 64u + crater;
    let center = randomDirection(key, 1000u);
    let radius = mix(CRATER_RADIUS_MIN, CRATER_RADIUS_MAX, random(key, 2000u));
    // The angle between the directions is the distance on the unit sphere.
    let angle = acos(clamp(dot(direction, center), -1.0, 1.0));
    height += craterProfile(angle / radius, radius);
  }
  let stretch = mix(vec3f(STRETCH_MIN), vec3f(STRETCH_MAX),
                    vec3f(random(shape, 3000u), random(shape, 3001u), random(shape, 3002u)));
  return direction * (1.0 + height) * stretch;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn cs_shapes(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= SHAPES * (VERTEX_COUNT_0 + VERTEX_COUNT_1)) {
    return;
  }
  var local = index;
  var vertexCount = VERTEX_COUNT_0;
  var directionBase = 0u;
  if (index >= SHAPES * VERTEX_COUNT_0) {
    local = index - SHAPES * VERTEX_COUNT_0;
    vertexCount = VERTEX_COUNT_1;
    directionBase = VERTEX_COUNT_0;
  }
  let shape = local / vertexCount;
  let direction = directions[directionBase + local % vertexCount].xyz;

  // The normal comes from two near points on the surface, in two tangent directions.
  var tangent = cross(direction, vec3f(0.0, 1.0, 0.0));
  if (length(tangent) < 0.1) {
    tangent = cross(direction, vec3f(1.0, 0.0, 0.0));
  }
  tangent = normalize(tangent);
  let bitangent = cross(direction, tangent);
  let step = 0.002;
  let center = surface(direction, shape);
  let a = surface(normalize(direction + tangent * step), shape);
  let b = surface(normalize(direction + bitangent * step), shape);
  var normal = normalize(cross(a - center, b - center));
  if (dot(normal, direction) < 0.0) {
    normal = -normal;
  }
  shapeVertices[index] = ShapeVertex(vec4f(center, 1.0), vec4f(normal, 0.0));
}
