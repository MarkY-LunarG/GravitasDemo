// A bloom filter: bright parts of the scene image spread light around them.
//
// Render() runs between the main pass and the post pass (Scene::AfterMainPass):
//
// 1. The prefilter pass keeps the part of each pixel that is brighter than the threshold, at half
//    the size of the view.
// 2. kLevels - 1 passes make a chain of smaller images, each half the size of the previous one.
//    Each pass averages 16 pixels with 4 bilinear samples, so the chain is a wide blur.
// 3. Upsample passes add each small image (with a 3 x 3 tent filter) to the next larger image, from
//    the smallest to the half-size image. The sum has a sharp glow near bright parts and a wide,
//    weak glow farther away.
//
// Draw() adds the half-size image to the output in the post pass (Scene::DrawPost).

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <vector>

namespace hackathon {

class Bloom {
  public:
    // format is the format of the scene image and of the output.
    Bloom(const wgpu::Device& device, wgpu::TextureFormat format);

    // Make the bloom image from sceneView. width and height are the size of the scene image. Only
    // the part above threshold (0 to 1) blooms. intensity is the brightness of the bloom in Draw().
    void Render(const wgpu::CommandEncoder& encoder, const wgpu::TextureView& sceneView,
                uint32_t width, uint32_t height, double threshold, double intensity);
    // Add the bloom to the image of the pass (the post pass).
    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    // The chain, for the current size and scene image.
    struct Chain {
        uint32_t width = 0;
        uint32_t height = 0;
        wgpu::TextureView sceneView;
        std::vector<wgpu::Texture> textures;
        std::vector<wgpu::TextureView> views;
        // The bind group that reads the scene image, and one for each image of the chain.
        wgpu::BindGroup sceneBindGroup;
        std::vector<wgpu::BindGroup> bindGroups;
    };

    const Chain& ChainFor(const wgpu::TextureView& sceneView, uint32_t width, uint32_t height);

    wgpu::Device device_;
    wgpu::Buffer uniformBuffer_;
    wgpu::Sampler sampler_;
    wgpu::RenderPipeline prefilterPipeline_;
    wgpu::RenderPipeline downPipeline_;
    wgpu::RenderPipeline upPipeline_;
    wgpu::RenderPipeline compositePipeline_;
    bool hasChain_ = false;
    Chain chain_;
    double intensity_ = 0.0;
};

}  // namespace hackathon
