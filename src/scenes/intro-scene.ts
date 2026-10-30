// Scene: the intro, before the benchmark. It is not part of the benchmark results.
//
// Timeline, in seconds from the start of the scene:
// - 0 to 3: the LunarG color logo on black.
// - 3 to 4.5: the color logo blends into the neon logo.
// - 4.5 to 6.5: the neon logo becomes brighter, with a bloom filter, and changes to the neon tube
//   logo.
// - 6.5 to 10: the neon tubes flicker on and off, as tubes that fail, and the bloom increases.
// - 10: a white flash. The G tube goes out (it is unlit glass), and the ship is in its place, at
//   the same size, with its front to the right. A light from the camera side lights the ship at
//   approximately half brightness.
// - 10 to 13.5: the engines ignite, the ship turns around, and it flies off to the left.
// - 12 to 12.6: as the ship goes away, the G tube flickers and comes on again.
// - 13.5 to 14: the App fades the image to black, and the benchmark starts.

import { Bloom } from '../bloom.js';
import { G_CENTER, G_HEIGHT, G_TUBE, IntroLogo, TUBE_COUNT, type IntroImages } from '../intro-logo.js';
import { invert, type Mat4, type Vec3 } from '../mat4.js';
import type { Scene, SharedObjects } from './scene.js';

const DURATION = 14;
const COLOR_END = 3;
const NEON_END = 4.5;
const TUBE_END = 6.5;
const FLASH_TIME = 10;
// The flash comes up in FLASH_RISE seconds and goes away in FLASH_FALL seconds.
const FLASH_RISE = 0.06;
const FLASH_FALL = 0.3;
// After the flash: the engines ignite, the ship turns around, and then it flies away.
const IGNITE_TIME = 10.6;
const TURN_START = 10.9;
const TURN_END = 11.8;
const FLY_START = 11.5;
// The G tube comes on again in this time, with a flicker.
const RELIGHT_START = 12;
const RELIGHT_END = 12.6;
// The light of the intro: from the camera side (the right of the ship), a little from above and in
// front. Its color and ambient color light the ship at approximately half brightness.
const LIGHT_COLOR: Vec3 = [0.34, 0.34, 0.37];
const LIGHT_AMBIENT: Vec3 = [0.09, 0.09, 0.1];
// The acceleration of the ship to the left, as a fraction of its distance from the camera in each
// second squared. With 0.8, the ship leaves the screen approximately 2 seconds after it starts.
const FLY_ACCELERATION = 0.8;
// The flicker changes state FLICKER_RATE times in each second. The chance that a tube is off goes
// from FAIL_START to FAIL_END during the flicker.
const FLICKER_RATE = 14;
const FAIL_START = 0.04;
const FAIL_END = 0.4;
const RANDOM_SEED = 4242;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// A random value from 0 to 1 for two integers, the same each time.
function hash(a: number, b: number): number {
  let x = Math.imul(a + RANDOM_SEED, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

// The brightness of each tube during the flicker. A tube is on, off, or dim, and the G fails most.
// All tubes have a small fast hum.
function tubeLevels(t: number): number[] {
  const fail = FAIL_START + (FAIL_END - FAIL_START) * smoothstep(TUBE_END, FLASH_TIME, t);
  const step = Math.floor(t * FLICKER_RATE);
  const levels: number[] = [];
  for (let tube = 0; tube < TUBE_COUNT; ++tube) {
    const chance = tube === G_TUBE ? Math.min(0.85, fail * 1.8) : fail;
    const value = hash(tube, step);
    let level = 1;
    if (value < chance * 0.6) {
      level = 0;
    } else if (value < chance) {
      level = 0.35;
    }
    const hum = 1 - 0.06 * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 60 + tube));
    levels.push(level * hum);
  }
  return levels;
}

// The NDC position (x and y) of a world point.
function project(m: Mat4, p: readonly number[]): [number, number, number] {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, w];
}

