// Scene: the ship flies through a field of asteroids, with no terrain. The background has stars,
// a nebula, and a ringed planet with two moons. The camera does not move, and the ship moves
// around the asteroids on a smooth path. It turns its nose along the path and banks into turns.

import { Asteroids, FLOW_SPEED } from '../asteroids.js';
import type { Vec3 } from '../mat4.js';
import { ShipPath } from '../ship-path.js';
import { Sky } from '../sky.js';
import type { Scene, SharedObjects, ShipTurn } from './scene.js';

// The ship path, in meters from the start position: wide turns to the right and left, smaller
// moves up and down, and a little forward and back. The camera is 250 m behind the start position,
// so the ship stays in the view.
const SHIP_PATH = new ShipPath(
  [
    { axis: 0, amplitude: 70, period: 9, phase: 0 },
    { axis: 0, amplitude: 22, period: 4.1, phase: 1.0 },
    { axis: 1, amplitude: 28, period: 7, phase: 0.5 },
    { axis: 1, amplitude: 9, period: 3.3, phase: 2.0 },
    { axis: 2, amplitude: 20, period: 11, phase: 0 },
  ],
  3,
);
// The bank angle in radians for each m/s² of acceleration to the side, and its limit.
const BANK_PER_ACCELERATION = 0.03;
const MAX_BANK = 0.7;

// The turn of the ship along its path. The asteroids move toward the camera at FLOW_SPEED, so the
// ship moves forward through them at FLOW_SPEED plus the forward speed of the path.
function shipTurn(time: number, speedScale: number): ShipTurn {
  const step = 1 / 60;
  const before = SHIP_PATH.offset(time - step);
  const now = SHIP_PATH.offset(time);
  const after = SHIP_PATH.offset(time + step);
  const velocity = [0, 1, 2].map((i) => (after[i] - before[i]) / (2 * step));
  const acceleration = [0, 1, 2].map((i) => (after[i] - 2 * now[i] + before[i]) / (step * step));
  const forward = FLOW_SPEED * speedScale + velocity[2];
  const roll = Math.max(-MAX_BANK, Math.min(MAX_BANK, acceleration[0] * BANK_PER_ACCELERATION));
  return {
    yaw: Math.atan2(velocity[0], forward),
    pitch: Math.atan2(velocity[1], Math.hypot(forward, velocity[0])),
    roll,
  };
}

export function createAsteroidScene(shared: SharedObjects): Scene {
  const asteroids = new Asteroids(
    shared.device,
    shared.format,
    shared.depthFormat,
    shared.sun,
    shared.shipCenter,
    shared.heading,
    SHIP_PATH,
    shared.cameraStart,
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
    stationaryCamera: true,
    update({ encoder, seconds, sceneTime, speedScale, viewProjection, cameraPosition }) {
      const offset: Vec3 = SHIP_PATH.offset(sceneTime);
      shared.moveShip(offset, shipTurn(sceneTime, speedScale));
      asteroids.setCamera(viewProjection, cameraPosition);
      sky.setCamera(viewProjection, cameraPosition);
      asteroids.update(encoder, seconds, speedScale, sceneTime);
    },
    draw(pass) {
      asteroids.draw(pass);
      // After the asteroids, so that the depth test skips the sky behind them.
      sky.draw(pass);
    },
  };
}
