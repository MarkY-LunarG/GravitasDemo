// Rain on the camera lens: long drops (streaks) that the air pushes across the glass, small beads
// of water that the streaks leave behind them, and small still drops. The drops bend the view
// behind them, and the dry parts of the glass are misted. This is a screen effect with its own
// shader: it reads the image of the scene, and draws the image through the water. Draw it in the
// post pass of the App (Scene::DrawPost).
//
// The shader makes a height field of the water on the glass. Its slope moves the point where the
// shader reads the scene image, so a drop shows a bent view, as a small lens does.
//
// The blend uses the blend constant: image = rain image * constant + image * (1 - constant).
// Draw() sets the blend constant from the rain intensity, so the rain fades in and out.

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <array>

namespace hackathon {

class Rain {
  public:
    Rain(const wgpu::Device& device, wgpu::TextureFormat format);

    // Set the time in seconds, the rain intensity (0 to 1), the size of the view in pixels, and the
    // screen direction in which the drops slide (+x is right and +y is up). The length of the
    // direction is not important.
    void Update(double time, double intensity, uint32_t width, uint32_t height,
                const std::array<double, 2>& direction);
    // Draw the rain over the image in the pass. sceneView is the image of the scene.
    void Draw(const wgpu::RenderPassEncoder& pass, const wgpu::TextureView& sceneView);

  private:
    wgpu::Device device_;
    wgpu::Buffer uniformBuffer_;
    wgpu::Sampler sampler_;
    wgpu::RenderPipeline pipeline_;
    wgpu::BindGroup bindGroup_;
    wgpu::TextureView sceneView_;
    double intensity_ = 0.0;
};

}  // namespace hackathon