// The world point at an NDC position and an NDC depth.
function unproject(inverse: Mat4, x: number, y: number, z: number): Vec3 {
  const m = inverse;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

export function createIntroScene(shared: SharedObjects, images: IntroImages): Scene {
  const { device, format, depthFormat, ship, shipCenter, heading } = shared;
  const logo = new IntroLogo(device, format, depthFormat, images);
  const bloom = new Bloom(device, format);
  const right: Vec3 = [-heading[2], 0, heading[0]];
  const toLight = [0, 1, 2].map((i) => right[i] * 0.8 + heading[i] * 0.3 + (i === 1 ? 0.5 : 0));
  const lightLength = Math.hypot(toLight[0], toLight[1], toLight[2]);
  const lightDirection: Vec3 = [toLight[0] / lightLength, toLight[1] / lightLength, toLight[2] / lightLength];
  let time = 0;
  let size = { width: 1, height: 1 };
  let bloomThreshold = 1;
  let bloomIntensity = 0;
  let enginesOn = false;

  // Put the ship where the G is, at the same height on the screen. flyOffset moves it to the left,
  // as a fraction of its distance from the camera. yaw turns it.
  const placeShipOnG = (viewProjection: Mat4, cameraPosition: Vec3, flyOffset: number, yaw: number): void => {
    const [sx, sy] = logo.toScreen(G_CENTER[0], G_CENTER[1]);
    const x = (sx / size.width) * 2 - 1;
    const y = 1 - (sy / size.height) * 2;
    const targetHeight = (2 * G_HEIGHT * logo.screenScale) / size.height;
    // The ray from the camera through the G.
    const inverse = invert(viewProjection);
    const far = unproject(inverse, x, y, 1);
    const toFar = [far[0] - cameraPosition[0], far[1] - cameraPosition[1], far[2] - cameraPosition[2]];
    const length = Math.hypot(toFar[0], toFar[1], toFar[2]);
    const direction = toFar.map((value) => value / length);
    // The screen height of the ship is inversely proportional to its distance. Measure it at a
    // reference distance, and then move the ship to the distance of the G height.
    const reference = 1000;
    const at = (distance: number) => [0, 1, 2].map((i) => cameraPosition[i] + direction[i] * distance);
    const point = at(reference);
    const top = [point[0], point[1] + ship.height, point[2]];
    const referenceHeight = Math.abs(project(viewProjection, top)[1] - project(viewProjection, point)[1]);
    const distance = (reference * referenceHeight) / targetHeight;
    const position = at(distance);
    const delta = [0, 1, 2].map((i) => position[i] - shipCenter[i]);
    const along = delta[0] * heading[0] + delta[2] * heading[2];
    const across = delta[0] * right[0] + delta[2] * right[2];
    shared.moveShip([across, delta[1], along - flyOffset * distance], {
      yaw,
      pitch: 0,
      roll: Math.sin(Math.min(1, Math.max(0, (time - TURN_START) / (TURN_END - TURN_START))) * Math.PI) * 0.5,
    });
  };

  return {
    name: 'Intro',
    duration: DURATION,
    benchmark: false,
    engines: false,
    cameraAngle: -90,
    sun: {
      direction: lightDirection,
      color: LIGHT_COLOR,
      ambient: LIGHT_AMBIENT,
    },
    update({ sceneTime: t, viewProjection, cameraPosition, width, height }) {
      time = t;
      size = { width, height };
      const colorToNeon = smoothstep(COLOR_END, NEON_END, t);
      const neonToTube = smoothstep(NEON_END, TUBE_END, t);
      const afterFlash = t >= FLASH_TIME;
      const flicker = t >= TUBE_END && !afterFlash;
      const tubes = flicker ? tubeLevels(t) : new Array<number>(TUBE_COUNT).fill(1);
      // The G is off from the flash until the ship goes away. Then it flickers and comes on.
      if (afterFlash && t < RELIGHT_END) {
        const step = Math.floor(t * FLICKER_RATE * 1.5);
        const on = smoothstep(RELIGHT_START, RELIGHT_END, t);
        tubes[G_TUBE] = t >= RELIGHT_START && hash(G_TUBE + 100, step) < 0.25 + 0.75 * on ? 1 : 0;
      }
      const mean = tubes.reduce((sum, value) => sum + value, 0) / TUBE_COUNT;
      const flash =
        t < FLASH_TIME
          ? 0
          : t < FLASH_TIME + FLASH_RISE
            ? (t - FLASH_TIME) / FLASH_RISE
            : 1 - smoothstep(FLASH_TIME + FLASH_RISE, FLASH_TIME + FLASH_RISE + FLASH_FALL, t);
      logo.update(
        {
          colorToNeon,
          neonToTube,
          brightness: 1 + 0.3 * neonToTube,
          panel: 1,
          tubes,
          flash,
        },
        width,
        height,
      );

      // The bloom: none on the color logo, then more as the neon logo becomes brighter, more in the
      // flicker, and a peak at the flash.
      bloomThreshold = 0.6;
      bloomIntensity =
        0.3 * colorToNeon +
        0.4 * neonToTube +
        0.4 * smoothstep(TUBE_END, FLASH_TIME, t) * (flicker ? mean : 1) +
        2.5 * flash;

      // The ship: in the place of the G after the flash, then it turns around and flies away.
      if (afterFlash && !enginesOn && t >= IGNITE_TIME) {
        enginesOn = true;
        ship.setEnginesOn(true);
      }
      if (t >= FLY_START) {
        ship.setBoost(true);
      }
      const fly = Math.max(0, t - FLY_START);
      const yaw = Math.PI * smoothstep(TURN_START, TURN_END, t);
      placeShipOnG(viewProjection, cameraPosition, 0.5 * FLY_ACCELERATION * fly * fly, yaw);
    },
    draw(pass) {
      logo.draw(pass);
    },
    shipVisible() {
      return time >= FLASH_TIME;
    },
    afterMainPass(encoder, sceneView) {
      bloom.render(encoder, sceneView, size.width, size.height, bloomThreshold, bloomIntensity);
    },
    drawPost(pass) {
      bloom.draw(pass);
    },
  };
}
