#include "util/mat4.h"

#include <cmath>

namespace hackathon {

namespace {

Vec3 Subtract(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }

Vec3 Cross(const Vec3& a, const Vec3& b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}

double Dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

Vec3 Normalize(const Vec3& v) {
    const double length = std::hypot(v[0], v[1], v[2]);
    return {v[0] / length, v[1] / length, v[2] / length};
}

// Round each value to float, as a store into a Float32Array does.
Mat4 ToMat4(const std::array<double, 16>& values) {
    Mat4 out;
    for (size_t i = 0; i < 16; ++i) {
        out[i] = static_cast<float>(values[i]);
    }
    return out;
}

}  // namespace

Mat4 Identity() { return TranslationScale({0.0, 0.0, 0.0}, {1.0, 1.0, 1.0}); }

Mat4 Multiply(const Mat4& a, const Mat4& b) {
    Mat4 out;
    for (int column = 0; column < 4; ++column) {
        for (int row = 0; row < 4; ++row) {
            double sum = 0.0;
            for (int k = 0; k < 4; ++k) {
                sum += static_cast<double>(a[k * 4 + row]) * static_cast<double>(b[column * 4 + k]);
            }
            out[column * 4 + row] = static_cast<float>(sum);
        }
    }
    return out;
}

Mat4 TranslationScale(const Vec3& translation, const Vec3& scale) {
    // clang-format off
    return ToMat4({
        scale[0], 0, 0, 0,
        0, scale[1], 0, 0,
        0, 0, scale[2], 0,
        translation[0], translation[1], translation[2], 1,
    });
    // clang-format on
}

Mat4 Compose(const Vec3& translation, const Quat& rotation, const Vec3& scale) {
    const auto [x, y, z, w] = rotation;
    const auto [sx, sy, sz] = scale;
    // clang-format off
    return ToMat4({
        (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
        2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
        2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        translation[0], translation[1], translation[2], 1,
    });
    // clang-format on
}

Vec3 TransformPoint(const Mat4& m, const Vec3& p) {
    return {
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    };
}

Mat4 Perspective(double fovYRadians, double aspect, double nearPlane, double farPlane) {
    const double f = 1.0 / std::tan(fovYRadians / 2.0);
    const double rangeInverse = 1.0 / (nearPlane - farPlane);
    // clang-format off
    return ToMat4({
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, farPlane * rangeInverse, -1,
        0, 0, farPlane * nearPlane * rangeInverse, 0,
    });
    // clang-format on
}

Vec3 ViewToWorldDirection(const Mat4& view, const Vec3& direction) {
    // The rotation part of a view matrix is orthonormal, so its transpose is its inverse.
    return {
        view[0] * direction[0] + view[1] * direction[1] + view[2] * direction[2],
        view[4] * direction[0] + view[5] * direction[1] + view[6] * direction[2],
        view[8] * direction[0] + view[9] * direction[1] + view[10] * direction[2],
    };
}

Mat4 LookAt(const Vec3& eye, const Vec3& target, const Vec3& up) {
    const Vec3 zAxis = Normalize(Subtract(eye, target));
    const Vec3 xAxis = Normalize(Cross(up, zAxis));
    const Vec3 yAxis = Cross(zAxis, xAxis);
    // clang-format off
    return ToMat4({
        xAxis[0], yAxis[0], zAxis[0], 0,
        xAxis[1], yAxis[1], zAxis[1], 0,
        xAxis[2], yAxis[2], zAxis[2], 0,
        -Dot(xAxis, eye), -Dot(yAxis, eye), -Dot(zAxis, eye), 1,
    });
    // clang-format on
}

std::array<Plane, 6> FrustumPlanes(const Mat4& m) {
    auto row = [&m](int i) -> Plane { return {m[i], m[4 + i], m[8 + i], m[12 + i]}; };
    const Plane r0 = row(0);
    const Plane r1 = row(1);
    const Plane r2 = row(2);
    const Plane r3 = row(3);
    auto add = [](const Plane& a, const Plane& b, double sign) -> Plane {
        return {a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2], a[3] + sign * b[3]};
    };
    std::array<Plane, 6> planes = {
        add(r3, r0, 1), add(r3, r0, -1), add(r3, r1, 1), add(r3, r1, -1), r2, add(r3, r2, -1)};
    for (Plane& plane : planes) {
        const double length = std::hypot(plane[0], plane[1], plane[2]);
        plane = {plane[0] / length, plane[1] / length, plane[2] / length, plane[3] / length};
    }
    return planes;
}

Mat4 Invert(const Mat4& m) {
    const double a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const double a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const double a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const double a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const double b00 = a00 * a11 - a01 * a10;
    const double b01 = a00 * a12 - a02 * a10;
    const double b02 = a00 * a13 - a03 * a10;
    const double b03 = a01 * a12 - a02 * a11;
    const double b04 = a01 * a13 - a03 * a11;
    const double b05 = a02 * a13 - a03 * a12;
    const double b06 = a20 * a31 - a21 * a30;
    const double b07 = a20 * a32 - a22 * a30;
    const double b08 = a20 * a33 - a23 * a30;
    const double b09 = a21 * a32 - a22 * a31;
    const double b10 = a21 * a33 - a23 * a31;
    const double b11 = a22 * a33 - a23 * a32;
    const double determinant =
        b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    const double d = 1.0 / determinant;
    // clang-format off
    return ToMat4({
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
    });
    // clang-format on
}

Quat QuatFromAxisAngle(const Vec3& axis, double angle) {
    const double s = std::sin(angle / 2.0);
    return {axis[0] * s, axis[1] * s, axis[2] * s, std::cos(angle / 2.0)};
}

Quat QuatMultiply(const Quat& a, const Quat& b) {
    const auto [ax, ay, az, aw] = a;
    const auto [bx, by, bz, bw] = b;
    return {
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    };
}

}  // namespace hackathon
