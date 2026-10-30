// The part of fs_sky in sky.wgsl that draws the planet, the ring, and the moons over the
// background color.

    // The planet, the ring, and the moons, from far to near.
    var layers: array<Layer, 2u + MOON_COUNT>;
    var count = 0u;
    let planet = raySphere(dir, PLANET_CENTER, PLANET_RADIUS, pixelAngle);
    if (planet.y > 0.0) {
      let n = normalize(dir * planet.x - PLANET_CENTER);
      layers[count] = Layer(planet.x, vec4f(shadePlanet(n, dir), planet.y));
      count++;
    }
    let ringDistance = dot(PLANET_CENTER, RING_NORMAL) / dot(dir, RING_NORMAL);
    if (ringDistance > 0.0) {
      let ring = shadeRing(dir, ringDistance, pixelAngle);
      if (ring.a > 0.0) {
        layers[count] = Layer(ringDistance, ring);
        count++;
      }
    }
    var moons = MOONS;
    for (var i = 0u; i < MOON_COUNT; i++) {
      let moon = moons[i];
      let hit = raySphere(dir, moon.center, moon.radius, pixelAngle);
      if (hit.y > 0.0) {
        let n = normalize(dir * hit.x - moon.center);
        layers[count] = Layer(hit.x, vec4f(shadeMoon(n, moon.seed), hit.y));
        count++;
      }
    }
    // Sort from far to near, then blend each layer over the color.
    for (var i = 1u; i < count; i++) {
      var j = i;
      while (j > 0u && layers[j - 1u].distance < layers[j].distance) {
        let swap = layers[j];
        layers[j] = layers[j - 1u];
        layers[j - 1u] = swap;
        j--;
      }
    }
    for (var i = 0u; i < count; i++) {
      color = mix(color, layers[i].color.rgb, layers[i].color.a);
    }
