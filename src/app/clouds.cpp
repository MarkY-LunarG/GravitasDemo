#include "app/clouds.h"

#include "app/light.h"
#include "shaders.h"
#include "util/gpu.h"
#include "util/random.h"
#include "util/shader_builder.h"

#include <algorithm>
#include <cmath>

namespace hackathon {

namespace {

constexpr size_t kCloudCount = 160;
// The clouds move in a box around the ship, as the asteroids do. The axes are right, up, and the
// heading, in meters from the ship center. A cloud that leaves the near end comes back at the far
// end. kFarFade is the distance at the far end where the clouds fade in.
constexpr std::array<double, 2> kBoxRight = {-900.0, 900.0};
constexpr std::array<double, 2> kBoxUp = {-260.0, 260.0};
constexpr std::array<double, 2> kBoxHeading = {-320.0, 3200.0};
constexpr double kFarFade = 700.0;
constexpr std::array<double, 2> kCloudRadius = {70.0, 230.0};
constexpr double kCloudSpeed = 650.0;
constexpr double kCloudOpacity = 0.85;
constexpr uint32_t kRandomSeed = 7202610;

// The center (3 floats) and radius, and then the seed, opacity, and 2 unused floats.
constexpr size_t kCloudFloats = 8;
// viewProjection (16 floats), camera position (4), and flash (4).
constexpr size_t kUniformFloats = 24;

// Premultiplied alpha. The alpha of the target does not change.
constexpr wgpu::BlendState kPremultipliedBlend = {
    .color = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::One,
              .dstFactor = wgpu::BlendFactor::OneMinusSrcAlpha},
    .alpha = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::Zero,
              .dstFactor = wgpu::BlendFactor::One},
};

}  // namespace

