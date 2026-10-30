// The background of a scene: stars, and as options, a nebula, a planet with a ring and moons, an
// atmosphere, and a sun disk. One full-screen shader calculates the background color for each view
// direction, so the background is infinitely far away and the camera position does not change it.
//
// Draw the sky after the opaque objects of a scene and before blended objects. The sky is at the
// far plane and does not write depth, so the depth test skips the pixels that objects cover.
// The planet and the moons use the shared sun.

#pragma once

#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <optional>

namespace hackathon {

class DirectionalLight;

struct PlanetOptions {
    // The direction of the planet center, from the horizontal heading: degrees to the right of the
    // heading, and degrees above the horizon.
    double rightDegrees;
    double elevationDegrees;
    // The angular radius of the planet, in degrees.
    double radiusDegrees;
};

struct SkyOptions {
    // A dark blue background with a purple and green nebula. Without it, the background is black.
    bool nebula = false;
    std::optional<PlanetOptions> planet = std::nullopt;
    // A yellow-brown planet below the horizon, with an atmosphere. SetAtmosphere() sets how deep
    // the camera is in the atmosphere. Without it, the sky ignores SetAtmosphere().
    bool atmosphere = false;
    // A sun disk with a glow, in the direction of the shared light.
    bool sunDisk = false;
};

class Sky {
  public:
    // heading is the horizontal direction that the planet direction is relative to.
    Sky(const wgpu::Device& device, wgpu::TextureFormat format, wgpu::TextureFormat depthFormat,
        const DirectionalLight& light, const Vec3& heading, const SkyOptions& options);

    // The sky needs only the camera rotation. Without the camera translation, the view direction
    // keeps its precision far from the origin.
    void SetCamera(const Mat4& viewProjection, const Vec3& cameraPosition);

    // Set how deep the camera is in the atmosphere (0 is space, 1 is deep), the brightness of a
    // lightning flash and its position in clip space, the angle in radians of the horizon below the
    // horizontal, the tilt of the horizon in radians (higher along the heading), and the width of
    // the view divided by its height.
    void SetAtmosphere(double depth, double flash, const std::array<double, 2>& flashPosition,
                       double horizonDip, double horizonTilt, double aspect);

    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    wgpu::Device device_;
    const DirectionalLight& light_;
    wgpu::Buffer uniformBuffer_;
    wgpu::BindGroup bindGroup_;
    wgpu::RenderPipeline pipeline_;
};

}  // namespace hackathon
