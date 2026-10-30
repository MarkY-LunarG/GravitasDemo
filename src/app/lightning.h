// Lightning flashes around the edges of the screen. A random schedule (with a fixed seed, so each
// benchmark run is the same) starts a flash every few seconds. A flash has one to three quick
// pulses, and it is at a random position near the edge of the screen.
//
// The flash draws one full-screen triangle with a soft glow around the flash position. The blend
// uses the blend constant: Draw() sets the blend constant from the brightness of the flash. The
// scene also gives the brightness to the clouds and the sky, so that the flash lights them.

#pragma once

#include "util/random.h"

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <limits>
#include <vector>

namespace hackathon {

class Lightning {
  public:
    Lightning(const wgpu::Device& device, wgpu::TextureFormat format,
              wgpu::TextureFormat depthFormat);

    // The brightness of the current flash, from 0 to approximately 1.
    double Brightness() const { return flash_; }
    // The position of the current flash in clip space, near the edge of the screen.
    const std::array<double, 2>& Position() const { return flashPosition_; }

    // Advance to a time in seconds. Flashes happen only when enabled is true. aspect is the width
    // of the view divided by its height.
    void Update(double time, bool enabled, double aspect);
    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    wgpu::Device device_;
    wgpu::Buffer uniformBuffer_;
    wgpu::BindGroup bindGroup_;
    wgpu::RenderPipeline pipeline_;
    Random random_;
    double nextFlash_ = 0.0;
    double flashStart_ = -std::numeric_limits<double>::infinity();
    std::vector<double> pulses_;
    std::array<double, 2> flashPosition_ = {0.0, 0.0};
    double flash_ = 0.0;
};

}  // namespace hackathon
