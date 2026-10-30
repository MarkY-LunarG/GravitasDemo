// One directional light (a light source at infinity) that all objects in the scene share.
// Each object adds shaders::kLight (light.wgsl) to its shader, adds BindGroupLayout() to its
// pipeline layout at kLightBindGroup, and calls Bind() before it draws.

#pragma once

#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

#include <array>

namespace hackathon {

// The bind group index that each pipeline layout uses for the light. light.wgsl uses the same
// number.
inline constexpr uint32_t kLightBindGroup = 1;

class DirectionalLight {
  public:
    DirectionalLight(const wgpu::Device& device, const Vec3& direction, const Vec3& color,
                     const Vec3& ambient);

    const wgpu::BindGroupLayout& BindGroupLayout() const { return bindGroupLayout_; }

    // The direction points from a surface toward the light. It does not have to be a unit vector.
    void SetDirection(const Vec3& direction);
    // Set the color of the light and of the ambient light.
    void SetColors(const Vec3& color, const Vec3& ambient);

    // Set the light bind group in a render pass or in a render bundle.
    void Bind(const wgpu::RenderPassEncoder& pass) const;
    void Bind(const wgpu::RenderBundleEncoder& bundle) const;

  private:
    void Write();

    wgpu::Device device_;
    wgpu::BindGroupLayout bindGroupLayout_;
    wgpu::Buffer uniformBuffer_;
    wgpu::BindGroup bindGroup_;
    // Each vec3f in the uniform struct has a 16-byte alignment: direction, color, and ambient.
    std::array<float, 12> values_ = {};
};

}  // namespace hackathon
