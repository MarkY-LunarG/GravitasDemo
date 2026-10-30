// The benchmark scenes, in the order that they play. To add a scene, write a file with a create
// function that returns a Scene, and add the function to this list.

import { createAsteroidScene } from './asteroid-scene.js';
import { createEntryScene } from './entry-scene.js';
import type { Scene, SharedObjects } from './scene.js';
import { createTerrainScene } from './terrain-scene.js';

export const SCENES: readonly ((shared: SharedObjects) => Scene)[] = [
  createTerrainScene,
  createAsteroidScene,
  createEntryScene,
];
