#include "app/terrain.h"

#include "app/light.h"
#include "shaders.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <array>
#include <cmath>
#include <numbers>
#include <vector>

namespace hackathon {

namespace {

// The distance from the grid center to the first ring. Hills near the camera can hide the ground
// below them, so the first ring is nearer than the bottom edge of the view.
constexpr double kGridNear = 100.0;
// The grid covers kGridHalfAngle to each side of the heading. The horizontal field of view of
// a 45-degree vertical field of view at 16:9 is approximately 36 degrees to each side.
constexpr double kGridHalfAngle = 50.0 * std::numbers::pi / 180.0;
// Approximately 2.7 pixels for each column at 1920 x 1080 with a 45-degree vertical field of view.
constexpr uint32_t kGridColumns = 900;
constexpr uint32_t kGridRows = 600;
const double kGridRingRatio = std::pow(kTerrainRadius / kGridNear, 1.0 / (kGridRows - 1));

// The solid terrain is an indexed triangle list. The GPU keeps recent vertex shader results,
// so it runs the vertex shader approximately once for each grid point.
// The rows draw from the camera outward, so near terrain usually draws first. Then the depth test
// prevents the fragment shader from running for far terrain that near terrain hides.
constexpr uint32_t kSolidIndexCount = (kGridRows - 1) * (kGridColumns - 1) * 6;
// Each ring has kGridColumns - 1 segments, and each column line has kGridRows - 1 segments.
constexpr uint32_t kWireVertexCount =
    2 * (kGridRows * (kGridColumns - 1) + kGridColumns * (kGridRows - 1));

// Perlin noise (fractal Brownian motion) for the hills.
// Each octave has double the frequency and half the amplitude of the octave before it.
constexpr double kNoiseWavelength = 4000.0;
constexpr double kNoiseAmplitude = 150.0;
constexpr uint32_t kNoiseOctaves = 6;

// The craters are in two layers: large craters that are far apart, and small craters that are
// near each other. Each layer divides the plane into square cells. A cell has one crater or no
// crater, and the crater has a random position and radius in the cell. Thus the distance between
// craters is not constant. A crater has an effect to 2 * radius from its center. The maximum
// radius must be no more than 0.25 of the cell size, because the shader looks only at the
// 2 x 2 cells nearest to the point.
constexpr double kLargeCraterCell = 2000.0;
constexpr double kLargeCraterProbability = 0.1;
constexpr std::array<double, 2> kLargeCraterRadius = {500.0, 1000.0};
constexpr double kSmallCraterCell = 800.0;
constexpr double kSmallCraterProbability = 0.35;
constexpr std::array<double, 2> kSmallCraterRadius = {30.0, 140.0};

// Cast shadows. The vertex shader sends a ray from each grid point toward the sun, and
// samples the height field at steps along the ray. Each step is kShadowStepGrowth times
// longer than the step before it, so near steps are short and far steps are long.
// kShadowSoftness sets the width of the soft edge: larger values give sharper shadows.
// The shadow rays use only the first kShadowOctaves of the noise, because the small octaves
// cost much time and have almost no effect on the shadows.
constexpr uint32_t kShadowSteps = 18;
constexpr double kShadowFirstStep = 4.0;
constexpr double kShadowStepGrowth = 1.35;
constexpr double kShadowSoftness = 16.0;
constexpr uint32_t kShadowOctaves = 3;
// The ray stops when it is higher than all terrain. This is an approximate upper limit:
// the noise is at most 2 * kNoiseAmplitude and a crater rim is at most 0.06 * radius.
constexpr double kMaxTerrainHeight = 2 * kNoiseAmplitude + 0.06 * kLargeCraterRadius[1];

// The float offsets in the Uniforms struct: viewProjection (16 floats), worldPos (3), gridYaw (1),
// and gridCenter (2). lowColor (4 floats), highColor (4), and style (4) follow gridCenter. The
// struct size is a multiple of 16 bytes.
constexpr uint64_t kWorldPosOffset = 16;
constexpr uint64_t kGridYawOffset = 19;
constexpr uint64_t kStyleOffset = 24;
constexpr uint64_t kUniformFloats = 36;

std::string MakeShader() {
    WgslConstants constants;
    constants.U32("GRID_COLUMNS", kGridColumns)
        .U32("GRID_ROWS", kGridRows)
        .F32("GRID_NEAR", kGridNear)
        .F32("GRID_HALF_ANGLE", kGridHalfAngle)
        .F32("GRID_RING_RATIO", kGridRingRatio)
        .F32("NOISE_FREQUENCY", 1.0 / kNoiseWavelength)
        .F32("NOISE_AMPLITUDE", kNoiseAmplitude)
        .U32("NOISE_OCTAVES", kNoiseOctaves)
        .U32("SHADOW_STEPS", kShadowSteps)
        .U32("SHADOW_OCTAVES", kShadowOctaves)
        .F32("SHADOW_FIRST_STEP", kShadowFirstStep)
        .F32("SHADOW_STEP_GROWTH", kShadowStepGrowth)
        .F32("SHADOW_SOFTNESS", kShadowSoftness)
        .F32("MAX_TERRAIN_HEIGHT", kMaxTerrainHeight)
        .F32("LARGE_CRATER_CELL", kLargeCraterCell)
        .F32("LARGE_CRATER_PROBABILITY", kLargeCraterProbability)
        .F32("LARGE_CRATER_RADIUS_MIN", kLargeCraterRadius[0])
        .F32("LARGE_CRATER_RADIUS_MAX", kLargeCraterRadius[1])
        .F32("SMALL_CRATER_CELL", kSmallCraterCell)
        .F32("SMALL_CRATER_PROBABILITY", kSmallCraterProbability)
        .F32("SMALL_CRATER_RADIUS_MIN", kSmallCraterRadius[0])
        .F32("SMALL_CRATER_RADIUS_MAX", kSmallCraterRadius[1]);
    return JoinWgsl({shaders::kLight, constants.Text(), shaders::kTerrain});
}

}  // namespace

Terrain::Terrain(const wgpu::Device& device, wgpu::TextureFormat format,
                 wgpu::TextureFormat depthFormat, const DirectionalLight& light)
    : device_(device), light_(light) {
    uniformBuffer_ = CreateBuffer(device, kUniformFloats * sizeof(float),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);

    // Two triangles for each grid cell. The rows go from the camera outward.
    std::vector<uint32_t> indices;
    indices.reserve(kSolidIndexCount);
    for (uint32_t row = 0; row < kGridRows - 1; ++row) {
        for (uint32_t column = 0; column < kGridColumns - 1; ++column) {
            const uint32_t nearIndex = row * kGridColumns + column;
            const uint32_t farIndex = nearIndex + kGridColumns;
            indices.insert(indices.end(), {nearIndex, nearIndex + 1, farIndex, farIndex,
                                           nearIndex + 1, farIndex + 1});
        }
    }
    indexBuffer_ = CreateBufferWithData(device, indices, wgpu::BufferUsage::Index);

    // Both pipelines share one layout so that the same bind groups work for both. The fragment
    // shader reads the colors of the style.
    const wgpu::BindGroupLayoutEntry layoutEntry =
        UniformEntry(0, wgpu::ShaderStage::Vertex | wgpu::ShaderStage::Fragment);
    const wgpu::BindGroupLayoutDescriptor layoutDescriptor = {.entryCount = 1,
                                                              .entries = &layoutEntry};
    const wgpu::BindGroupLayout bindGroupLayout = device.CreateBindGroupLayout(&layoutDescriptor);
    const wgpu::BindGroupLayout layouts[] = {bindGroupLayout, light.BindGroupLayout()};
    const wgpu::PipelineLayoutDescriptor pipelineLayoutDescriptor = {.bindGroupLayoutCount = 2,
                                                                     .bindGroupLayouts = layouts};
    const wgpu::PipelineLayout pipelineLayout =
        device.CreatePipelineLayout(&pipelineLayoutDescriptor);
    const wgpu::BindGroupEntry entry = {.binding = 0, .buffer = uniformBuffer_};
    const wgpu::BindGroupDescriptor bindGroupDescriptor = {
        .layout = bindGroupLayout, .entryCount = 1, .entries = &entry};
    bindGroup_ = device.CreateBindGroup(&bindGroupDescriptor);

    const wgpu::ShaderModule module = CreateShaderModule(device, MakeShader(), "terrain");
    const wgpu::DepthStencilState depthStencil = {.format = depthFormat,
                                                  .depthWriteEnabled = wgpu::OptionalBool::True,
                                                  .depthCompare = wgpu::CompareFunction::Less};
    const wgpu::ColorTargetState target = {.format = format};
    auto createPipeline = [&](const char* vertexEntry, const char* fragmentEntry,
                              wgpu::PrimitiveTopology topology) {
        const wgpu::FragmentState fragment = {
            .module = module, .entryPoint = fragmentEntry, .targetCount = 1, .targets = &target};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = pipelineLayout,
            .vertex = {.module = module, .entryPoint = vertexEntry},
            .primitive = {.topology = topology},
            .depthStencil = &depthStencil,
            .fragment = &fragment,
        };
        return device.CreateRenderPipeline(&descriptor);
    };
    solidPipeline_ = createPipeline("vs_solid", "fs_solid", wgpu::PrimitiveTopology::TriangleList);
    wirePipeline_ = createPipeline("vs_wire", "fs_wire", wgpu::PrimitiveTopology::LineList);
}

