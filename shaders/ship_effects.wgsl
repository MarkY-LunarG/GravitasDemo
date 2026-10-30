// The uniform with the effects of the whole ship (src/app/ship.cpp): the engine lights, the heat,
// and the camera. ship.wgsl and ship_glow.wgsl both use it. The constants come from ship.cpp.

struct EngineLight {
  // The world position of the light. w is not used.
  position: vec4f,
  // The color multiplied by the current strength. It is 0 when the engines are off.
  color: vec4f,
}

struct ShipEffects {
  lights: array<EngineLight, ENGINE_LIGHT_COUNT>,
  // xyz is the world direction of the ship front, and w is the heat level (0 to 1).
  heat: vec4f,
  // The camera position. w is the time in seconds, for the plasma streaks.
  camera: vec4f,
  viewProjection: mat4x4f,
}
@group(0) @binding(1) var<uniform> effects: ShipEffects;

// The color of hot metal and plasma: orange, then yellow, then white.
fn heatColor(level: f32) -> vec3f {
  let t = saturate(level);
  return mix(mix(vec3f(1.0, 0.22, 0.04), vec3f(1.0, 0.65, 0.2), saturate(t * 2.0)),
             vec3f(1.0, 0.95, 0.85), saturate(t * 2.0 - 1.0));
}
