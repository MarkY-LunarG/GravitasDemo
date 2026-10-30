// The shared directional light (src/app/light.cpp). Group 1 is LIGHT_BIND_GROUP in light.h.
// applyLight() gives the color of a surface with a world-space normal.
// applyShadowedLight() also multiplies the sunlight by the fraction of the sun that the surface
// can see, from 0 (in shadow) to 1 (in full sun). The ambient light is not changed.

struct DirectionalLight {
  // The unit vector from a surface toward the light.
  direction: vec3f,
  color: vec3f,
  ambient: vec3f,
}
@group(1) @binding(0) var<uniform> light: DirectionalLight;

fn applyShadowedLight(baseColor: vec3f, worldNormal: vec3f, sunVisibility: f32) -> vec3f {
  let diffuse = max(dot(normalize(worldNormal), light.direction), 0.0);
  return baseColor * (light.ambient + light.color * diffuse * sunVisibility);
}

fn applyLight(baseColor: vec3f, worldNormal: vec3f) -> vec3f {
  return applyShadowedLight(baseColor, worldNormal, 1.0);
}
