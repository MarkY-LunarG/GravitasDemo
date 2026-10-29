// Minimal 4x4 matrix helpers. Matrices are column-major Float32Arrays, as WGSL expects.
// The coordinate system is right-handed with +Y up, and clip-space depth is [0, 1] as in WebGPU.

export type Vec3 = readonly [number, number, number];
export type Mat4 = Float32Array;

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; ++column) {
    for (let row = 0; row < 4; ++row) {
      let sum = 0;
      for (let k = 0; k < 4; ++k) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function translationScale(translation: Vec3, scale: Vec3): Mat4 {
  // prettier-ignore
  return new Float32Array([
    scale[0], 0, 0, 0,
    0, scale[1], 0, 0,
    0, 0, scale[2], 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

export function perspective(fovYRadians: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  const rangeInverse = 1 / (near - far);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * rangeInverse, -1,
    0, 0, far * near * rangeInverse, 0,
  ]);
}

// Rotate a direction from view space (the space of a lookAt() matrix) into world space.
// In view space the camera looks along -Z, +X is to the right, and +Y is up.
export function viewToWorldDirection(view: Mat4, direction: Vec3): Vec3 {
  // The rotation part of a view matrix is orthonormal, so its transpose is its inverse.
  return [
    view[0] * direction[0] + view[1] * direction[1] + view[2] * direction[2],
    view[4] * direction[0] + view[5] * direction[1] + view[6] * direction[2],
    view[8] * direction[0] + view[9] * direction[1] + view[10] * direction[2],
  ];
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const zAxis = normalize(subtract(eye, target));
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);
  // prettier-ignore
  return new Float32Array([
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dot(xAxis, eye), -dot(yAxis, eye), -dot(zAxis, eye), 1,
  ]);
}
