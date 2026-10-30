// Clouds that move past the ship toward the camera. Each cloud is a soft sprite that faces the
// camera, with a noise shape. The clouds are blended over the scene, so the ship flies through
// them.
//
// Blended sprites must draw from far to near. The CPU sorts the clouds by distance in each frame
// and writes them to a storage buffer in that order. The draw is one instanced
// DrawIndexedIndirect call. The indirect buffer holds the instance count, which the cloud density
// sets. All world units are meters.

#pragma once

#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <vector>

namespace hackathon {

class DirectionalLight;

class Clouds {
  public:
    Clouds(const wgpu::Device& device, wgpu::TextureFormat format, wgpu::TextureFormat depthFormat,
           const DirectionalLight& light, const Vec3& shipCenter, const Vec3& heading);

    // Move the clouds by a time step in seconds, and write the visible clouds from far to near.
    // density (0 to 1) sets how many clouds there are. flash is the brightness of lightning, and
    // flashPosition is its position in clip space. aspect is the width of the view divided by its
    // height.
    void Update(double seconds, double density, double flash,
                const std::array<double, 2>& flashPosition, double aspect,
                const Mat4& viewProjection, const Vec3& cameraPosition);
    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    struct CloudState {
        // In box coordinates: right, up, and heading.
        Vec3 local;
        double radius;
        double seed;
    };

    wgpu::Device device_;
    const DirectionalLight& light_;
    Vec3 shipCenter_;
    Vec3 right_;
    Vec3 up_;
    Vec3 heading_;
    std::vector<CloudState> clouds_;
    wgpu::Buffer uniformBuffer_;
    wgpu::Buffer cloudBuffer_;
    wgpu::Buffer indexBuffer_;
    wgpu::Buffer indirectBuffer_;
    wgpu::BindGroup bindGroup_;
    wgpu::RenderPipeline pipeline_;
    std::vector<float> cloudData_;
    std::vector<float> uniformData_;
    size_t visibleCount_ = 0;
};

}  // namespace hackathon
