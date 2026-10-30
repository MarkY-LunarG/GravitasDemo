#include "app/lens_flare.h"

#include "shaders.h"
#include "util/gpu.h"
#include "util/random.h"
#include "util/shader_builder.h"

#include <array>
#include <cmath>
#include <string>

namespace hackathon {

namespace {

// The radius of the probe disk, in radians around the sun direction. The sun disk of the sky has
// a radius of approximately 0.03 radians.
constexpr double kProbeRadius = 0.03;
// The total brightness of the flare.
constexpr double kFlareStrength = 1.0;
// The query indices.
constexpr uint32_t kVisibleQuery = 0;
constexpr uint32_t kTotalQuery = 1;
constexpr uint32_t kQueryCount = 2;
constexpr size_t kUniformFloats = 24;

// The ghosts: the position along the line from the sun (1) through the center of the screen (0),
// the radius in screen heights, and the color and brightness.
struct Ghost {
    double at;
    double radius;
    Vec3 color;
};
constexpr std::array<Ghost, 6> kGhosts = {{
    {0.55, 0.04, {0.5, 0.32, 0.1}},
    {0.2, 0.025, {0.35, 0.45, 0.15}},
    {-0.2, 0.08, {0.12, 0.22, 0.4}},
    {-0.45, 0.035, {0.45, 0.25, 0.08}},
    {-0.75, 0.12, {0.1, 0.3, 0.3}},
    {-1.2, 0.07, {0.3, 0.12, 0.4}},
}};
// The brightness of the ghosts, relative to the glow at the sun.
constexpr double kGhostBrightness = 0.5;
// The ghost shapes. The seed makes the same shapes in each run, so that the benchmark is the same.
constexpr uint32_t kHexagon = 0;
constexpr uint32_t kCircle = 1;
constexpr uint32_t kOval = 2;
constexpr uint32_t kShapeSeed = 271828;
// An oval is this wide along the line through the sun, relative to its width across the line.
constexpr double kOvalSquash = 0.55;

std::string MakeShader() {
    Random shapeRandom(kShapeSeed);
    std::string ghosts = "array<Ghost, GHOST_COUNT>(\n";
    for (size_t i = 0; i < kGhosts.size(); ++i) {
        const Ghost& ghost = kGhosts[i];
        const uint32_t shape = static_cast<uint32_t>(std::floor(shapeRandom.Next() * 3));
        ghosts += "  Ghost(" + WgslFloat(ghost.at) + ", " + WgslFloat(ghost.radius) + ", " +
                  WgslVec3(ghost.color) + ", " + std::to_string(shape) + "u)" +
                  (i + 1 < kGhosts.size() ? ",\n" : "\n");
    }
    ghosts += ")";
    WgslConstants constants;
    constants.F32("PROBE_RADIUS", kProbeRadius)
        .U32("QUERY_COUNT", kQueryCount)
        .U32("VISIBLE_QUERY", kVisibleQuery)
        .U32("TOTAL_QUERY", kTotalQuery)
        .U32("HEXAGON", kHexagon)
        .U32("CIRCLE", kCircle)
        .U32("OVAL", kOval)
        .Abstract("OVAL_SQUASH", kOvalSquash)
        .Abstract("GHOST_BRIGHTNESS", kGhostBrightness)
        .U32("GHOST_COUNT", static_cast<uint32_t>(kGhosts.size()))
        .Raw("GHOSTS", "array<Ghost, GHOST_COUNT>", ghosts);
    return JoinWgsl({constants.Text(), shaders::kLensFlare});
}

}  // namespace

LensFlare::LensFlare(const wgpu::Device& device, wgpu::TextureFormat format,
                     wgpu::TextureFormat depthFormat)
    : device_(device) {
    const wgpu::QuerySetDescriptor querySetDescriptor = {.type = wgpu::QueryType::Occlusion,
                                                         .count = kQueryCount};
    querySet_ = device.CreateQuerySet(&querySetDescriptor);
    uniformBuffer_ = CreateBuffer(device, kUniformFloats * sizeof(float),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    occlusionBuffer_ = CreateBuffer(device, kQueryCount * sizeof(uint64_t),
                                    wgpu::BufferUsage::QueryResolve | wgpu::BufferUsage::Storage);

    const wgpu::ShaderModule module = CreateShaderModule(device, MakeShader(), "lens flare");
    const wgpu::BindGroupLayoutEntry probeEntry = UniformEntry(0, wgpu::ShaderStage::Vertex);
    const wgpu::BindGroupLayoutDescriptor probeLayoutDescriptor = {.entryCount = 1,
                                                                   .entries = &probeEntry};
    const wgpu::BindGroupLayout probeLayout = device.CreateBindGroupLayout(&probeLayoutDescriptor);
    const wgpu::BindGroupLayoutEntry flareEntries[] = {
        UniformEntry(0, wgpu::ShaderStage::Vertex),
        {.binding = 1,
         .visibility = wgpu::ShaderStage::Vertex,
         .buffer = {.type = wgpu::BufferBindingType::ReadOnlyStorage}},
    };
    const wgpu::BindGroupLayoutDescriptor flareLayoutDescriptor = {.entryCount = 2,
                                                                   .entries = flareEntries};
    const wgpu::BindGroupLayout flareLayout = device.CreateBindGroupLayout(&flareLayoutDescriptor);

    const wgpu::PipelineLayoutDescriptor probePipelineLayout = {.bindGroupLayoutCount = 1,
                                                                .bindGroupLayouts = &probeLayout};
    const wgpu::PipelineLayout probeLayoutObject =
        device.CreatePipelineLayout(&probePipelineLayout);
    auto probePipeline = [&](wgpu::CompareFunction depthCompare) {
        // The probe changes no pixels: it only counts samples.
        const wgpu::ColorTargetState target = {.format = format,
                                               .writeMask = wgpu::ColorWriteMask::None};
        const wgpu::FragmentState fragment = {
            .module = module, .entryPoint = "fs_probe", .targetCount = 1, .targets = &target};
        const wgpu::DepthStencilState depthStencil = {
            .format = depthFormat,
            .depthWriteEnabled = wgpu::OptionalBool::False,
            .depthCompare = depthCompare};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = probeLayoutObject,
            .vertex = {.module = module, .entryPoint = "vs_probe"},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
            .depthStencil = &depthStencil,
            .fragment = &fragment,
        };
        return device.CreateRenderPipeline(&descriptor);
    };
    visiblePipeline_ = probePipeline(wgpu::CompareFunction::LessEqual);
    totalPipeline_ = probePipeline(wgpu::CompareFunction::Always);
    {
        const wgpu::PipelineLayoutDescriptor flarePipelineLayout = {
            .bindGroupLayoutCount = 1, .bindGroupLayouts = &flareLayout};
        // Light adds to the image.
        const wgpu::ColorTargetState target = {.format = format, .blend = &kAdditiveBlend};
        const wgpu::FragmentState fragment = {
            .module = module, .entryPoint = "fs_flare", .targetCount = 1, .targets = &target};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = device.CreatePipelineLayout(&flarePipelineLayout),
            .vertex = {.module = module, .entryPoint = "vs_flare"},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
            .fragment = &fragment,
        };
        flarePipeline_ = device.CreateRenderPipeline(&descriptor);
    }
    {
        const wgpu::BindGroupEntry entry = {.binding = 0, .buffer = uniformBuffer_};
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = probeLayout, .entryCount = 1, .entries = &entry};
        probeBindGroup_ = device.CreateBindGroup(&descriptor);
    }
    {
        const wgpu::BindGroupEntry entries[] = {{.binding = 0, .buffer = uniformBuffer_},
                                                {.binding = 1, .buffer = occlusionBuffer_}};
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = flareLayout, .entryCount = 2, .entries = entries};
        flareBindGroup_ = device.CreateBindGroup(&descriptor);
    }
}

