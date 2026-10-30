// Scene: the ship flies above the terrain. The terrain features move toward the ship.
// kFlyOffTime seconds before the end, the ship boosts and flies away from the camera.
// The sky above the terrain is black with stars.

#include "app/scenes/scene.h"

#include "app/ship.h"
#include "app/sky.h"

namespace hackathon {

namespace {

// The speed at which the terrain features move toward the ship, in meters per second.
constexpr double kTerrainSpeed = 1200.0;
constexpr double kDuration = 20.0;
// The ship flies off with a constant acceleration in meters per second squared. In 3 seconds, it
// goes approximately 2.7 km, so it is very small before the fade to black.
constexpr double kFlyOffTime = 3.0;
constexpr double kFlyOffAcceleration = 600.0;

class TerrainScene : public Scene {
  public:
    explicit TerrainScene(const SharedObjects& shared)
        : Scene({.name = "Terrain and ship", .duration = kDuration}),
          shared_(shared),
          sky_(shared.device, shared.format, shared.depthFormat, *shared.sun, shared.heading,
               {.nebula = false}) {}

    void Update(const FrameInfo& frame) override {
        sky_.SetCamera(frame.viewProjection, frame.cameraPosition);
        // The terrain samples its height field at worldPos. worldPos moves along the heading, so
        // the terrain features come toward the ship, but the ship does not move until it flies
        // off.
        const double distance = kTerrainSpeed * frame.speedScale * frame.seconds;
        worldPos_[0] += shared_.heading[0] * distance;
        worldPos_[2] += shared_.heading[2] * distance;
        shared_.terrain->Update(worldPos_);

        const double flyTime = frame.sceneTime - (kDuration - kFlyOffTime);
        if (flyTime >= 0.0) {
            shared_.ship->SetBoost(true);
            shared_.moveShip({0.0, 0.0, 0.5 * kFlyOffAcceleration * flyTime * flyTime}, {});
        }
    }

    void Draw(const wgpu::RenderPassEncoder& pass) override {
        shared_.terrain->Draw(pass);
        // After the terrain, so that the depth test skips the sky behind the terrain.
        sky_.Draw(pass);
    }

  private:
    SharedObjects shared_;
    Sky sky_;
    Vec3 worldPos_ = {0.0, 0.0, 0.0};
};

}  // namespace

std::unique_ptr<Scene> CreateTerrainScene(const SharedObjects& shared) {
    return std::make_unique<TerrainScene>(shared);
}

}  // namespace hackathon
