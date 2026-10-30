// The fire and the smoke of the re-entry: a large fire around the ship, and smoke that the fire
// leaves behind it. The level (0 to 1) sets the strength of both. All world units are meters.
//
// The fire is one quad along the flow. It turns around its axis to face the camera. Its shader
// makes turbulent flames that start just in front of the nose, wrap around the front of the ship,
// and trail back, wider and wider. The flames are white and yellow in the hot middle and near the
// front, and orange at the ragged edges, where tongues of flame lick out. The ship hides the parts
// of the fire behind it, so the fire shows around the outline of the ship. The fire adds light
// (additive blending).
//
// The smoke is a set of soft sprites that the CPU makes behind the flame. Each puff moves back,
// grows, and fades. The CPU sorts the puffs from far to near, and they draw with premultiplied
// alpha blending before the flame.

#pragma once

#include "util/mat4.h"
#include "util/random.h"

#include <webgpu/webgpu_cpp.h>

#include <vector>

namespace hackathon {

class Reentry {
  public:
    Reentry(const wgpu::Device& device, wgpu::TextureFormat format,
            wgpu::TextureFormat depthFormat);

    // Advance the fire and the smoke by a time step in seconds. level (0 to 1) is the strength of
    // the fire and of the new smoke. shipCenter and heading are the center and the front direction
    // of the ship. time is in seconds, for the motion of the flame.
    void Update(double seconds, double time, double level, const Vec3& shipCenter,
                const Vec3& heading, const Mat4& viewProjection, const Vec3& cameraPosition);
    // Draw the smoke, and then the flame. Draw them after the ship, so that the ship hides the
    // parts behind it.
    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    struct Puff {
        Vec3 position;
        Vec3 velocity;
        double age;
        double seed;
    };

    wgpu::Device device_;
    Random random_;
    std::vector<Puff> puffs_;
    wgpu::Buffer flameUniforms_;
    wgpu::Buffer smokeUniforms_;
    wgpu::Buffer puffBuffer_;
    wgpu::RenderPipeline flamePipeline_;
    wgpu::RenderPipeline smokePipeline_;
    wgpu::BindGroup flameBindGroup_;
    wgpu::BindGroup smokeBindGroup_;
    std::vector<float> puffData_;
    size_t puffCount_ = 0;
    double level_ = 0.0;
    // The fraction of a puff that is due to start. A puff starts when it is 1 or more.
    double emission_ = 0.0;
};

}  // namespace hackathon
