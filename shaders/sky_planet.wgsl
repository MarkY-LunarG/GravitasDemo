// The planet, the ring, and the moons of the sky (src/app/sky.cpp), in a space where the camera is
// at the origin and the planet center is 1 unit away. The constants come from sky.cpp.

// The distance along the ray to the near surface of a sphere, and the coverage of the pixel
// (0 to 1) with a smooth edge of one pixel. The ray starts at the origin.
fn raySphere(dir: vec3f, center: vec3f, radius: f32, pixelAngle: f32) -> vec2f {
  let along = dot(dir, center);
  let closest2 = max(dot(center, center) - along * along, 0.0);
  let coverage = saturate((radius - sqrt(closest2)) / (pixelAngle * along) + 0.5);
  let inside = max(radius * radius - closest2, 0.0);
  return vec2f(along - sqrt(inside), select(0.0, coverage, along > 0.0));
}

// The light of the sun on a surface with normal n. The terminator is soft, and the night side
// has a little light, as in the reference image.
fn sunLight(n: vec3f) -> f32 {
  return smoothstep(-0.08, 0.4, dot(n, light.direction));
}

fn shadePlanet(n: vec3f, dir: vec3f) -> vec3f {
  // Bands that are parallel to the ring, with swirls.
  let latitude = dot(n, RING_NORMAL);
  let warp = perlin3(n * 4.0, 400u) * 0.8 + perlin3(n * 9.0, 401u) * 0.3;
  let bands = sin(latitude * 14.0 + warp * 3.0) * 0.5 + 0.5;
  var base = mix(vec3f(0.36, 0.28, 0.2), vec3f(0.62, 0.52, 0.38), bands);
  base = mix(base, vec3f(0.33, 0.37, 0.42), smoothstep(0.15, 0.6, perlin3(n * 7.0 + warp, 402u)));
  base *= 0.85 + 0.3 * perlin3(n * 22.0, 403u);
  let lit = sunLight(n);
  var color = base * (lit * light.color + vec3f(0.025, 0.03, 0.05));
  // A thin gold atmosphere at the edge of the lit side.
  let edge = pow(1.0 - max(dot(n, -dir), 0.0), 4.0);
  color += vec3f(1.0, 0.72, 0.32) * edge * smoothstep(-0.2, 0.5, dot(n, light.direction)) * 0.9;
  return color;
}

fn shadeMoon(n: vec3f, seed: u32) -> vec3f {
  let base = vec3f(0.5, 0.45, 0.4) * (0.75 + 0.5 * perlin3(n * 6.0, 500u + seed));
  return base * (sunLight(n) * light.color + vec3f(0.02, 0.025, 0.04));
}

// The ring at a distance along the ray: color and alpha. alpha is 0 outside the ring.
fn shadeRing(dir: vec3f, rayDistance: f32, pixelAngle: f32) -> vec4f {
  let point = dir * rayDistance;
  let r = length(point - PLANET_CENTER) / PLANET_RADIUS;
  let edge = pixelAngle * rayDistance / PLANET_RADIUS;
  let inRing = smoothstep(RING_INNER - edge, RING_INNER + edge, r)
    * (1.0 - smoothstep(RING_OUTER - edge, RING_OUTER + edge, r));
  if (inRing <= 0.0) {
    return vec4f(0.0);
  }
  // Light and dark bands, and gaps.
  let density = saturate(0.55 + 0.9 * perlin3(vec3f(r * 22.0, 0.5, 0.5), 600u));
  // The planet shadow: the ray from the ring point toward the sun goes through the planet.
  let toPlanet = PLANET_CENTER - point;
  let along = dot(toPlanet, light.direction);
  let shadowed = along > 0.0 && length(toPlanet - light.direction * along) < PLANET_RADIUS;
  let lit = select(0.25 + 0.75 * abs(dot(RING_NORMAL, light.direction)), 0.06, shadowed);
  let color = vec3f(0.78, 0.67, 0.5) * lit * light.color;
  return vec4f(color, inRing * density * 0.85);
}
