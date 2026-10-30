#include "app/lightning.h"

#include "shaders.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace hackathon {

namespace {

// The time in seconds between flashes is random in this range.
constexpr std::array<double, 2> kFlashInterval = {1.5, 5.0};
// Each pulse goes up at once and fades in kPulseDecay seconds. The pulses of a flash are up to
// kPulseSpacing seconds apart.
constexpr double kPulseDecay = 0.07;
constexpr double kPulseSpacing = 0.12;
constexpr uint32_t kRandomSeed = 4242;

// image = glow color * blend constant + image.
constexpr wgpu::BlendState kConstantAdditiveBlend = {
    .color = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::Constant,
              .dstFactor = wgpu::BlendFactor::One},
    .alpha = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::Zero,
              .dstFactor = wgpu::BlendFactor::One},
};

}  // namespace

Lightning::Lightning(const wgpu::Device& device, wgpu::TextureFormat format,
                     wgpu::TextureFormat depthFormat)
    : device_(device), random_(kRandomSeed) {
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

    const wgpu::ShaderModule module = CreateShaderModule(device, shaders::kLightning, "lightning");
    const wgpu::PipelineLayoutDescriptor pipelineLayout = {.bindGroupLayoutCount = 1,
                                                           .bindGroupLayouts = &layout};
    const wgpu::ColorTargetState target = {.format = format, .blend = &kConstantAdditiveBlend};
    const wgpu::FragmentState fragment = {
        .module = module, .entryPoint = "fs_flash", .targetCount = 1, .targets = &target};
    const wgpu::DepthStencilState depthStencil = {.format = depthFormat,
                                                  .depthWriteEnabled = wgpu::OptionalBool::False,
                                                  .depthCompare = wgpu::CompareFunction::Always};
    const wgpu::RenderPipelineDescriptor descriptor = {
        .layout = device.CreatePipelineLayout(&pipelineLayout),
        .vertex = {.module = module, .entryPoint = "vs_flash"},
        .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
        .depthStencil = &depthStencil,
        .fragment = &fragment,
    };
    pipeline_ = device.CreateRenderPipeline(&descriptor);
}

void Lightning::Update(double time, bool enabled, double aspect) {
    if (enabled && time >= nextFlash_) {
        flashStart_ = time;
        const int count = 1 + static_cast<int>(std::floor(random_.Next() * 3));
        pulses_.clear();
        for (int i = 0; i < count; ++i) {
            pulses_.push_back(i * kPulseSpacing * (0.6 + 0.4 * random_.Next()));
        }
        // A random point near the edge of the screen.
        const double angle = random_.Next() * 2 * std::numbers::pi;
        flashPosition_ = {std::cos(angle) * 1.05, std::sin(angle) * 0.95};
        nextFlash_ =
            time + kFlashInterval[0] + (kFlashInterval[1] - kFlashInterval[0]) * random_.Next();
    } else if (!enabled) {
        nextFlash_ = std::max(nextFlash_, time);
    }
    const double sinceStart = time - flashStart_;
    flash_ = 0.0;
    for (const double pulse : pulses_) {
        const double t = sinceStart - pulse;
        if (t >= 0.0) {
            flash_ = std::max(flash_, std::exp(-t / kPulseDecay));
        }
    }
    const float values[4] = {static_cast<float>(flashPosition_[0]),
                             static_cast<float>(flashPosition_[1]), static_cast<float>(aspect),
                             0.0f};
    WriteBuffer(device_, uniformBuffer_, 0, values, 4);
}

void Lightning::Draw(const wgpu::RenderPassEncoder& pass) const {
    if (flash_ < 0.01) {
        return;
    }
    pass.SetPipeline(pipeline_);
    pass.SetBindGroup(0, bindGroup_);
    const wgpu::Color constant = {flash_, flash_, flash_, flash_};
    pass.SetBlendConstant(&constant);
    pass.Draw(3);
}

}  // namespace hackathon
