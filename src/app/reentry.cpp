#include "app/reentry.h"

#include "shaders.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace hackathon {

namespace {

// The fire starts kFlameAhead meters in front of the ship center (the nose is approximately 27
// meters in front of the center), and it is kFlameLength meters long and up to kFlameWidth meters
// wide. Its front is round: the radius grows from 0 to kFireRadius over kFireFront meters. Then
// the radius grows by kFireGrowth for each meter. kFireRadius is approximately 13 meters more than
// the half height of the ship.
constexpr double kFlameAhead = 32.0;
constexpr double kFlameLength = 340.0;
constexpr double kFlameWidth = 220.0;
constexpr double kFlameBrightness = 1.2;
constexpr double kFireRadius = 38.0;
constexpr double kFireFront = 22.0;
constexpr double kFireGrowth = 0.17;
// The flame noise moves back at this speed, in flame lengths per second.
constexpr double kFlameFlow = 0.6;

// The smoke puffs. A puff starts kSmokeStart meters behind the ship center, with a random offset,
// and moves back at kSmokeSpeed. It lives kSmokeLife seconds, and its radius grows from
// kSmokeRadius[0] to kSmokeRadius[1]. At full level, kSmokeRate puffs start each second.
constexpr size_t kSmokeCount = 160;
constexpr double kSmokeRate = 40.0;
constexpr double kSmokeLife = 3.5;
constexpr std::array<double, 2> kSmokeStart = {70.0, 150.0};
constexpr double kSmokeSpeed = 140.0;
constexpr std::array<double, 2> kSmokeRadius = {22.0, 95.0};
constexpr double kSmokeOpacity = 0.6;
constexpr uint32_t kRandomSeed = 31337;

// The position (3 floats), radius, opacity, age, seed, and 1 unused float.
constexpr size_t kPuffFloats = 8;

// Premultiplied alpha blending for the smoke.
constexpr wgpu::BlendState kPremultipliedBlend = {
    .color = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::One,
              .dstFactor = wgpu::BlendFactor::OneMinusSrcAlpha},
    .alpha = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::Zero,
              .dstFactor = wgpu::BlendFactor::One},
};

template <size_t N>
void SetFloats(std::vector<float>& data, size_t offset, const std::array<double, N>& values) {
    for (size_t i = 0; i < N; ++i) {
        data[offset + i] = static_cast<float>(values[i]);
    }
}

}  // namespace

Reentry::Reentry(const wgpu::Device& device, wgpu::TextureFormat format,
                 wgpu::TextureFormat depthFormat)
    : device_(device), random_(kRandomSeed), puffData_(kSmokeCount * kPuffFloats, 0.0f) {
    const wgpu::DepthStencilState depthStencil = {.format = depthFormat,
                                                  .depthWriteEnabled = wgpu::OptionalBool::False,
                                                  .depthCompare = wgpu::CompareFunction::Less};
    auto makePipeline = [&](const std::string& code, const char* label, const char* vertexEntry,
                            const char* fragmentEntry, const wgpu::BlendState& blend) {
        const wgpu::ShaderModule module = CreateShaderModule(device, code, label);
        const wgpu::ColorTargetState target = {.format = format, .blend = &blend};
        const wgpu::FragmentState fragment = {
            .module = module, .entryPoint = fragmentEntry, .targetCount = 1, .targets = &target};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .vertex = {.module = module, .entryPoint = vertexEntry},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
            .depthStencil = &depthStencil,
            .fragment = &fragment,
        };
        return device.CreateRenderPipeline(&descriptor);
    };
    WgslConstants constants;
    constants.F32("FLAME_FLOW", kFlameFlow)
        .F32("FIRE_RADIUS", kFireRadius)
        .F32("FIRE_FRONT", kFireFront)
        .F32("FIRE_GROWTH", kFireGrowth)
        .F32("FLAME_BRIGHTNESS", kFlameBrightness);
    flamePipeline_ =
        makePipeline(JoinWgsl({shaders::kNoise, constants.Text(), shaders::kReentryFlame}),
                     "re-entry flame", "vs_flame", "fs_flame", kAdditiveBlend);
    smokePipeline_ = makePipeline(JoinWgsl({shaders::kNoise, shaders::kReentrySmoke}),
                                  "re-entry smoke", "vs_smoke", "fs_smoke", kPremultipliedBlend);

    // viewProjection (16 floats), camera (4), start (4), back (4), and params (4).
    flameUniforms_ =
        CreateBuffer(device, 32 * 4, wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    // viewProjection (16 floats) and camera (4).
    smokeUniforms_ =
        CreateBuffer(device, 20 * 4, wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    puffBuffer_ = CreateBuffer(device, puffData_.size() * sizeof(float),
                               wgpu::BufferUsage::Storage | wgpu::BufferUsage::CopyDst);
    {
        const wgpu::BindGroupEntry entry = {.binding = 0, .buffer = flameUniforms_};
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = flamePipeline_.GetBindGroupLayout(0), .entryCount = 1, .entries = &entry};
        flameBindGroup_ = device.CreateBindGroup(&descriptor);
    }
    {
        const wgpu::BindGroupEntry entries[] = {{.binding = 0, .buffer = smokeUniforms_},
                                                {.binding = 1, .buffer = puffBuffer_}};
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = smokePipeline_.GetBindGroupLayout(0), .entryCount = 2, .entries = entries};
        smokeBindGroup_ = device.CreateBindGroup(&descriptor);
    }
}

