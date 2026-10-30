#include "app/fade.h"

#include "shaders.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <algorithm>
#include <array>

namespace hackathon {

Fade::Fade(const wgpu::Device& device, wgpu::TextureFormat format, wgpu::TextureFormat depthFormat)
    : device_(device) {
    // A vec4f, because a uniform buffer binding must be at least 16 bytes.
    uniformBuffer_ = CreateBuffer(device, 4 * sizeof(float),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    const wgpu::BindGroupLayoutEntry layoutEntry = UniformEntry(0, wgpu::ShaderStage::Fragment);
    const wgpu::BindGroupLayoutDescriptor layoutDescriptor = {.entryCount = 1,
                                                              .entries = &layoutEntry};
    const wgpu::BindGroupLayout layout = device.CreateBindGroupLayout(&layoutDescriptor);
    const wgpu::BindGroupEntry entry = {.binding = 0, .buffer = uniformBuffer_};
    const wgpu::BindGroupDescriptor bindGroupDescriptor = {
        .layout = layout, .entryCount = 1, .entries = &entry};
    bindGroup_ = device.CreateBindGroup(&bindGroupDescriptor);

    const wgpu::PipelineLayoutDescriptor pipelineLayoutDescriptor = {.bindGroupLayoutCount = 1,
                                                                     .bindGroupLayouts = &layout};
    const wgpu::ShaderModule module = CreateShaderModule(device, shaders::kFade, "fade");
    const wgpu::ColorTargetState target = {.format = format, .blend = &kAlphaBlend};
    const wgpu::FragmentState fragment = {
        .module = module, .entryPoint = "fs_fade", .targetCount = 1, .targets = &target};
    // The pass has a depth buffer, so the pipeline must have a depth state. The fade covers all
    // surfaces, so it ignores the depth.
    const wgpu::DepthStencilState depthStencil = {.format = depthFormat,
                                                  .depthWriteEnabled = wgpu::OptionalBool::False,
                                                  .depthCompare = wgpu::CompareFunction::Always};
    const wgpu::RenderPipelineDescriptor descriptor = {
        .layout = device.CreatePipelineLayout(&pipelineLayoutDescriptor),
        .vertex = {.module = module, .entryPoint = "vs_fade"},
        .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
        .depthStencil = &depthStencil,
        .fragment = &fragment,
    };
    pipeline_ = device.CreateRenderPipeline(&descriptor);
}

void Fade::Draw(const wgpu::RenderPassEncoder& pass, double amount) {
    if (amount <= 0.0) {
        return;
    }
    const std::array<float, 4> values = {static_cast<float>(std::min(amount, 1.0)), 0.0f, 0.0f,
                                         0.0f};
    WriteBuffer(device_, uniformBuffer_, 0, values.data(), values.size());
    pass.SetPipeline(pipeline_);
    pass.SetBindGroup(0, bindGroup_);
    pass.Draw(3);
}

}  // namespace hackathon