void LensFlare::Update(const Mat4& viewProjection, const Vec3& sunDirection, const Vec3& sunColor,
                       double aspect) {
    std::array<float, kUniformFloats> data = {};
    std::copy(viewProjection.begin(), viewProjection.end(), data.begin());
    const double values[8] = {sunDirection[0], sunDirection[1], sunDirection[2], aspect,
                              sunColor[0],     sunColor[1],     sunColor[2],     kFlareStrength};
    for (size_t k = 0; k < 8; ++k) {
        data[16 + k] = static_cast<float>(values[k]);
    }
    WriteBuffer(device_, uniformBuffer_, 0, data.data(), data.size());
}

void LensFlare::DrawProbes(const wgpu::RenderPassEncoder& pass) const {
    pass.PushDebugGroup("Sun occlusion");
    pass.SetBindGroup(0, probeBindGroup_);
    pass.SetPipeline(visiblePipeline_);
    pass.BeginOcclusionQuery(kVisibleQuery);
    pass.Draw(6);
    pass.EndOcclusionQuery();
    pass.SetPipeline(totalPipeline_);
    pass.BeginOcclusionQuery(kTotalQuery);
    pass.Draw(6);
    pass.EndOcclusionQuery();
    pass.PopDebugGroup();
}

void LensFlare::Resolve(const wgpu::CommandEncoder& encoder) const {
    encoder.ResolveQuerySet(querySet_, 0, kQueryCount, occlusionBuffer_, 0);
}

void LensFlare::Draw(const wgpu::RenderPassEncoder& pass) const {
    pass.SetPipeline(flarePipeline_);
    pass.SetBindGroup(0, flareBindGroup_);
    pass.Draw(6, 2 + static_cast<uint32_t>(kGhosts.size()));
}

}  // namespace hackathon