Clouds::Clouds(const wgpu::Device& device, wgpu::TextureFormat format,
               wgpu::TextureFormat depthFormat, const DirectionalLight& light,
               const Vec3& shipCenter, const Vec3& heading)
    : device_(device),
      light_(light),
      shipCenter_(shipCenter),
      right_({-heading[2], 0.0, heading[0]}),
      up_({0.0, 1.0, 0.0}),
      heading_(heading),
      cloudData_(kCloudCount * kCloudFloats, 0.0f),
      uniformData_(kUniformFloats, 0.0f) {
    Random random(kRandomSeed);
    for (size_t i = 0; i < kCloudCount; ++i) {
        CloudState cloud;
        // Do not change the order of the random values: it sets the contents of the scene, so a
        // different order gives a different benchmark.
        cloud.local[0] = random.Between(kBoxRight[0], kBoxRight[1]);
        cloud.local[1] = random.Between(kBoxUp[0], kBoxUp[1]);
        cloud.local[2] = random.Between(kBoxHeading[0], kBoxHeading[1]);
        cloud.radius = random.Between(kCloudRadius[0], kCloudRadius[1]);
        cloud.seed = random.Next() * 100;
        clouds_.push_back(cloud);
    }

    uniformBuffer_ = CreateBuffer(device, kUniformFloats * sizeof(float),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    cloudBuffer_ = CreateBuffer(device, cloudData_.size() * sizeof(float),
                                wgpu::BufferUsage::Storage | wgpu::BufferUsage::CopyDst);
    const std::vector<uint16_t> indices = {0, 1, 2, 2, 1, 3};
    indexBuffer_ = CreateBufferWithData(device, indices, wgpu::BufferUsage::Index);
    // indexCount, instanceCount, firstIndex, baseVertex, and firstInstance. Update() sets the
    // instance count.
    indirectBuffer_ = CreateBuffer(device, 5 * sizeof(uint32_t),
                                   wgpu::BufferUsage::Indirect | wgpu::BufferUsage::CopyDst);

    const wgpu::BindGroupLayoutEntry layoutEntries[] = {
        UniformEntry(0, wgpu::ShaderStage::Vertex | wgpu::ShaderStage::Fragment),
        {.binding = 1,
         .visibility = wgpu::ShaderStage::Vertex,
         .buffer = {.type = wgpu::BufferBindingType::ReadOnlyStorage}},
    };
    const wgpu::BindGroupLayoutDescriptor layoutDescriptor = {.entryCount = 2,
                                                              .entries = layoutEntries};
    const wgpu::BindGroupLayout layout = device.CreateBindGroupLayout(&layoutDescriptor);
    const wgpu::BindGroupEntry entries[] = {{.binding = 0, .buffer = uniformBuffer_},
                                            {.binding = 1, .buffer = cloudBuffer_}};
    const wgpu::BindGroupDescriptor bindGroupDescriptor = {
        .layout = layout, .entryCount = 2, .entries = entries};
    bindGroup_ = device.CreateBindGroup(&bindGroupDescriptor);

    const std::string code = JoinWgsl({shaders::kLight, shaders::kNoise, shaders::kClouds});
    const wgpu::ShaderModule module = CreateShaderModule(device, code, "clouds");
    const wgpu::BindGroupLayout layouts[] = {layout, light.BindGroupLayout()};
    const wgpu::PipelineLayoutDescriptor pipelineLayout = {.bindGroupLayoutCount = 2,
                                                           .bindGroupLayouts = layouts};
    const wgpu::ColorTargetState target = {.format = format, .blend = &kPremultipliedBlend};
    const wgpu::FragmentState fragment = {
        .module = module, .entryPoint = "fs_cloud", .targetCount = 1, .targets = &target};
    // The ship hides the clouds behind it. The clouds do not write depth, so they do not hide
    // each other.
    const wgpu::DepthStencilState depthStencil = {.format = depthFormat,
                                                  .depthWriteEnabled = wgpu::OptionalBool::False,
                                                  .depthCompare = wgpu::CompareFunction::Less};
    const wgpu::RenderPipelineDescriptor descriptor = {
        .layout = device.CreatePipelineLayout(&pipelineLayout),
        .vertex = {.module = module, .entryPoint = "vs_cloud"},
        .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
        .depthStencil = &depthStencil,
        .fragment = &fragment,
    };
    pipeline_ = device.CreateRenderPipeline(&descriptor);
}

void Clouds::Update(double seconds, double density, double flash,
                    const std::array<double, 2>& flashPosition, double aspect,
                    const Mat4& viewProjection, const Vec3& cameraPosition) {
    struct Visible {
        Vec3 center;
        double distance;
        const CloudState* cloud;
        double opacity;
    };
    const double length = kBoxHeading[1] - kBoxHeading[0];
    std::vector<Visible> visible;
    const size_t activeCount =
        static_cast<size_t>(std::round(kCloudCount * std::max(0.0, std::min(1.0, density))));
    for (size_t index = 0; index < clouds_.size(); ++index) {
        CloudState& cloud = clouds_[index];
        cloud.local[2] -= kCloudSpeed * seconds;
        if (cloud.local[2] < kBoxHeading[0]) {
            cloud.local[2] += length;
        }
        if (index >= activeCount) {
            continue;
        }
        const auto [x, y, z] = cloud.local;
        Vec3 center;
        for (size_t i = 0; i < 3; ++i) {
            center[i] = shipCenter_[i] + right_[i] * x + up_[i] * y + heading_[i] * z;
        }
        const double distance =
            std::hypot(center[0] - cameraPosition[0], center[1] - cameraPosition[1],
                       center[2] - cameraPosition[2]);
        // Fade in at the far end. Fade out as the cloud comes to the camera, so that the camera
        // goes through it smoothly.
        const double farFade = std::min(1.0, (kBoxHeading[1] - z) / kFarFade);
        const double nearFade =
            std::min(1.0, std::max(0.0, (distance - cloud.radius * 0.3) / cloud.radius));
        const double opacity = kCloudOpacity * farFade * nearFade * std::min(1.0, density * 1.5);
        if (opacity > 0.01) {
            visible.push_back({center, distance, &cloud, opacity});
        }
    }
    // From far to near. A stable sort keeps the order of equal distances, as JavaScript does.
    std::stable_sort(visible.begin(), visible.end(),
                     [](const Visible& a, const Visible& b) { return a.distance > b.distance; });
    for (size_t i = 0; i < visible.size(); ++i) {
        const Visible& entry = visible[i];
        const double values[kCloudFloats] = {entry.center[0],
                                             entry.center[1],
                                             entry.center[2],
                                             entry.cloud->radius,
                                             entry.cloud->seed,
                                             entry.opacity,
                                             0.0,
                                             0.0};
        for (size_t k = 0; k < kCloudFloats; ++k) {
            cloudData_[i * kCloudFloats + k] = static_cast<float>(values[k]);
        }
    }
    visibleCount_ = visible.size();
    if (visibleCount_ > 0) {
        WriteBuffer(device_, cloudBuffer_, 0, cloudData_.data(), visibleCount_ * kCloudFloats);
    }
    const uint32_t args[] = {6, static_cast<uint32_t>(visibleCount_), 0, 0, 0};
    WriteBuffer(device_, indirectBuffer_, 0, args, 5);

    std::copy(viewProjection.begin(), viewProjection.end(), uniformData_.begin());
    const double values[8] = {cameraPosition[0],
                              cameraPosition[1],
                              cameraPosition[2],
                              0.0,
                              flash,
                              flashPosition[0],
                              flashPosition[1],
                              aspect};
    for (size_t k = 0; k < 8; ++k) {
        uniformData_[16 + k] = static_cast<float>(values[k]);
    }
    WriteBuffer(device_, uniformBuffer_, 0, uniformData_.data(), uniformData_.size());
}

void Clouds::Draw(const wgpu::RenderPassEncoder& pass) const {
    if (visibleCount_ == 0) {
        return;
    }
    pass.SetPipeline(pipeline_);
    pass.SetBindGroup(0, bindGroup_);
    light_.Bind(pass);
    pass.SetIndexBuffer(indexBuffer_, wgpu::IndexFormat::Uint16);
    pass.DrawIndexedIndirect(indirectBuffer_, 0);
}

}  // namespace hackathon
