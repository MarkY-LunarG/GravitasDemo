// Minimal 4x4 matrix helpers. Matrices are column-major Float32Arrays, as WGSL expects.
// The coordinate system is right-handed with +Y up, and clip-space depth is [0, 1] as in WebGPU.

export type Vec3 = readonly [number, number, number];
// A unit quaternion [x, y, z, w], as glTF stores rotations.
export type Quat = readonly [number, number, number, number];
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

// The matrix that scales, then rotates, then translates, as for a glTF node.
export function compose(translation: Vec3, rotation: Quat, scale: Vec3): Mat4 {
  const [x, y, z, w] = rotation;
  const [sx, sy, sz] = scale;
  // prettier-ignore
  return new Float32Array([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
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

// The six planes of the view volume of a view-projection matrix, as [a, b, c, d] with a unit
// normal (a, b, c) that points into the volume. A point p is inside a plane when
// a * p.x + b * p.y + c * p.z + d >= 0. The clip-space depth is [0, 1], as in WebGPU.
// The order is left, right, bottom, top, near, far.
export function frustumPlanes(m: Mat4): [number, number, number, number][] {
  const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const add = (a: number[], b: number[], sign: number) => a.map((value, i) => value + sign * b[i]);
  const planes = [add(r3, r0, 1), add(r3, r0, -1), add(r3, r1, 1), add(r3, r1, -1), r2, add(r3, r2, -1)];
  return planes.map((plane) => {
    const length = Math.hypot(plane[0], plane[1], plane[2]);
    return [plane[0] / length, plane[1] / length, plane[2] / length, plane[3] / length];
  });
}

// The inverse of a 4x4 matrix, from the cofactors and the determinant.
export function invert(m: Mat4): Mat4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const d = 1 / determinant;
  // prettier-ignore
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]);
}

// The rotation of angle radians around a unit axis, as a quaternion.
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

// The rotation b, then the rotation a.
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
