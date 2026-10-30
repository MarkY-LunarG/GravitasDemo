#include "app/bloom.h"

#include "shaders.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <algorithm>
#include <array>

namespace hackathon {

namespace {

// The number of images in the chain. The smallest is 1/64 of the size of the view.
constexpr uint32_t kLevels = 6;
// The format of the chain: 16-bit floats, so that the sums can be larger than 1.
constexpr wgpu::TextureFormat kChainFormat = wgpu::TextureFormat::RGBA16Float;

}  // namespace

Bloom::Bloom(const wgpu::Device& device, wgpu::TextureFormat format) : device_(device) {
    uniformBuffer_ = CreateBuffer(device, 4 * sizeof(float),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    const wgpu::SamplerDescriptor samplerDescriptor = {
        .addressModeU = wgpu::AddressMode::ClampToEdge,
        .addressModeV = wgpu::AddressMode::ClampToEdge,
        .magFilter = wgpu::FilterMode::Linear,
        .minFilter = wgpu::FilterMode::Linear,
    };
    sampler_ = device.CreateSampler(&samplerDescriptor);
    const wgpu::ShaderModule module = CreateShaderModule(device, shaders::kBloom, "bloom");
    const wgpu::BindGroupLayoutEntry layoutEntries[] = {
        UniformEntry(0, wgpu::ShaderStage::Fragment),
        {.binding = 1,
         .visibility = wgpu::ShaderStage::Fragment,
         .texture = {.sampleType = wgpu::TextureSampleType::Float,
                     .viewDimension = wgpu::TextureViewDimension::e2D}},
        {.binding = 2,
         .visibility = wgpu::ShaderStage::Fragment,
         .sampler = {.type = wgpu::SamplerBindingType::Filtering}},
    };
    const wgpu::BindGroupLayoutDescriptor layoutDescriptor = {.entryCount = 3,
                                                              .entries = layoutEntries};
    const wgpu::BindGroupLayout layout = device.CreateBindGroupLayout(&layoutDescriptor);
    const wgpu::PipelineLayoutDescriptor pipelineLayoutDescriptor = {.bindGroupLayoutCount = 1,
                                                                     .bindGroupLayouts = &layout};
    const wgpu::PipelineLayout pipelineLayout =
        device.CreatePipelineLayout(&pipelineLayoutDescriptor);
    auto pipeline = [&](const char* entryPoint, wgpu::TextureFormat targetFormat,
                        const wgpu::BlendState* blend) {
        const wgpu::ColorTargetState target = {.format = targetFormat, .blend = blend};
        const wgpu::FragmentState fragment = {
            .module = module, .entryPoint = entryPoint, .targetCount = 1, .targets = &target};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = pipelineLayout,
            .vertex = {.module = module, .entryPoint = "vs_full"},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
            .fragment = &fragment,
        };
        return device.CreateRenderPipeline(&descriptor);
    };
    prefilterPipeline_ = pipeline("fs_prefilter", kChainFormat, nullptr);
    downPipeline_ = pipeline("fs_down", kChainFormat, nullptr);
    upPipeline_ = pipeline("fs_up", kChainFormat, &kAdditiveBlend);
    compositePipeline_ = pipeline("fs_composite", format, &kAdditiveBlend);
}

void Bloom::Render(const wgpu::CommandEncoder& encoder, const wgpu::TextureView& sceneView,
                   uint32_t width, uint32_t height, double threshold, double intensity) {
    intensity_ = intensity;
    if (intensity <= 0.0) {
        return;
    }
    const std::array<float, 4> values = {static_cast<float>(threshold), 0.1f,
                                         static_cast<float>(intensity), 0.0f};
    WriteBuffer(device_, uniformBuffer_, 0, values.data(), values.size());
    const Chain& chain = ChainFor(sceneView, width, height);
    auto pass = [&encoder](const wgpu::TextureView& view, const wgpu::RenderPipeline& pipeline,
                           const wgpu::BindGroup& bindGroup, bool load) {
        const wgpu::RenderPassColorAttachment attachment = {
            .view = view,
            .loadOp = load ? wgpu::LoadOp::Load : wgpu::LoadOp::Clear,
            .storeOp = wgpu::StoreOp::Store,
            .clearValue = {0.0, 0.0, 0.0, 0.0},
        };
        const wgpu::RenderPassDescriptor descriptor = {.colorAttachmentCount = 1,
                                                       .colorAttachments = &attachment};
        const wgpu::RenderPassEncoder renderPass = encoder.BeginRenderPass(&descriptor);
        renderPass.SetPipeline(pipeline);
        renderPass.SetBindGroup(0, bindGroup);
        renderPass.Draw(3);
        renderPass.End();
    };
    pass(chain.views[0], prefilterPipeline_, chain.sceneBindGroup, false);
    for (uint32_t level = 1; level < kLevels; ++level) {
        pass(chain.views[level], downPipeline_, chain.bindGroups[level - 1], false);
    }
    for (uint32_t level = kLevels - 1; level > 0; --level) {
        pass(chain.views[level - 1], upPipeline_, chain.bindGroups[level], true);
    }
}

void Bloom::Draw(const wgpu::RenderPassEncoder& pass) const {
    if (intensity_ <= 0.0 || !hasChain_) {
        return;
    }
    pass.SetPipeline(compositePipeline_);
    pass.SetBindGroup(0, chain_.bindGroups[0]);
    pass.Draw(3);
}

// The chain for the size and the scene image. A new size or scene image makes a new chain.
const Bloom::Chain& Bloom::ChainFor(const wgpu::TextureView& sceneView, uint32_t width,
                                    uint32_t height) {
    if (hasChain_ && chain_.width == width && chain_.height == height &&
        chain_.sceneView.Get() == sceneView.Get()) {
        return chain_;
    }
    for (const wgpu::Texture& texture : chain_.textures) {
        texture.Destroy();
    }
    chain_ = Chain();
    chain_.width = width;
    chain_.height = height;
    chain_.sceneView = sceneView;
    for (uint32_t level = 0; level < kLevels; ++level) {
        const wgpu::TextureDescriptor descriptor = {
            .usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding,
            .size = {std::max(1u, width >> (level + 1)), std::max(1u, height >> (level + 1)), 1},
            .format = kChainFormat,
        };
        chain_.textures.push_back(device_.CreateTexture(&descriptor));
        chain_.views.push_back(chain_.textures.back().CreateView());
    }
    auto bindGroup = [this](const wgpu::TextureView& view) {
        const wgpu::BindGroupEntry entries[] = {
            {.binding = 0, .buffer = uniformBuffer_},
            {.binding = 1, .textureView = view},
            {.binding = 2, .sampler = sampler_},
        };
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = prefilterPipeline_.GetBindGroupLayout(0),
            .entryCount = 3,
            .entries = entries};
        return device_.CreateBindGroup(&descriptor);
    };
    chain_.sceneBindGroup = bindGroup(sceneView);
    for (const wgpu::TextureView& view : chain_.views) {
        chain_.bindGroups.push_back(bindGroup(view));
    }
    hasChain_ = true;
    return chain_;
}

}  // namespace hackathon
