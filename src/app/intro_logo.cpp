#include "app/intro_logo.h"

#include "shaders.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <algorithm>

namespace hackathon {

namespace {

constexpr std::array<double, 2> kLogoSize = {1740.0, 902.0};
constexpr std::array<double, 2> kColorLogoOffset = {120.0, 118.0};
// The part of the screen that the logo can use.
constexpr double kLogoScreenFraction = 0.92;

std::string Vec2(double x, double y) { return "vec2f(" + WgslFloat(x) + ", " + WgslFloat(y) + ")"; }

}  // namespace

IntroLogo::IntroLogo(const wgpu::Device& device, wgpu::TextureFormat format,
                     wgpu::TextureFormat depthFormat, const IntroImages& images)
    : device_(device) {
    uniformBuffer_ = CreateBuffer(device, sizeof(uniforms_),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    auto texture = [&device](const RgbaImage& image) {
        const wgpu::TextureDescriptor descriptor = {
            .usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst,
            .size = {image.width, image.height, 1},
            .format = wgpu::TextureFormat::RGBA8Unorm,
        };
        const wgpu::Texture result = device.CreateTexture(&descriptor);
        const wgpu::TexelCopyTextureInfo destination = {.texture = result};
        const wgpu::TexelCopyBufferLayout layout = {.bytesPerRow = image.width * 4};
        const wgpu::Extent3D size = {image.width, image.height, 1};
        device.GetQueue().WriteTexture(&destination, image.data.data(), image.data.size(), &layout,
                                       &size);
        return result.CreateView();
    };
    WgslConstants constants;
    constants.Raw("LOGO_SIZE", "vec2f", Vec2(kLogoSize[0], kLogoSize[1]))
        .Raw("COLOR_OFFSET", "vec2f", Vec2(kColorLogoOffset[0], kColorLogoOffset[1]));
    const wgpu::ShaderModule module =
        CreateShaderModule(device, JoinWgsl({constants.Text(), shaders::kIntroLogo}), "intro logo");
    const wgpu::ColorTargetState target = {.format = format};
    const wgpu::FragmentState fragment = {
        .module = module, .entryPoint = "fs_logo", .targetCount = 1, .targets = &target};
    const wgpu::DepthStencilState depthStencil = {.format = depthFormat,
                                                  .depthWriteEnabled = wgpu::OptionalBool::False,
                                                  .depthCompare = wgpu::CompareFunction::Always};
    const wgpu::RenderPipelineDescriptor descriptor = {
        .vertex = {.module = module, .entryPoint = "vs_logo"},
        .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
        .depthStencil = &depthStencil,
        .fragment = &fragment,
    };
    pipeline_ = device.CreateRenderPipeline(&descriptor);
    const wgpu::SamplerDescriptor samplerDescriptor = {
        .addressModeU = wgpu::AddressMode::ClampToEdge,
        .addressModeV = wgpu::AddressMode::ClampToEdge,
        .magFilter = wgpu::FilterMode::Linear,
        .minFilter = wgpu::FilterMode::Linear,
    };
    const wgpu::BindGroupEntry entries[] = {
        {.binding = 0, .buffer = uniformBuffer_},
        {.binding = 1, .textureView = texture(images.colorLogo)},
        {.binding = 2, .textureView = texture(images.neon)},
        {.binding = 3, .textureView = texture(images.neonTube)},
        {.binding = 4, .sampler = device.CreateSampler(&samplerDescriptor)},
    };
    const wgpu::BindGroupDescriptor bindGroupDescriptor = {
        .layout = pipeline_.GetBindGroupLayout(0), .entryCount = 5, .entries = entries};
    bindGroup_ = device.CreateBindGroup(&bindGroupDescriptor);
}

void IntroLogo::Update(const LogoState& state, uint32_t width, uint32_t height) {
    scale_ = std::min((width * kLogoScreenFraction) / kLogoSize[0],
                      (height * kLogoScreenFraction) / kLogoSize[1]);
    origin_ = {(width - kLogoSize[0] * scale_) / 2, (height - kLogoSize[1] * scale_) / 2};
    const double values[8] = {origin_[0],        origin_[1],       scale_,           0.0,
                              state.colorToNeon, state.neonToTube, state.brightness, state.panel};
    for (size_t i = 0; i < 8; ++i) {
        uniforms_[i] = static_cast<float>(values[i]);
    }
    // Room for 12 tubes. The tubes that do not exist are 0.
    for (size_t tube = 0; tube < 12; ++tube) {
        uniforms_[8 + tube] = tube < kTubeCount ? static_cast<float>(state.tubes[tube]) : 0.0f;
    }
    uniforms_[20] = static_cast<float>(state.flash);
    uniforms_[21] = 0.0f;
    uniforms_[22] = 0.0f;
    uniforms_[23] = 0.0f;
    WriteBuffer(device_, uniformBuffer_, 0, uniforms_.data(), uniforms_.size());
}

std::array<double, 2> IntroLogo::ToScreen(double x, double y) const {
    return {origin_[0] + x * scale_, origin_[1] + y * scale_};
}

void IntroLogo::Draw(const wgpu::RenderPassEncoder& pass) const {
    pass.SetPipeline(pipeline_);
    pass.SetBindGroup(0, bindGroup_);
    pass.Draw(3);
}

}  // namespace hackathon
