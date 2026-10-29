// Scene: the ship flies through a field of asteroids, with no terrain. The background has stars,
// a nebula, and a ringed planet with two moons.

import { Asteroids } from '../asteroids.js';
import { Sky } from '../sky.js';
import type { Scene, SharedObjects } from './scene.js';

export function createAsteroidScene(shared: SharedObjects): Scene {
  const asteroids = new Asteroids(
    shared.device,
    shared.format,
    shared.depthFormat,
    shared.sun,
    shared.shipCenter,
    shared.heading,
  );
  // The planet is to the right of the view center and a little above it. The camera looks 10
  // degrees down.
  const sky = new Sky(shared.device, shared.format, shared.depthFormat, shared.sun, shared.heading, {
    nebula: true,
    planet: { rightDegrees: 17, elevationDegrees: -2, radiusDegrees: 6.5 },
  });
  return {
    name: 'Asteroids and ship',
    duration: Infinity,
    update({ encoder, seconds, speedScale, viewProjection, cameraPosition }) {
      asteroids.setCamera(viewProjection, cameraPosition);
      sky.setCamera(viewProjection, cameraPosition);
      asteroids.update(encoder, seconds, speedScale);
    },
    draw(pass) {
      asteroids.draw(pass);
      // After the asteroids, so that the depth test skips the sky behind them.
      sky.draw(pass);
    },
  };
}
