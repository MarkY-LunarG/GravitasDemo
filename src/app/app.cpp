#include "app/app.h"

#include <cmath>
#include <cstdio>

namespace hackathon {

// The pipelines of the later milestones use the format.
App::App(const wgpu::Device& device, wgpu::TextureFormat /*format*/) : device_(device) {}

void App::Frame(double seconds, const wgpu::TextureView& colorView, uint32_t /*width*/,
                uint32_t /*height*/) {
    elapsed_ += seconds;
    // A slow cycle through dark colors.
    const wgpu::Color color = {
        .r = 0.15 + 0.15 * std::sin(elapsed_ * 0.9),
        .g = 0.15 + 0.15 * std::sin(elapsed_ * 1.3 + 2.0),
        .b = 0.25 + 0.15 * std::sin(elapsed_ * 1.7 + 4.0),
        .a = 1.0,
    };

    const wgpu::RenderPassColorAttachment attachment = {
        .view = colorView,
        .loadOp = wgpu::LoadOp::Clear,
        .storeOp = wgpu::StoreOp::Store,
        .clearValue = color,
    };
    const wgpu::RenderPassDescriptor passDescriptor = {
        .colorAttachmentCount = 1,
        .colorAttachments = &attachment,
    };
    const wgpu::CommandEncoder encoder = device_.CreateCommandEncoder();
    const wgpu::RenderPassEncoder pass = encoder.BeginRenderPass(&passDescriptor);
    pass.End();
    const wgpu::CommandBuffer commands = encoder.Finish();
    device_.GetQueue().Submit(1, &commands);
}

// Milestone 1 writes the pointer events, to check the conversion to surface pixels on each target.
void App::PointerMove(float /*x*/, float /*y*/) {}

void App::Click(float x, float y) {
    std::printf("Click at (%.1f, %.1f) pixels\n", x, y);
}

}  // namespace hackathon