void Terrain::SetStyle(const TerrainStyle& style) {
    const std::array<float, 12> values = {
        static_cast<float>(style.lowColor[0]),
        static_cast<float>(style.lowColor[1]),
        static_cast<float>(style.lowColor[2]),
        0.0f,
        static_cast<float>(style.highColor[0]),
        static_cast<float>(style.highColor[1]),
        static_cast<float>(style.highColor[2]),
        0.0f,
        static_cast<float>(style.heightScale),
        static_cast<float>(style.craterScale),
        0.0f,
        0.0f,
    };
    WriteBuffer(device_, uniformBuffer_, kStyleOffset * sizeof(float), values.data(),
                values.size());
}

void Terrain::SetViewProjection(const Mat4& viewProjection) {
    WriteBuffer(device_, uniformBuffer_, 0, viewProjection.data(), viewProjection.size());
}

void Terrain::SetGridCenter(const Vec3& position, const Vec3& heading) {
    const std::array<float, 3> values = {static_cast<float>(std::atan2(heading[0], heading[2])),
                                         static_cast<float>(position[0]),
                                         static_cast<float>(position[2])};
    WriteBuffer(device_, uniformBuffer_, kGridYawOffset * sizeof(float), values.data(),
                values.size());
}

void Terrain::Update(const Vec3& worldPosition) {
    const std::array<float, 3> values = {static_cast<float>(worldPosition[0]),
                                         static_cast<float>(worldPosition[1]),
                                         static_cast<float>(worldPosition[2])};
    WriteBuffer(device_, uniformBuffer_, kWorldPosOffset * sizeof(float), values.data(),
                values.size());
}

void Terrain::Draw(const wgpu::RenderPassEncoder& pass) const {
    pass.SetBindGroup(0, bindGroup_);
    light_.Bind(pass);
    if (mode_ == TerrainRenderMode::Wireframe) {
        pass.SetPipeline(wirePipeline_);
        pass.Draw(kWireVertexCount);
    } else {
        pass.SetPipeline(solidPipeline_);
        pass.SetIndexBuffer(indexBuffer_, wgpu::IndexFormat::Uint32);
        pass.DrawIndexed(kSolidIndexCount);
    }
}

}  // namespace hackathon
