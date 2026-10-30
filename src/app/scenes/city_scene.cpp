// Scene: the ship flies over a dark brown land with reflective glass towers. The sky is the
// yellow-brown haze of the planet (as deep in the atmospheric entry), with the sun in front of the
// ship at the upper right of the screen. The camera is at the right side of the ship, and looks a
// little in front of it, so the ship is approximately one third from the left edge of the screen.
// The ship flies from left to right, so the land and the towers move from right to left.
// A lens flare shows when the sun is not behind the towers. Occlusion queries measure how much of
// the sun is visible (see lens_flare.h).

#include "app/buildings.h"
#include "app/lens_flare.h"
#include "app/scenes/scene.h"
#include "app/sky.h"

#include <cmath>

namespace hackathon {

namespace {

// The speed of the land and the towers past the ship, in meters per second.
constexpr double kSpeed = 350.0;
// The camera looks this many meters in front of the ship.
constexpr double kLookAhead = 60.0;
// The sun: in front of the ship, on the far side from the camera, and a little above the horizon.
// The ambient light has the same color.
constexpr Vec3 kSunColor = {1.2, 0.98, 0.66};
constexpr double kAmbientStrength = 0.175;
// Dark brown ground, with lower hills than the terrain scene, and no craters.
constexpr TerrainStyle kTerrainStyle = {
    .lowColor = {0.12, 0.08, 0.05},
    .highColor = {0.3, 0.2, 0.12},
    .heightScale = 0.3,
    .craterScale = 0,
};

// Forward along the heading, away from the camera (-right), and up.
Vec3 SunDirection(const Vec3& heading) {
    const Vec3 right = {-heading[2], 0.0, heading[0]};
    Vec3 toSun;
    for (size_t i = 0; i < 3; ++i) {
        toSun[i] = heading[i] * 0.55 - right[i] * 1.0 + (i == 1 ? 0.16 : 0.0);
    }
    const double length = std::hypot(toSun[0], toSun[1], toSun[2]);
    return {toSun[0] / length, toSun[1] / length, toSun[2] / length};
}

class CityScene : public Scene {
  public:
    explicit CityScene(const SharedObjects& shared)
        : Scene({.name = "City flyover",
                 .duration = 20,
                 .cameraAngle = -90.0,
                 .cameraLookAhead = kLookAhead,
                 .sun = SceneSun{.direction = SunDirection(shared.heading),
                                 .color = kSunColor,
                                 .ambient = {kSunColor[0] * kAmbientStrength,
                                             kSunColor[1] * kAmbientStrength,
                                             kSunColor[2] * kAmbientStrength}},
                 .terrainStyle = kTerrainStyle}),
          shared_(shared),
          sunDirection_(SunDirection(shared.heading)),
          sky_(shared.device, shared.format, shared.depthFormat, *shared.sun, shared.heading,
               {.nebula = false, .atmosphere = true, .sunDisk = true}),
          lensFlare_(shared.device, shared.format, shared.depthFormat),
          buildings_(shared.device, shared.format, shared.depthFormat, *shared.sun,
                     shared.shipCenter, shared.heading, *shared.ship) {}

    void Update(const FrameInfo& frame) override {
        scroll_ += kSpeed * frame.seconds;
        // The terrain samples its height field at worldPos, which moves along the heading.
        shared_.terrain->Update({shared_.heading[0] * scroll_, 0.0, shared_.heading[2] * scroll_});
        sky_.SetCamera(frame.viewProjection, frame.cameraPosition);
        const double aspect = static_cast<double>(frame.width) / frame.height;
        // Deep in the atmosphere, with no lightning, a level horizon, and no tilt.
        sky_.SetAtmosphere(1, 0, {0, 0}, 0.03, 0, aspect);
        buildings_.Update(frame.encoder, scroll_, frame.viewProjection, frame.cameraPosition,
                          frame.width, frame.height);
        lensFlare_.Update(frame.viewProjection, sunDirection_, kSunColor, aspect);
    }

    void Draw(const wgpu::RenderPassEncoder& pass) override {
        shared_.terrain->Draw(pass);
        buildings_.Draw(pass);
        // After the opaque objects, so that the depth test skips the sky behind them.
        sky_.Draw(pass);
    }

    wgpu::QuerySet OcclusionQuerySet() const override { return lensFlare_.QuerySet(); }

    void DrawOcclusionQueries(const wgpu::RenderPassEncoder& pass) override {
        lensFlare_.DrawProbes(pass);
    }

    void AfterMainPass(const wgpu::CommandEncoder& encoder,
                       const wgpu::TextureView& /*sceneView*/) override {
        lensFlare_.Resolve(encoder);
    }

    void DrawPost(const wgpu::RenderPassEncoder& pass,
                  const wgpu::TextureView& /*sceneView*/) override {
        lensFlare_.Draw(pass);
    }

  private:
    SharedObjects shared_;
    Vec3 sunDirection_;
    Sky sky_;
    LensFlare lensFlare_;
    Buildings buildings_;
    double scroll_ = 0.0;
};

}  // namespace

std::unique_ptr<Scene> CreateCityScene(const SharedObjects& shared) {
    return std::make_unique<CityScene>(shared);
}

}  // namespace hackathon
