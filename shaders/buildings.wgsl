// The glass towers and the background of the cube maps (src/app/buildings.cpp). The constants come
// from buildings.cpp, and the light from light.wgsl.

struct Camera {
  viewProjection: mat4x4f,
  position: vec4f,
  // The directions of the screen right, the screen up, and the view, for the background.
  right: vec4f,
  up: vec4f,
  forward: vec4f,
}

struct Tower {
  // xyz: the center. w: how much the glass reflects (0 to 1).
  center: vec4f,
  // xyz: the size. w: the rotation around the vertical axis (radians).
  size: vec4f,
  tint: vec4f,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> towers: array<Tower>;
// The cube map that the towers reflect.
@group(0) @binding(2) var environment: texture_cube<f32>;
@group(0) @binding(3) var environmentSampler: sampler;

// A simple sky: yellow-brown haze, brighter near the horizon and the sun, with the sun and its
// glow. Below the horizon, dark brown ground that fades into the haze far away.
fn background(dir: vec3f) -> vec3f {
  let horizon = -HORIZON_SIN;
  let toSun = max(dot(dir, light.direction), 0.0);
  let height = saturate((dir.y - horizon) * 2.5);
  var haze = mix(vec3f(0.82, 0.64, 0.36), vec3f(0.36, 0.25, 0.12), height) * light.color;
  haze += vec3f(0.35, 0.25, 0.1) * pow(toSun, 8.0);
  var color = haze;
  if (dir.y < horizon) {
    let ground = vec3f(0.16, 0.11, 0.07) * (light.ambient + light.color * 0.5);
    color = mix(ground, haze, exp(-(horizon - dir.y) * 12.0));
  }
  color += light.color * (smoothstep(0.99925, 0.99955, toSun) * 2.5 + pow(toSun, 300.0) * 0.9);
  return color;
}

struct BackgroundOutput {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}

@vertex
fn vs_background(@builtin(vertex_index) index: u32) -> BackgroundOutput {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: BackgroundOutput;
  output.position = vec4f(corners[index], 1.0, 1.0);
  output.clip = corners[index];
  return output;
}

// A cube face has a 90-degree field of view, so the view direction at a clip position is the
// forward direction plus the clip position along the right and up directions.
@fragment
fn fs_background(input: BackgroundOutput) -> @location(0) vec4f {
  let dir = normalize(camera.forward.xyz + camera.right.xyz * input.clip.x + camera.up.xyz * input.clip.y);
  return vec4f(background(dir), 1.0);
}

struct TowerOutput {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) normal: vec3f,
  // The position on the tower in meters, from its center, before the rotation.
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) tint: vec3f,
  @location(4) @interpolate(flat) reflectivity: f32,
  @location(5) @interpolate(flat) instance: u32,
  // The normal before the rotation.
  @location(6) localNormal: vec3f,
}

// Rotate v around the vertical axis by yaw. The local x axis goes to (cos, 0, -sin).
fn rotateYaw(v: vec3f, yaw: f32) -> vec3f {
  let c = cos(yaw);
  let s = sin(yaw);
  return vec3f(c * v.x + s * v.z, v.y, c * v.z - s * v.x);
}

@vertex
fn vs_tower(@location(0) position: vec3f, @location(1) normal: vec3f,
            @builtin(instance_index) instance: u32) -> TowerOutput {
  let tower = towers[instance];
  let local = position * tower.size.xyz;
  let world = tower.center.xyz + rotateYaw(local, tower.size.w);
  var output: TowerOutput;
  output.position = camera.viewProjection * vec4f(world, 1.0);
  output.worldPosition = world;
  output.normal = rotateYaw(normal, tower.size.w);
  output.localNormal = normal;
  output.local = local;
  output.tint = tower.tint.rgb;
  output.reflectivity = tower.center.w;
  output.instance = instance;
  return output;
}

// The color of a tower (rgb), and how much its glass reflects at this point (a). Glass panes are
// between dark frames. The glass reflects the cube map, more at grazing angles (Fresnel), and it
// shows the bright reflection of the sun.
fn shadeTower(input: TowerOutput) -> vec4f {
  let n = normalize(input.normal);
  let toCamera = normalize(camera.position.xyz - input.worldPosition);
  let reflected = reflect(-toCamera, n);
  // Sample and take the derivatives first: they must be in uniform control flow.
  let mirror = textureSample(environment, environmentSampler, reflected).rgb;
  let floorScale = fwidth(input.local.y / 4.0);
  let columnScale = max(fwidth(input.local.x / 3.0), fwidth(input.local.z / 3.0));

  // The floors are 4 meters high, and the columns are 3 meters wide. The roof has no windows.
  let across = select(input.local.x, input.local.z, abs(input.localNormal.x) > 0.5);
  let floorPosition = fract(input.local.y / 4.0);
  let columnPosition = fract(across / 3.0);
  var pane = smoothstep(0.0, 0.08, floorPosition) * smoothstep(1.0, 0.92, floorPosition)
    * smoothstep(0.0, 0.06, columnPosition) * smoothstep(1.0, 0.94, columnPosition);
  // Where a pane is smaller than approximately a pixel, the pattern changes to its average, so far
  // towers do not show moire patterns.
  let detail = saturate(1.5 - max(floorScale, columnScale) * 4.0);
  pane = mix(0.8, pane, detail);
  pane = select(pane, 0.6, n.y > 0.5);

  let fresnel = 0.55 + 0.45 * pow(1.0 - saturate(dot(n, toCamera)), 4.0);
  let glass = mix(applyLight(input.tint * 0.35, n), mirror * input.tint * 1.2, fresnel * input.reflectivity);
  let frame = applyLight(vec3f(0.12, 0.11, 0.1), n);
  var color = mix(frame, glass, pane);
  color += light.color * pow(saturate(dot(reflected, light.direction)), 400.0) * 3.0 * pane;
  return vec4f(color, fresnel * input.reflectivity * pane);
}

@fragment
fn fs_tower(input: TowerOutput) -> @location(0) vec4f {
  return vec4f(shadeTower(input).rgb, 1.0);
}

// The mirror images of the ship, and the id (plus 1) of the wall of each image. Only the main pass
// uses them.
@group(2) @binding(0) var shipImage: texture_2d<f32>;
@group(2) @binding(1) var shipImageId: texture_2d<u32>;

// The id of a wall: 4 for each tower, in the order +X, -X, +Z, and -Z of the tower before its
// rotation. The roof and the floor have no id.
fn wallId(normal: vec3f, instance: u32) -> u32 {
  var side = 4u;
  if (normal.x > 0.5) {
    side = 0u;
  } else if (normal.x < -0.5) {
    side = 1u;
  } else if (normal.z > 0.5) {
    side = 2u;
  } else if (normal.z < -0.5) {
    side = 3u;
  }
  return select(instance * 4u + side, 0xffffffffu, side == 4u);
}

@fragment
fn fs_tower_main(input: TowerOutput) -> @location(0) vec4f {
  let shaded = shadeTower(input);
  var color = shaded.rgb;
  let pixel = vec2i(input.position.xy);
  if (textureLoad(shipImageId, pixel, 0).r == wallId(input.localNormal, input.instance) + 1u) {
    // The ship is brighter than most of the environment, so its reflection is stronger and less
    // tinted than the reflection of the cube map.
    let shipColor = textureLoad(shipImage, pixel, 0).rgb * mix(input.tint, vec3f(1.0), 0.5) * 1.2;
    color = mix(color, shipColor, saturate(shaded.a * 1.5));
  }
  return vec4f(color, 1.0);
}
