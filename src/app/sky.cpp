#include "app/sky.h"

#include "app/light.h"
#include "shaders.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <cmath>
#include <numbers>
#include <string>

namespace hackathon {

namespace {

// The star layers. Each layer divides the directions into cells of 1 / grid radians. A cell has a
// star with the given probability, at a random position in the cell. Bright stars have a glow and
// four spikes, as stars in photographs do.
struct StarLayer {
    int grid;
    double probability;
    double brightness;
    bool spikes;
};
constexpr StarLayer kStarLayers[] = {
    {500, 0.02, 0.6, false},
    {250, 0.03, 1.0, false},
    {20, 0.012, 1.5, true},
};

// The ring and the moons, relative to the planet radius R.
constexpr double kRingInner = 1.35;
constexpr double kRingOuter = 2.2;
// The ring normal leans away from the planet up direction, to the left and toward the viewer.
constexpr double kRingLeanLeft = 0.4;
constexpr double kRingLeanTowardViewer = 0.28;
// Each moon: an offset from the planet center in R (to the right and up as the viewer sees it), a
// radius in R, and a distance relative to the planet distance. A distance smaller than 1 puts the
// moon in front of the planet.
struct Moon {
    double right;
    double up;
    double radius;
    double distance;
    uint32_t seed;
};
constexpr Moon kMoons[] = {
    {-0.6, -0.78, 0.22, 0.95, 1},
    {1.9, 1.45, 0.09, 1.3, 2},
};
constexpr uint32_t kMoonCount = std::size(kMoons);

// The inverse view-projection matrix (16 floats), and the atmosphere and flash position vectors
// (4 floats each).
constexpr uint64_t kUniformFloats = 24;
constexpr uint64_t kAtmosphereOffset = 16;

Vec3 Normalize(const Vec3& v) {
    const double length = std::hypot(v[0], v[1], v[2]);
    return {v[0] / length, v[1] / length, v[2] / length};
}

Vec3 Cross(const Vec3& a, const Vec3& b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}

// The WGSL constants of the planet, the ring, and the moons, in a space where the camera is at the
// origin and the planet center is 1 unit away.
void AddPlanetConstants(const PlanetOptions& planet, const Vec3& heading,
                        WgslConstants& constants) {
    const double toRadians = std::numbers::pi / 180.0;
    const Vec3 right = {-heading[2], 0.0, heading[0]};
    const double turn = planet.rightDegrees * toRadians;
    Vec3 horizontal;
    for (size_t i = 0; i < 3; ++i) {
        horizontal[i] = heading[i] * std::cos(turn) + right[i] * std::sin(turn);
    }
    const double elevation = planet.elevationDegrees * toRadians;
    const Vec3 center = Normalize({horizontal[0] * std::cos(elevation), std::sin(elevation),
                                   horizontal[2] * std::cos(elevation)});
    const double radius = std::sin(planet.radiusDegrees * toRadians);
    // The right and up directions of the viewer at the planet.
    const Vec3 planetRight = Normalize(Cross(center, {0.0, 1.0, 0.0}));
    const Vec3 planetUp = Cross(planetRight, center);
    Vec3 ringNormal;
    for (size_t i = 0; i < 3; ++i) {
        ringNormal[i] =
            planetUp[i] - planetRight[i] * kRingLeanLeft - center[i] * kRingLeanTowardViewer;
    }
    ringNormal = Normalize(ringNormal);

    std::string moons = "array<Body, " + std::to_string(kMoonCount) + ">(";
    for (uint32_t m = 0; m < kMoonCount; ++m) {
        const Moon& moon = kMoons[m];
        Vec3 direction;
        for (size_t i = 0; i < 3; ++i) {
            direction[i] =
                center[i] + (planetRight[i] * moon.right + planetUp[i] * moon.up) * radius;
        }
        direction = Normalize(direction);
        const Vec3 moonCenter = {direction[0] * moon.distance, direction[1] * moon.distance,
                                 direction[2] * moon.distance};
        moons += (m > 0 ? ", " : "");
        moons += "Body(" + WgslVec3(moonCenter) + ", " +
                 WgslFloat(moon.radius * radius * moon.distance) + ", " +
                 std::to_string(moon.seed) + "u)";
    }
    moons += ")";

    constants.Vec3f("PLANET_CENTER", center)
        .F32("PLANET_RADIUS", radius)
        .Vec3f("RING_NORMAL", ringNormal)
        .F32("RING_INNER", kRingInner)
        .F32("RING_OUTER", kRingOuter)
        .U32("MOON_COUNT", kMoonCount)
        .Raw("MOONS", "array<Body, " + std::to_string(kMoonCount) + ">", moons);
}

std::string MakeShader(const SkyOptions& options, const Vec3& heading) {
    WgslConstants constants;
    constants.Bool("NEBULA", options.nebula)
        .Bool("ATMOSPHERE", options.atmosphere)
        .Bool("SUN_DISK", options.sunDisk)
        // The horizontal heading. The tilt of the horizon goes up along it.
        .Vec3f("HEADING", heading);
    if (options.planet) {
        AddPlanetConstants(*options.planet, heading, constants);
    }

    std::string starLayers;
    for (size_t i = 0; i < std::size(kStarLayers); ++i) {
        const StarLayer& layer = kStarLayers[i];
        starLayers += (i > 0 ? "\n  " : "");
        starLayers += "color += starLayer(dir, pixelAngle, screenX, screenY, " +
                      WgslFloat(layer.grid) + ", " + WgslFloat(layer.probability) + ", " +
                      WgslFloat(layer.brightness) + ", " + (layer.spikes ? "true" : "false") +
                      ", " + std::to_string(100 + i * 10) + "u);";
    }

    const std::string body = FillPlaceholders(
        shaders::kSky,
        {
            {"PLANET", options.planet ? shaders::kSkyPlanet : std::string_view()},
            {"STAR_LAYERS", starLayers},
            {"PLANET_FRAGMENT", options.planet ? shaders::kSkyPlanetFragment : std::string_view()},
        });
    return JoinWgsl({shaders::kLight, shaders::kNoise, constants.Text(), body});
}

}  // namespace

Sky::Sky(const wgpu::Device& device, wgpu::TextureFormat format, wgpu::TextureFormat depthFormat,
         const DirectionalLight& light, const Vec3& heading, const SkyOptions& options)
    : device_(device), light_(light) {
    uniformBuffer_ = CreateBuffer(device, kUniformFloats * sizeof(float),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    const wgpu::BindGroupLayoutEntry layoutEntry = UniformEntry(0, wgpu::ShaderStage::Fragment);
    const wgpu::BindGroupLayoutDescriptor layoutDescriptor = {.entryCount = 1,
                                                              .entries = &layoutEntry};
    const wgpu::BindGroupLayout layout = device.CreateBindGroupLayout(&layoutDescriptor);
    const wgpu::BindGroupEntry entry = {.binding = 0, .buffer = uniformBuffer_};
    const wgpu::BindGroupDescriptor bindGroupDescriptor = {
        .layout = layout, .entryCount = 1, .entries = &entry};
    bindGroup_ = device.CreateBindGroup(&bindGroupDescriptor);

    const wgpu::BindGroupLayout layouts[] = {layout, light.BindGroupLayout()};
    const wgpu::PipelineLayoutDescriptor pipelineLayoutDescriptor = {.bindGroupLayoutCount = 2,
                                                                     .bindGroupLayouts = layouts};
    const wgpu::ShaderModule module =
        CreateShaderModule(device, MakeShader(options, heading), "sky");
    const wgpu::ColorTargetState target = {.format = format};
    const wgpu::FragmentState fragment = {
        .module = module, .entryPoint = "fs_sky", .targetCount = 1, .targets = &target};
    // The sky is at depth 1, the depth clear value. It shows only where nothing was drawn.
    const wgpu::DepthStencilState depthStencil = {.format = depthFormat,
                                                  .depthWriteEnabled = wgpu::OptionalBool::False,
                                                  .depthCompare = wgpu::CompareFunction::LessEqual};
    const wgpu::RenderPipelineDescriptor descriptor = {
        .layout = device.CreatePipelineLayout(&pipelineLayoutDescriptor),
        .vertex = {.module = module, .entryPoint = "vs_sky"},
        .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
        .depthStencil = &depthStencil,
        .fragment = &fragment,
    };
    pipeline_ = device.CreateRenderPipeline(&descriptor);
}

void Sky::SetCamera(const Mat4& viewProjection, const Vec3& cameraPosition) {
    const Mat4 atOrigin =
        Multiply(viewProjection, TranslationScale(cameraPosition, {1.0, 1.0, 1.0}));
    const Mat4 inverse = Invert(atOrigin);
    WriteBuffer(device_, uniformBuffer_, 0, inverse.data(), inverse.size());
}

void Sky::SetAtmosphere(double depth, double flash, const std::array<double, 2>& flashPosition,
                        double horizonDip, double horizonTilt, double aspect) {
    const std::array<float, 8> values = {
        static_cast<float>(depth),
        static_cast<float>(flash),
        static_cast<float>(std::sin(horizonDip)),
        static_cast<float>(std::tan(horizonTilt)),
        static_cast<float>(flashPosition[0]),
        static_cast<float>(flashPosition[1]),
        static_cast<float>(aspect),
        0.0f,
    };
    WriteBuffer(device_, uniformBuffer_, kAtmosphereOffset * sizeof(float), values.data(),
                values.size());
}

void Sky::Draw(const wgpu::RenderPassEncoder& pass) const {
    pass.SetPipeline(pipeline_);
    pass.SetBindGroup(0, bindGroup_);
    light_.Bind(pass);
    pass.Draw(3);
}

}  // namespace hackathon
