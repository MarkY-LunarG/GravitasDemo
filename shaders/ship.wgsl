// The ship (src/app/ship.cpp): the lit solid parts, the unlit flames, the heat shell, the plasma
// streaks, and the mirror images. The constants come from ship.cpp, the light from light.wgsl, the
// noise from noise.wgsl, and the effects from ship_effects.wgsl.

struct DrawUniforms {
  mvp: mat4x4f,
  model: mat4x4f,
  baseColor: vec4f,
  morphWeights: vec4f,
}
@group(0) @binding(0) var<uniform> draw: DrawUniforms;

struct LitOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) worldPosition: vec3f,
}

// The diffuse light from the engine lights. The light falls off with distance, and it is 0 at
// ENGINE_LIGHT_RANGE. The engine lights do not cast shadows.
fn engineLighting(worldPosition: vec3f, normal: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0u; i < ENGINE_LIGHT_COUNT; i++) {
    let toLight = effects.lights[i].position.xyz - worldPosition;
    let dist = length(toLight);
    let diffuse = max(dot(normal, toLight / dist), 0.0);
    let falloff = 1.0 / (1.0 + (dist * dist) / (ENGINE_LIGHT_REFERENCE * ENGINE_LIGHT_REFERENCE));
    let window = saturate(1.0 - pow(dist / ENGINE_LIGHT_RANGE, 4.0));
    sum += effects.lights[i].color.rgb * diffuse * falloff * window * window;
  }
  return sum;
}

// The model matrix has only rotation, translation, and uniform scale, so it can also
// transform the normals.
@vertex
fn vs_lit(@location(0) position: vec3f, @location(1) normal: vec3f) -> LitOutput {
  var output: LitOutput;
  output.position = draw.mvp * vec4f(position, 1.0);
  output.worldNormal = (draw.model * vec4f(normal, 0.0)).xyz;
  output.worldPosition = (draw.model * vec4f(position, 1.0)).xyz;
  return output;
}

@fragment
fn fs_lit(input: LitOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);
  let engineLight = draw.baseColor.rgb * engineLighting(input.worldPosition, normal);
  // Re-entry heating: the surfaces that face forward glow.
  let facing = saturate(dot(normal, effects.heat.xyz));
  let glow = effects.heat.w * pow(facing, 1.5) * 1.6;
  let heat = heatColor(glow) * glow;
  // The fire around the ship lights it. The light wraps around the ship, and it is strongest on the
  // surfaces that face back into the flame.
  let time = effects.camera.w;
  let flicker = 0.8 + 0.2 * sin(time * 23.0) * sin(time * 37.0 + 1.3);
  let wrap = 0.35 + 0.65 * saturate(dot(normal, -effects.heat.xyz) * 0.5 + 0.5);
  let fireColor = FIRE_LIGHT * FIRE_LIGHT_STRENGTH;
  let fire = draw.baseColor.rgb * fireColor * effects.heat.w * flicker * wrap;
  return vec4f(applyLight(draw.baseColor.rgb, normal) + engineLight + heat + fire, draw.baseColor.a);
}

struct HeatOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) worldPosition: vec3f,
  @location(2) front: f32,
}

// The heat shell: the hull moved out along its normals, more at the front. The back of the shell
// is stretched back, as the hot gas flows past the ship.
@vertex
fn vs_heat(@location(0) position: vec3f, @location(1) normal: vec3f) -> HeatOutput {
  let worldNormal = normalize((draw.model * vec4f(normal, 0.0)).xyz);
  let forward = effects.heat.xyz;
  let front = saturate(dot(worldNormal, forward));
  let back = saturate(-dot(worldNormal, forward));
  let world = (draw.model * vec4f(position, 1.0)).xyz + worldNormal * (HEAT_SHELL + HEAT_SHELL_FRONT * front)
    - forward * HEAT_TRAIL * back;
  var output: HeatOutput;
  output.position = effects.viewProjection * vec4f(world, 1.0);
  output.worldNormal = worldNormal;
  output.worldPosition = world;
  output.front = front;
  return output;
}

// The back faces of the shell face away from the camera. Where they face directly away, the shell
// is behind the hull or near it, and the glow is bright. At the outer edge of the shell, the view is
// along its surface, and the glow is 0, so the edge is soft. The front of the shell is brightest.
@fragment
fn fs_heat(input: HeatOutput) -> @location(0) vec4f {
  let toCamera = normalize(effects.camera.xyz - input.worldPosition);
  let facing = abs(dot(normalize(input.worldNormal), toCamera));
  let level = effects.heat.w * pow(facing, 2.5) * (0.15 + 0.85 * input.front);
  return vec4f(heatColor(level * 1.4) * level * HEAT_SHELL_BRIGHTNESS, 0.0);
}

struct StreakOutput {
  @builtin(position) position: vec4f,
  // 0 at the hull and 1 at the end of the streak.
  @location(0) along: f32,
  // -1 to 1 across the streak.
  @location(1) across: f32,
  @location(2) @interpolate(flat) seed: f32,
  @location(3) @interpolate(flat) speed: f32,
  // The brightness of the streak, from its start point: 1 at the outline of the hull.
  @location(4) @interpolate(flat) weight: f32,
}

