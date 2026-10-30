// Copy a texture to the render target of a pass with one full-screen triangle. The texture and the
// target must have the same size. The pass has no depth buffer.

#pragma once

#include <webgpu/webgpu_cpp.h>

namespace hackathon {

class Blit {
  public:
    Blit(const wgpu::Device& device, wgpu::TextureFormat format);

    void Draw(const wgpu::RenderPassEncoder& pass, const wgpu::TextureView& source);

  private:
    wgpu::Device device_;
    wgpu::RenderPipeline pipeline_;
    // The bind group of the last source. It changes only when the source changes.
    wgpu::BindGroup bindGroup_;
    wgpu::TextureView source_;
};

}  // namespace hackathon
