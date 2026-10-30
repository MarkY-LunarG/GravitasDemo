// Minimal 4x4 matrix and quaternion functions. Matrices are column-major, as WGSL expects. The
// coordinate system is right-handed with +Y up, and the clip-space depth is [0, 1], as in WebGPU.
//
// The TypeScript version keeps vectors as JavaScript numbers and matrices as Float32Array. These
// types do the same: Vec3 and Quat are double, and Mat4 is float. The functions calculate in double
// and round to float only where the TypeScript version stores into a Float32Array, so both versions
// give the same values.

#pragma once

#include <array>

namespace hackathon {

using Vec3 = std::array<double, 3>;
// A unit quaternion [x, y, z, w], as glTF stores rotations.
using Quat = std::array<double, 4>;
using Mat4 = std::array<float, 16>;
// A plane [a, b, c, d]. See FrustumPlanes().
using Plane = std::array<double, 4>;

Mat4 Identity();
Mat4 Multiply(const Mat4& a, const Mat4& b);
Mat4 TranslationScale(const Vec3& translation, const Vec3& scale);
// The matrix that scales, then rotates, then translates, as for a glTF node.
Mat4 Compose(const Vec3& translation, const Quat& rotation, const Vec3& scale);
Vec3 TransformPoint(const Mat4& m, const Vec3& p);
Mat4 Perspective(double fovYRadians, double aspect, double nearPlane, double farPlane);
// Rotate a direction from view space (the space of a LookAt() matrix) into world space. In view
// space, the camera looks along -Z, +X is to the right, and +Y is up.
Vec3 ViewToWorldDirection(const Mat4& view, const Vec3& direction);
Mat4 LookAt(const Vec3& eye, const Vec3& target, const Vec3& up);
// The six planes of the view volume of a view-projection matrix, with a unit normal (a, b, c) that
// points into the volume. A point p is inside a plane when a * p.x + b * p.y + c * p.z + d >= 0.
// The order is left, right, bottom, top, near, far.
std::array<Plane, 6> FrustumPlanes(const Mat4& m);
// The inverse, from the cofactors and the determinant.
Mat4 Invert(const Mat4& m);

// The rotation of angle radians around a unit axis.
Quat QuatFromAxisAngle(const Vec3& axis, double angle);
// The rotation b, then the rotation a.
Quat QuatMultiply(const Quat& a, const Quat& b);

}  // namespace hackathon