// Six vertices for each streak instance: two triangles of the ribbon. The model matrix of the hull
// moves the start point with the ship.
@vertex
fn vs_streak(@builtin(vertex_index) vertex: u32, @location(0) localPosition: vec3f,
             @location(1) localNormal: vec3f, @location(2) params: vec4f) -> StreakOutput {
  var corners = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
  let normal = normalize((draw.model * vec4f(localNormal, 0.0)).xyz);
  let back = -effects.heat.xyz;
  let heat = effects.heat.w;
  let streakLength = params.x * (0.5 + 0.5 * heat);
  // The streak starts a little out from the hull, goes back, and also moves out from the hull, as
  // the gas flows around the ship.
  let start = (draw.model * vec4f(localPosition, 1.0)).xyz + normal * 0.5;
  var point = start + back * streakLength * corner.x + normal * streakLength * corner.x * 0.15;
  let toCamera = normalize(effects.camera.xyz - point);
  let side = normalize(cross(back, toCamera));
  let outline = 1.0 - abs(dot(normal, normalize(effects.camera.xyz - start)));
  point += side * params.y * (1.0 + corner.x * 2.0) * corner.y;
  var output: StreakOutput;
  output.position = effects.viewProjection * vec4f(point, 1.0);
  output.along = corner.x;
  output.across = corner.y;
  output.seed = params.z;
  output.speed = params.w;
  // Each streak shows only at random times, from noise over time.
  let shown = saturate((perlin3(vec3f(effects.camera.w * 0.5, params.z, 0.5), 901u) + 0.05) * 4.0);
  output.weight = mix(STREAK_BODY_BRIGHTNESS, 1.0, outline * outline) * shown;
  return output;
}

@fragment
fn fs_streak(input: StreakOutput) -> @location(0) vec4f {
  let time = effects.camera.w;
  let flow = perlin3(vec3f(input.along * 7.0 - time * input.speed, input.across * 1.2, input.seed), 900u);
  let edge = 1.0 - input.across * input.across;
  let fade = pow(1.0 - input.along, 1.4) * smoothstep(0.0, 0.04, input.along);
  let level = effects.heat.w * input.weight * edge * fade * saturate(0.55 + flow) * STREAK_BRIGHTNESS;
  let hot = vec3f(1.0, 0.88, 0.95);
  let middle = vec3f(1.0, 0.45, 0.3);
  let cool = vec3f(0.55, 0.35, 1.0);
  let color = mix(mix(hot, middle, saturate(input.along * 2.5)), cool, saturate(input.along * 1.6 - 0.4));
  return vec4f(color * level, 0.0);
}

// Mirror images of the ship in flat mirrors, for example the glass walls of towers. Each instance
// draws the ship mirrored through one mirror. A fragment shows only where the view through the
// mirror rectangle sees it, so each image stays in its mirror. The pass writes the color, and the
// id of the mirror (plus 1) in a second target, so that the mirror can find its own image.
struct Mirror {
  // The reflection through the plane of the mirror, in world space.
  matrix: mat4x4f,
  // xyz: the unit normal of the mirror. w: the plane offset (normal . point = w).
  plane: vec4f,
  // xyz: the center of the mirror rectangle. w: the id of the mirror.
  center: vec4f,
  // The unit directions of the sides of the rectangle (xyz), and the half lengths (w).
  sideU: vec4f,
  sideV: vec4f,
}

struct MirrorView {
  viewProjection: mat4x4f,
  camera: vec4f,
}

@group(2) @binding(0) var<uniform> mirrorView: MirrorView;
@group(2) @binding(1) var<storage, read> mirrors: array<Mirror>;

struct MirroredOutput {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) @interpolate(flat) mirror: u32,
}

@vertex
fn vs_mirrored(@location(0) position: vec3f, @location(1) normal: vec3f,
               @builtin(instance_index) mirror: u32) -> MirroredOutput {
  let matrix = mirrors[mirror].matrix;
  let world = matrix * (draw.model * vec4f(position, 1.0));
  var output: MirroredOutput;
  output.position = mirrorView.viewProjection * world;
  output.worldPosition = world.xyz;
  output.worldNormal = (matrix * (draw.model * vec4f(normal, 0.0))).xyz;
  output.mirror = mirror;
  return output;
}

struct MirroredTargets {
  @location(0) color: vec4f,
  @location(1) id: u32,
}

@fragment
fn fs_mirrored(input: MirroredOutput) -> MirroredTargets {
  // The line from the camera to the mirror image must go through the mirror rectangle.
  let mirror = mirrors[input.mirror];
  let camera = mirrorView.camera.xyz;
  let toImage = input.worldPosition - camera;
  let t = (mirror.plane.w - dot(mirror.plane.xyz, camera)) / dot(mirror.plane.xyz, toImage);
  let hit = camera + toImage * t - mirror.center.xyz;
  if (t <= 0.0 || t >= 1.0 || abs(dot(hit, mirror.sideU.xyz)) > mirror.sideU.w
      || abs(dot(hit, mirror.sideV.xyz)) > mirror.sideV.w) {
    discard;
  }
  var targets: MirroredTargets;
  targets.color = vec4f(applyLight(draw.baseColor.rgb, input.worldNormal), 1.0);
  targets.id = u32(mirror.center.w) + 1u;
  return targets;
}

struct UnlitOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@vertex
fn vs_unlit(@location(0) position: vec3f, @location(1) color: vec4f, @location(2) target0: vec3f,
            @location(3) target1: vec3f) -> UnlitOutput {
  let morphed = position + target0 * draw.morphWeights.x + target1 * draw.morphWeights.y;
  var output: UnlitOutput;
  output.position = draw.mvp * vec4f(morphed, 1.0);
  output.color = color;
  return output;
}

@fragment
fn fs_unlit(input: UnlitOutput) -> @location(0) vec4f {
  let color = input.color * draw.baseColor;
  return vec4f(color.rgb * FLAME_BRIGHTNESS, color.a);
}
