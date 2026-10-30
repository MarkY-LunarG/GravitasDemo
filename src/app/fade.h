// A fade to black for the transitions between scenes. It draws one triangle that covers the
// whole view, and blends black over the image. An amount of 0 changes nothing, and an amount of
// 1 makes the image fully black.

#pragma once

#include <webgpu/webgpu_cpp.h>

namespace hackathon {

class Fade {
  public:
    Fade(const wgpu::Device& device, wgpu::TextureFormat format, wgpu::TextureFormat depthFormat);

    // Draw the fade last in the pass. An amount of 0 or less draws nothing.
    void Draw(const wgpu::RenderPassEncoder& pass, double amount);

  private:
    wgpu::Device device_;
    wgpu::Buffer uniformBuffer_;
    wgpu::BindGroup bindGroup_;
    wgpu::RenderPipeline pipeline_;
};

}  // namespace hackathon
