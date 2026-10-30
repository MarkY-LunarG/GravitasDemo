// A lens flare from the sun: a glow with rays and a horizontal streak at the sun, and a line of
// colored ghosts (images of the lens aperture) from the sun through the center of the screen. Each
// ghost is a hexagon, a circle, or an oval, which a seeded random value selects. An oval is
// squashed along the line from the sun through the center of the screen.
//
// Occlusion queries measure how much of the sun is visible:
//
// 1. In the main pass, after the opaque objects and the ship, DrawProbes() draws a disk over the
//    sun two times, with no color writes. Query 0 counts the samples of the disk that pass the
//    depth test, so towers, land, and the ship in front of the sun remove samples. Query 1 counts
//    all of the samples of the disk on the screen, with no depth test.
// 2. Between the main pass and the post pass, Resolve() writes the two counts into a storage
//    buffer.
// 3. In the post pass, the vertex shader of the flare reads the two counts. The visible part of
//    the sun is the first count divided by the second, and the flare has that brightness.
//
// The counts stay on the GPU, so the flare changes in the same frame, with no read back to the
// CPU.

#pragma once

#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

namespace hackathon {

class LensFlare {
  public:
    // format and depthFormat are the formats of the main pass. The post pass has the same color
    // format.
    LensFlare(const wgpu::Device& device, wgpu::TextureFormat format,
              wgpu::TextureFormat depthFormat);

    // Give this query set to the main pass (Scene::OcclusionQuerySet()).
    const wgpu::QuerySet& QuerySet() const { return querySet_; }

    // Set the camera, the unit direction to the sun, the sun color, and the aspect ratio of the
    // view (width / height).
    void Update(const Mat4& viewProjection, const Vec3& sunDirection, const Vec3& sunColor,
                double aspect);
    // Count the visible samples of the sun. Call this in the main pass, after all of the opaque
    // objects. The pass must use QuerySet() as its occlusion query set.
    void DrawProbes(const wgpu::RenderPassEncoder& pass) const;
    // Write the counts for the flare. Call this after the main pass and before the post pass.
    void Resolve(const wgpu::CommandEncoder& encoder) const;
    // Draw the flare over the image, in the post pass.
    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    wgpu::Device device_;
    wgpu::QuerySet querySet_;
    wgpu::Buffer uniformBuffer_;
    wgpu::Buffer occlusionBuffer_;
    wgpu::BindGroup probeBindGroup_;
    wgpu::BindGroup flareBindGroup_;
    wgpu::RenderPipeline visiblePipeline_;
    wgpu::RenderPipeline totalPipeline_;
    wgpu::RenderPipeline flarePipeline_;
};

}  // namespace hackathon
