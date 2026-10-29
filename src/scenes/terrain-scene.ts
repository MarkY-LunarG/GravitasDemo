// Scene: the ship flies above the terrain. The terrain features move toward the ship.
// FLY_OFF_TIME seconds before the end, the ship boosts and flies away from the camera.
// The sky above the terrain is black with stars.

import { Sky } from '../sky.js';
import type { Scene, SharedObjects } from './scene.js';

// The speed at which the terrain features move toward the ship, in meters per second.
const TERRAIN_SPEED = 1200;
const DURATION = 40;
// The ship flies off with a constant acceleration in meters per second squared. In 3 seconds, it
// goes approximately 2.7 km, so it is very small before the fade to black.
const FLY_OFF_TIME = 3;
const FLY_OFF_ACCELERATION = 600;

export function createTerrainScene(shared: SharedObjects): Scene {
  // The terrain samples its height field at worldPos. worldPos moves along the heading, so the
  // terrain features come toward the ship, but the ship does not move until it flies off.
  const worldPos = [0, 0, 0];
  const sky = new Sky(shared.device, shared.format, shared.depthFormat, shared.sun, shared.heading, {
    nebula: false,
    planet: null,
  });
  return {
    name: 'Terrain and ship',
    duration: DURATION,
    update({ seconds, sceneTime, speedScale, viewProjection, cameraPosition }) {
      sky.setCamera(viewProjection, cameraPosition);
      const distance = TERRAIN_SPEED * speedScale * seconds;
      worldPos[0] += shared.heading[0] * distance;
      worldPos[2] += shared.heading[2] * distance;
      shared.terrain.update([worldPos[0], worldPos[1], worldPos[2]]);

      const flyTime = sceneTime - (DURATION - FLY_OFF_TIME);
      if (flyTime >= 0) {
        shared.ship.setBoost(true);
        shared.moveShipForward(0.5 * FLY_OFF_ACCELERATION * flyTime * flyTime);
      }
    },
    draw(pass) {
      shared.terrain.draw(pass);
      // After the terrain, so that the depth test skips the sky behind the terrain.
      sky.draw(pass);
    },
  };
}
