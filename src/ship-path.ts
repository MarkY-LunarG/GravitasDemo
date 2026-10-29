// A smooth path for the ship: a sum of sine waves on the right, up, and forward axes. The axes are
// the right, up, and heading directions of the ship start position, and the values are meters
// from that position.
//
// The path starts at the start position and eases in over rampTime seconds. The scene uses the
// path to place the ship, and the asteroid shader uses the same path (as WGSL) to keep the
// asteroids out of the way of the ship.

import type { Vec3 } from './mat4.js';

export interface PathTerm {
  // 0 is right, 1 is up, and 2 is forward.
  readonly axis: 0 | 1 | 2;
  readonly amplitude: number;
  // The period in seconds, and the phase in radians.
  readonly period: number;
  readonly phase: number;
}

export class ShipPath {
  private readonly terms: readonly PathTerm[];
  private readonly rampTime: number;

  constructor(terms: readonly PathTerm[], rampTime: number) {
    this.terms = terms;
    this.rampTime = rampTime;
  }

  // The offset from the start position at a time in seconds from the start of the path.
  offset(time: number): Vec3 {
    const sum = [0, 0, 0];
    for (const term of this.terms) {
      const wave = Math.sin((2 * Math.PI * time) / term.period + term.phase) - Math.sin(term.phase);
      sum[term.axis] += term.amplitude * wave;
    }
    const ramp = this.ramp(time);
    return [sum[0] * ramp, sum[1] * ramp, sum[2] * ramp];
  }

  // The same function as offset(), as the WGSL function shipPathOffset(time) -> vec3f.
  wgsl(): string {
    const terms = this.terms
      .map(
        (term) =>
          `  sum[${term.axis}] += ${term.amplitude} * (sin(${(2 * Math.PI) / term.period} * time + ${term.phase})` +
          ` - ${Math.sin(term.phase)});`,
      )
      .join('\n');
    return /* wgsl */ `
fn shipPathOffset(time: f32) -> vec3f {
  var sum = vec3f(0.0);
${terms}
  let ramp = smoothstep(0.0, ${this.rampTime}, max(time, 0.0));
  return sum * ramp;
}
`;
  }

  // A smooth start: 0 at time 0, and 1 after rampTime. Each term also subtracts its value at time
  // 0, so that the path is at the start position at time 0.
  private ramp(time: number): number {
    const x = Math.min(Math.max(time / this.rampTime, 0), 1);
    return x * x * (3 - 2 * x);
  }
}
