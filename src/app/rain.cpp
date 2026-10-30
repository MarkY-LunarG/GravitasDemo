#include "app/rain.h"

#include "shaders.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <algorithm>
#include <cmath>

namespace hackathon {

namespace {

// The sizes are in units of the screen height. A streak layer has kSlideColumns columns across
// one screen height. A column has a streak with the probability kSlideProbability of the layer.
constexpr std::array<double, 2> kSlideColumns = {14.0, 24.0};
constexpr std::array<double, 2> kSlideProbability = {0.8, 0.55};
// The still drops divide the glass into cells of 1 / kStillDropGrid screen heights, and a cell
// has a drop with the probability kStillDropProbability.
constexpr double kStillDropGrid = 28.0;
constexpr double kStillDropProbability = 0.2;
// How far a water slope of 1 (height 1 over one screen height) moves the point where the shader
// reads the image, in screen heights. The mist blurs the dry glass by up to kMistBlur pixels.
constexpr double kRefraction = 0.004;
constexpr double kMistBlur = 3.0;
// The mist also makes the dry glass a little lighter, so the clear water stands out.
constexpr double kMistLight = 0.06;

// image = rain image * blend constant + image * (1 - blend constant).
constexpr wgpu::BlendState kConstantMixBlend = {
    .color = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::Constant,
              .dstFactor = wgpu::BlendFactor::OneMinusConstant},
    .alpha = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::Zero,
              .dstFactor = wgpu::BlendFactor::One},
};

}  // namespace

Rain::Rain(const wgpu::Device& device, wgpu::TextureFormat format) : device_(device) {
    uniformBuffer_ = CreateBuffer(device, 8 * sizeof(float),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    const wgpu::SamplerDescriptor samplerDescriptor = {
        .addressModeU = wgpu::AddressMode::ClampToEdge,
        .addressModeV = wgpu::AddressMode::ClampToEdge,
        .magFilter = wgpu::FilterMode::Linear,
        .minFilter = wgpu::FilterMode::Linear,
    };
    sampler_ = device.CreateSampler(&samplerDescriptor);

    WgslConstants constants;
    constants.F32("SLIDE_COLUMNS_0", kSlideColumns[0])
        .F32("SLIDE_PROBABILITY_0", kSlideProbability[0])
        .F32("SLIDE_COLUMNS_1", kSlideColumns[1])
        .F32("SLIDE_PROBABILITY_1", kSlideProbability[1])
        .F32("STILL_DROP_GRID", kStillDropGrid)
        .F32("STILL_DROP_PROBABILITY", kStillDropProbability)
        .F32("REFRACTION", kRefraction)
        .F32("MIST_BLUR", kMistBlur)
        .F32("MIST_LIGHT", kMistLight);
    const std::string code = JoinWgsl({shaders::kNoise, constants.Text(), shaders::kRain});
    const wgpu::ShaderModule module = CreateShaderModule(device, code, "rain");
    const wgpu::ColorTargetState target = {.format = format, .blend = &kConstantMixBlend};
    const wgpu::FragmentState fragment = {
        .module = module, .entryPoint = "fs_rain", .targetCount = 1, .targets = &target};
    const wgpu::RenderPipelineDescriptor descriptor = {
        .vertex = {.module = module, .entryPoint = "vs_rain"},
        .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
        .fragment = &fragment,
    };
    pipeline_ = device.CreateRenderPipeline(&descriptor);
}

void Rain::Update(double time, double intensity, uint32_t width, uint32_t height,
                  const std::array<double, 2>& direction) {
    intensity_ = std::max(0.0, std::min(1.0, intensity));
    double length = std::hypot(direction[0], direction[1]);
    if (length == 0.0) {
        length = 1.0;
    }
    const float values[8] = {static_cast<float>(time),
                             static_cast<float>(width),
                             static_cast<float>(height),
                             0.0f,
                             static_cast<float>(direction[0] / length),
                             static_cast<float>(direction[1] / length),
                             0.0f,
                             0.0f};
    WriteBuffer(device_, uniformBuffer_, 0, values, 8);
}

void Rain::Draw(const wgpu::RenderPassEncoder& pass, const wgpu::TextureView& sceneView) {
    if (intensity_ <= 0.0) {
        return;
    }
    if (sceneView.Get() != sceneView_.Get()) {
        sceneView_ = sceneView;
        const wgpu::BindGroupEntry entries[] = {
            {.binding = 0, .buffer = uniformBuffer_},
            {.binding = 1, .textureView = sceneView},
            {.binding = 2, .sampler = sampler_},
        };
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = pipeline_.GetBindGroupLayout(0), .entryCount = 3, .entries = entries};
        bindGroup_ = device_.CreateBindGroup(&descriptor);
    }
    pass.SetPipeline(pipeline_);
    pass.SetBindGroup(0, bindGroup_);
    const wgpu::Color constant = {intensity_, intensity_, intensity_, intensity_};
    pass.SetBlendConstant(&constant);
    pass.Draw(3);
}

}  // namespace hackathon
