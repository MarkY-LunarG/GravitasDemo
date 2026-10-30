// Scene: the ship flies over a dark brown land with reflective glass towers. The sky is the
// yellow-brown haze of the planet (as deep in the atmospheric entry), with the sun in front of the
// ship at the upper right of the screen. The camera is at the right side of the ship, and looks a
// little in front of it, so the ship is approximately one third from the left edge of the screen.
// The ship flies from left to right, so the land and the towers move from right to left.
// A lens flare shows when the sun is not behind the towers. Occlusion queries measure how much of
// the sun is visible (see lens-flare.ts).

import { Buildings } from '../buildings.js';
import { LensFlare } from '../lens-flare.js';
import type { Vec3 } from '../mat4.js';
import { Sky } from '../sky.js';
import type { Scene, SharedObjects } from './scene.js';

// The speed of the land and the towers past the ship, in meters per second.
const SPEED = 350;
// The camera looks this many meters in front of the ship.
const LOOK_AHEAD = 60;
// The sun: in front of the ship, on the far side from the camera, and a little above the horizon.
// The ambient light has the same color.
const SUN_COLOR: Vec3 = [1.2, 0.98, 0.66];
const AMBIENT_STRENGTH = 0.175;
// Dark brown ground, with lower hills than the terrain scene, and no craters.
const TERRAIN_STYLE = {
  lowColor: [0.12, 0.08, 0.05],
  highColor: [0.3, 0.2, 0.12],
  heightScale: 0.3,
  craterScale: 0,
} as const;

export function createCityScene(shared: SharedObjects): Scene {
  const { device, format, depthFormat, sun, heading } = shared;
  const right: Vec3 = [-heading[2], 0, heading[0]];
  // Forward along the heading, away from the camera (-right), and up.
  const toSun = [0, 1, 2].map((i) => heading[i] * 0.55 - right[i] * 1.0 + (i === 1 ? 0.16 : 0));
  const length = Math.hypot(toSun[0], toSun[1], toSun[2]);
  const sky = new Sky(device, format, depthFormat, sun, heading, {
    nebula: false,
    planet: null,
    atmosphere: true,
    sunDisk: true,
  });
  const lensFlare = new LensFlare(device, format, depthFormat);
  const buildings = new Buildings(device, format, depthFormat, sun, shared.shipCenter, heading, shared.ship);
  // The terrain samples its height field at worldPos, which moves along the heading.
  const worldPos = [0, 0, 0];
  let scroll = 0;
  const sunDirection: Vec3 = [toSun[0] / length, toSun[1] / length, toSun[2] / length];
  return {
    name: 'City flyover',
    duration: Infinity,
    cameraAngle: -90,
    cameraLookAhead: LOOK_AHEAD,
    sun: {
      direction: sunDirection,
      color: SUN_COLOR,
      ambient: [
        SUN_COLOR[0] * AMBIENT_STRENGTH,
        SUN_COLOR[1] * AMBIENT_STRENGTH,
        SUN_COLOR[2] * AMBIENT_STRENGTH,
      ],
    },
    terrainStyle: TERRAIN_STYLE,
    update({ encoder, seconds, viewProjection, cameraPosition, width, height }) {
      scroll += SPEED * seconds;
      worldPos[0] = heading[0] * scroll;
      worldPos[2] = heading[2] * scroll;
      shared.terrain.update([worldPos[0], worldPos[1], worldPos[2]]);
      sky.setCamera(viewProjection, cameraPosition);
      // Deep in the atmosphere, with no lightning, a level horizon, and no tilt.
      sky.setAtmosphere(1, 0, [0, 0], 0.03, 0, width / height);
      buildings.update(encoder, scroll, viewProjection, cameraPosition, width, height);
      lensFlare.update(viewProjection, sunDirection, SUN_COLOR, width / height);
    },
    draw(pass) {
      shared.terrain.draw(pass);
      buildings.draw(pass);
      // After the opaque objects, so that the depth test skips the sky behind them.
      sky.draw(pass);
    },
    occlusionQuerySet: lensFlare.querySet,
    drawOcclusionQueries(pass) {
      lensFlare.drawProbes(pass);
    },
    afterMainPass(encoder) {
      lensFlare.resolve(encoder);
    },
    drawPost(pass) {
      lensFlare.draw(pass);
    },
  };
}
