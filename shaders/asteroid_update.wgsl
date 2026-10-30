// The asteroid update and cull pass (src/app/asteroids.cpp), in each frame. The constants come
// from asteroids.cpp, and shipPathOffset() from ship_path.cpp.

struct Params {
  planes: array<vec4f, 6>,
  shipCenter: vec4f,
  right: vec4f,
  up: vec4f,
  heading: vec4f,
  cameraPosition: vec4f,
  seconds: f32,
  flowSpeed: f32,
  // The time in seconds on the ship path.
  pathTime: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> asteroids: array<Asteroid>;
// DRAW_ARGS_SIZE u32 values for each draw. The shader adds 1 to instanceCount (the second
// value) for each visible asteroid of the draw.
@group(0) @binding(2) var<storage, read_write> drawArgs: array<atomic<u32>>;
// COUNT entries for each draw: the asteroid indices of the visible instances.
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;

// Move point out of a circle around center, at a speed of at most maxStep in this frame.
fn pushOut(point: vec2f, center: vec2f, minimum: f32, maxStep: f32) -> vec2f {
  let offset = point - center;
  let dist = length(offset);
  if (dist >= minimum) {
    return point;
  }
  let outward = select(vec2f(1.0, 0.0), offset / dist, dist > 1e-3);
  return point + outward * min(minimum - dist, maxStep);
}

fn wrap(value: f32, low: f32, high: f32) -> f32 {
  return low + (value - low) - floor((value - low) / (high - low)) * (high - low);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn cs_update(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= COUNT) {
    return;
  }
  var asteroid = asteroids[index];
  let dt = params.seconds;

  // Move, and turn around the spin axis.
  asteroid.position += (asteroid.velocity - params.heading.xyz * params.flowSpeed) * dt;
  let spin = vec4f(asteroid.spinAxis * asteroid.spinSpeed, 0.0);
  let q = asteroid.orientation;
  // The derivative of the orientation is 0.5 * spin * q (quaternion product).
  let dq = 0.5 * vec4f(spin.w * q.xyz + q.w * spin.xyz + cross(spin.xyz, q.xyz), spin.w * q.w - dot(spin.xyz, q.xyz));
  asteroid.orientation = normalize(q + dq * dt);

  // Keep the asteroid in the box, and out of the clear tube, in the coordinates of the box.
  let relative = asteroid.position - params.shipCenter.xyz;
  var local = vec3f(dot(relative, params.right.xyz), dot(relative, params.up.xyz), dot(relative, params.heading.xyz));
  local = vec3f(wrap(local.x, BOX_MIN.x, BOX_MAX.x), wrap(local.y, BOX_MIN.y, BOX_MAX.y),
                wrap(local.z, BOX_MIN.z, BOX_MAX.z));
  let bound = asteroid.radius * BOUNDING_SCALE;
  let maxStep = CLEAR_PUSH_SPEED * dt;
  // The asteroid comes toward the ship at the flow speed minus its own speed along the heading.
  // With this exact speed, the path point of the asteroid does not change, so the asteroid moves
  // out of the tube only once, far in front of the ship.
  let closingSpeed = max(params.flowSpeed - dot(asteroid.velocity, params.heading.xyz), 1.0);
  let arrival = local.z / closingSpeed;
  let pathPoint = shipPathOffset(params.pathTime + arrival);
  var lateral = pushOut(local.xy, pathPoint.xy, SHIP_CLEARANCE + bound, maxStep);
  let cameraRelative = params.cameraPosition.xyz - params.shipCenter.xyz;
  let camera = vec2f(dot(cameraRelative, params.right.xyz), dot(cameraRelative, params.up.xyz));
  lateral = pushOut(lateral, camera, CAMERA_CLEARANCE + bound, maxStep);
  local = vec3f(lateral, local.z);
  asteroid.position = params.shipCenter.xyz + params.right.xyz * local.x + params.up.xyz * local.y
    + params.heading.xyz * local.z;
  asteroids[index] = asteroid;

  // Remove the asteroid if its bounding sphere is outside one of the planes of the view.
  for (var i = 0u; i < 6u; i++) {
    let plane = params.planes[i];
    if (dot(plane.xyz, asteroid.position) + plane.w < -bound) {
      return;
    }
  }

  let distance = length(asteroid.position - params.cameraPosition.xyz);
  let lod = select(1u, 0u, asteroid.radius > LOD_THRESHOLD * distance);
  let draw = asteroid.shape * LODS + lod;
  let slot = atomicAdd(&drawArgs[draw * DRAW_ARGS_SIZE + 1u], 1u);
  visible[draw * COUNT + slot] = index;
}
