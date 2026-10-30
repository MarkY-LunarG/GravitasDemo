// Scene: the ship flies into the atmosphere of a yellow-brown planet. The camera does not move. It
// is at the right side of the ship, so the front of the ship points to the right of the screen.
//
// Timeline, in seconds from the start of the scene:
// - 0 to 25: the ship goes from space down into the atmosphere. The horizon comes up, and the haze
//   covers the stars.
// - 1 to 26: re-entry fire: flames around the front of the ship that trail back, and smoke. The fire lights the ship. It is strongest from 6 to 16, and it goes out as the rain
//   starts. The ship shakes with the heat and in the rain.
// - From 10: clouds come past the ship. From 18: rain on the camera lens, which the air pushes
//   from the front of the ship to its back. From 20: lightning around the edges.
// After 30 seconds, the rain, the clouds, and the lightning continue.

import { Clouds } from '../clouds.js';
import { Lightning } from '../lightning.js';
import { Rain } from '../rain.js';
import { Reentry } from '../reentry.js';
import { Sky } from '../sky.js';
import type { Scene, SharedObjects } from './scene.js';

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// The angle of the horizon below the horizontal, in space and deep in the atmosphere.
const HORIZON_DIP = [0.3, 0.03] as const;
// The tilt of the horizon: it is higher in front of the ship (at the right of the screen) and lower
// behind it, so the ship seems to go down into the planet.
const HORIZON_TILT = (14 * Math.PI) / 180;
// The size in meters and radians of the shake at full strength.
const SHAKE_OFFSET = 1.2;
const SHAKE_ROLL = 0.03;
// The air pushes the drops on the lens straight toward the back of the ship. RAIN_FALL is the size
// of a fall, relative to the push.
const RAIN_FALL = 0;

export function createEntryScene(shared: SharedObjects): Scene {
  const { device, format, depthFormat, sun } = shared;
  const sky = new Sky(device, format, depthFormat, sun, shared.heading, {
    nebula: false,
    planet: null,
    atmosphere: true,
  });
  const clouds = new Clouds(device, format, depthFormat, sun, shared.shipCenter, shared.heading);
  const rain = new Rain(device, format);
  const lightning = new Lightning(device, format, depthFormat);
  const reentry = new Reentry(device, format, depthFormat);
  return {
    name: 'Atmospheric entry',
    duration: Infinity,
    cameraAngle: -90,
    // The ship falls into the atmosphere with its engines off.
    engines: false,
    update({ seconds, sceneTime: t, viewProjection, cameraPosition, width, height }) {
      const depth = smoothstep(0, 25, t);
      // The re-entry fire: it grows from 1 to 6, and it goes out from 16 to 26, as the rain starts.
      const heat = smoothstep(1, 6, t) * (1 - smoothstep(16, 26, t));
      const cloudDensity = smoothstep(10, 18, t);
      const rainLevel = smoothstep(18, 26, t);

      // The ship shakes with the heat, and less in the rain. Sums of sine waves at different rates
      // give a shake that does not repeat in a short pattern.
      const shake = Math.min(1, heat * 1.3 + rainLevel * 0.35);
      shared.ship.setHeat(heat);
      reentry.update(seconds, t, heat, shared.shipCenter, shared.heading, viewProjection, cameraPosition);
      shared.moveShip(
        [
          (Math.sin(t * 13.1) + 0.5 * Math.sin(t * 31.7)) * SHAKE_OFFSET * shake,
          (Math.sin(t * 17.3 + 1.0) + 0.5 * Math.sin(t * 27.9)) * SHAKE_OFFSET * shake,
          0,
        ],
        { yaw: 0, pitch: 0, roll: (Math.sin(t * 9.7) + 0.6 * Math.sin(t * 23.3)) * SHAKE_ROLL * shake },
      );

      const aspect = width / height;
      lightning.update(t, t > 20, aspect);
      const flash = lightning.brightness;
      const flashPosition = lightning.position;
      sky.setCamera(viewProjection, cameraPosition);
      sky.setAtmosphere(
        depth,
        flash,
        flashPosition,
        HORIZON_DIP[0] + (HORIZON_DIP[1] - HORIZON_DIP[0]) * depth,
        HORIZON_TILT,
        aspect,
      );
      clouds.update(seconds, cloudDensity, flash, flashPosition, aspect, viewProjection, cameraPosition);
      // The screen direction to the back of the ship comes from two points on the ship axis.
      const project = (p: readonly number[]) => {
        const m = viewProjection;
        const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
        return [
          ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w) * width,
          ((m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) * height,
        ];
      };
      const front = project(shared.shipCenter);
      const back = project(shared.shipCenter.map((value, i) => value - shared.heading[i] * 50));
      const toBack = [back[0] - front[0], back[1] - front[1]];
      const toBackLength = Math.hypot(toBack[0], toBack[1]) || 1;
      rain.update(t, rainLevel, width, height, [
        toBack[0] / toBackLength,
        toBack[1] / toBackLength - RAIN_FALL,
      ]);
    },
    draw(pass) {
      sky.draw(pass);
    },
    // The ship can be in the clouds. The lightning is on the screen.
    drawAfterShip(pass) {
      clouds.draw(pass);
      // The fire and its smoke glow through the clouds near the ship.
      reentry.draw(pass);
      lightning.draw(pass);
    },
    // The rain is on the camera lens: it bends the image of the scene.
    drawPost(pass, sceneView) {
      rain.draw(pass, sceneView);
    },
  };
}
