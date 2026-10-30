#include "app/blit.h"

#include "shaders.h"
#include "util/shader_builder.h"

namespace hackathon {

Blit::Blit(const wgpu::Device& device, wgpu::TextureFormat format) : device_(device) {
    const wgpu::ShaderModule module = CreateShaderModule(device, shaders::kBlit, "blit");
    const wgpu::ColorTargetState target = {.format = format};
    const wgpu::FragmentState fragment = {
        .module = module, .entryPoint = "fs_blit", .targetCount = 1, .targets = &target};
    const wgpu::RenderPipelineDescriptor descriptor = {
        .vertex = {.module = module, .entryPoint = "vs_blit"},
        .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
        .fragment = &fragment,
    };
    pipeline_ = device.CreateRenderPipeline(&descriptor);
}

void Blit::Draw(const wgpu::RenderPassEncoder& pass, const wgpu::TextureView& source) {
    if (source.Get() != source_.Get()) {
        source_ = source;
        const wgpu::BindGroupEntry entry = {.binding = 0, .textureView = source};
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = pipeline_.GetBindGroupLayout(0), .entryCount = 1, .entries = &entry};
        bindGroup_ = device_.CreateBindGroup(&descriptor);
    }
    pass.SetPipeline(pipeline_);
    pass.SetBindGroup(0, bindGroup_);
    pass.Draw(3);
}

}  // namespace hackathon