void Reentry::Update(double seconds, double time, double level, const Vec3& shipCenter,
                     const Vec3& heading, const Mat4& viewProjection, const Vec3& cameraPosition) {
    level_ = std::max(0.0, std::min(1.0, level));
    const Vec3 back = {-heading[0], -heading[1], -heading[2]};
    Vec3 start;
    for (size_t i = 0; i < 3; ++i) {
        start[i] = shipCenter[i] - back[i] * kFlameAhead;
    }
    std::vector<float> flameData(32, 0.0f);
    std::copy(viewProjection.begin(), viewProjection.end(), flameData.begin());
    SetFloats<4>(flameData, 16, {cameraPosition[0], cameraPosition[1], cameraPosition[2], 0.0});
    SetFloats<4>(flameData, 20, {start[0], start[1], start[2], kFlameLength});
    SetFloats<4>(flameData, 24, {back[0], back[1], back[2], kFlameWidth});
    SetFloats<4>(flameData, 28, {level_, time, 0.0, 0.0});
    WriteBuffer(device_, flameUniforms_, 0, flameData.data(), flameData.size());

    // Move the puffs, remove the old puffs, and start new puffs behind the flame.
    for (Puff& puff : puffs_) {
        puff.age += seconds / kSmokeLife;
        for (size_t i = 0; i < 3; ++i) {
            puff.position[i] += puff.velocity[i] * seconds;
        }
    }
    puffs_.erase(std::remove_if(puffs_.begin(), puffs_.end(),
                                [](const Puff& puff) { return puff.age >= 1.0; }),
                 puffs_.end());
    emission_ += kSmokeRate * level_ * seconds;
    const Vec3 right = {-heading[2], 0.0, heading[0]};
    while (emission_ >= 1.0 && puffs_.size() < kSmokeCount) {
        emission_ -= 1.0;
        // Do not change the order of the random values: it sets the contents of the scene, so a
        // different order gives a different benchmark.
        const double distance = kSmokeStart[0] + (kSmokeStart[1] - kSmokeStart[0]) * random_.Next();
        const double across = (random_.Next() * 2 - 1) * 25;
        const double up = (random_.Next() * 2 - 1) * 20;
        const Vec3 position = {
            shipCenter[0] + back[0] * distance + right[0] * across,
            shipCenter[1] + up,
            shipCenter[2] + back[2] * distance + right[2] * across,
        };
        auto spread = [this] { return (random_.Next() * 2 - 1) * 12; };
        Vec3 velocity;
        velocity[0] = back[0] * kSmokeSpeed + spread();
        velocity[1] = 6 + spread() * 0.5;
        velocity[2] = back[2] * kSmokeSpeed + spread();
        const double seed = random_.Next() * 100;
        puffs_.push_back({position, velocity, 0.0, seed});
    }
    emission_ = std::min(emission_, 1.0);

    // Sort from far to near, and write the puffs. A stable sort keeps the order of equal
    // distances, as JavaScript does.
    auto distance = [&cameraPosition](const Vec3& p) {
        return std::hypot(p[0] - cameraPosition[0], p[1] - cameraPosition[1],
                          p[2] - cameraPosition[2]);
    };
    std::vector<const Puff*> sorted;
    for (const Puff& puff : puffs_) {
        sorted.push_back(&puff);
    }
    std::stable_sort(sorted.begin(), sorted.end(), [&distance](const Puff* a, const Puff* b) {
        return distance(a->position) > distance(b->position);
    });
    for (size_t i = 0; i < sorted.size(); ++i) {
        const Puff& puff = *sorted[i];
        const double radius =
            kSmokeRadius[0] + (kSmokeRadius[1] - kSmokeRadius[0]) * std::sqrt(puff.age);
        // The puff comes in quickly and goes out slowly.
        const double opacity = kSmokeOpacity * std::min(1.0, puff.age * 8) * (1 - puff.age);
        SetFloats<8>(puffData_, i * kPuffFloats,
                     {puff.position[0], puff.position[1], puff.position[2], radius, opacity,
                      puff.age, puff.seed, 0.0});
    }
    puffCount_ = sorted.size();
    if (puffCount_ > 0) {
        WriteBuffer(device_, puffBuffer_, 0, puffData_.data(), puffCount_ * kPuffFloats);
    }
    std::vector<float> smokeData(20, 0.0f);
    std::copy(viewProjection.begin(), viewProjection.end(), smokeData.begin());
    SetFloats<4>(smokeData, 16, {cameraPosition[0], cameraPosition[1], cameraPosition[2], 0.0});
    WriteBuffer(device_, smokeUniforms_, 0, smokeData.data(), smokeData.size());
}

void Reentry::Draw(const wgpu::RenderPassEncoder& pass) const {
    if (puffCount_ > 0) {
        pass.SetPipeline(smokePipeline_);
        pass.SetBindGroup(0, smokeBindGroup_);
        pass.Draw(6, static_cast<uint32_t>(puffCount_));
    }
    if (level_ > 0.001) {
        pass.SetPipeline(flamePipeline_);
        pass.SetBindGroup(0, flameBindGroup_);
        pass.Draw(6);
    }
}

}  // namespace hackathon
