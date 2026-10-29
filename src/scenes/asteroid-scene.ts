// Scene: the ship flies through a field of asteroids, with no terrain.

import { Asteroids } from '../asteroids.js';
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
  return {
    name: 'Asteroids and ship',
    duration: Infinity,
    update({ encoder, seconds, speedScale, viewProjection, cameraPosition }) {
      asteroids.setCamera(viewProjection, cameraPosition);
      asteroids.update(encoder, seconds, speedScale);
    },
    draw(pass) {
      asteroids.draw(pass);
    },
  };
}
