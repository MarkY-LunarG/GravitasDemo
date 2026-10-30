#include "app/light.h"

#include "util/gpu.h"

#include <cmath>

namespace hackathon {

namespace {

constexpr size_t kDirectionOffset = 0;
constexpr size_t kColorOffset = 4;
constexpr size_t kAmbientOffset = 8;

}  // namespace

DirectionalLight::DirectionalLight(const wgpu::Device& device, const Vec3& direction,
                                   const Vec3& color, const Vec3& ambient)
    : device_(device) {
    uniformBuffer_ = CreateBuffer(device, sizeof(values_),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    const wgpu::BindGroupLayoutEntry layoutEntry =
        UniformEntry(0, wgpu::ShaderStage::Vertex | wgpu::ShaderStage::Fragment);
    const wgpu::BindGroupLayoutDescriptor layoutDescriptor = {.entryCount = 1,
                                                              .entries = &layoutEntry};
    bindGroupLayout_ = device.CreateBindGroupLayout(&layoutDescriptor);
    const wgpu::BindGroupEntry entry = {.binding = 0, .buffer = uniformBuffer_};
    const wgpu::BindGroupDescriptor descriptor = {
        .layout = bindGroupLayout_, .entryCount = 1, .entries = &entry};
    bindGroup_ = device.CreateBindGroup(&descriptor);

    for (size_t i = 0; i < 3; ++i) {
        values_[kColorOffset + i] = static_cast<float>(color[i]);
        values_[kAmbientOffset + i] = static_cast<float>(ambient[i]);
    }
    SetDirection(direction);
}

void DirectionalLight::SetDirection(const Vec3& direction) {
    const double length = std::hypot(direction[0], direction[1], direction[2]);
    for (size_t i = 0; i < 3; ++i) {
        values_[kDirectionOffset + i] = static_cast<float>(direction[i] / length);
    }
    Write();
}

void DirectionalLight::SetColors(const Vec3& color, const Vec3& ambient) {
    for (size_t i = 0; i < 3; ++i) {
        values_[kColorOffset + i] = static_cast<float>(color[i]);
        values_[kAmbientOffset + i] = static_cast<float>(ambient[i]);
    }
    Write();
}

void DirectionalLight::Write() {
    WriteBuffer(device_, uniformBuffer_, 0, values_.data(), values_.size());
}

void DirectionalLight::Bind(const wgpu::RenderPassEncoder& pass) const {
    pass.SetBindGroup(kLightBindGroup, bindGroup_);
}

void DirectionalLight::Bind(const wgpu::RenderBundleEncoder& bundle) const {
    bundle.SetBindGroup(kLightBindGroup, bindGroup_);
}

}  // namespace hackathon
