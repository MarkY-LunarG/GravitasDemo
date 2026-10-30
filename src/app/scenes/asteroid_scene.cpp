// Scene: the ship flies through a field of asteroids, with no terrain. The background has stars,
// a nebula, and a ringed planet with two moons. The camera does not move, and the ship moves
// around the asteroids on a smooth path. It turns its nose along the path and banks into turns.

#include "app/asteroids.h"
#include "app/scenes/scene.h"
#include "app/ship_path.h"
#include "app/sky.h"

#include <algorithm>
#include <cmath>

namespace hackathon {

namespace {

// The ship path, in meters from the start position: wide turns to the right and left, smaller
// moves up and down, and a little forward and back. The camera is 250 m behind the start
// position, so the ship stays in the view.
const ShipPath& AsteroidShipPath() {
    static const ShipPath path(
        {
            {.axis = 0, .amplitude = 70, .period = 9, .phase = 0},
            {.axis = 0, .amplitude = 22, .period = 4.1, .phase = 1.0},
            {.axis = 1, .amplitude = 28, .period = 7, .phase = 0.5},
            {.axis = 1, .amplitude = 9, .period = 3.3, .phase = 2.0},
            {.axis = 2, .amplitude = 20, .period = 11, .phase = 0},
        },
        3);
    return path;
}

// The bank angle in radians for each m/s² of acceleration to the side, and its limit.
constexpr double kBankPerAcceleration = 0.03;
constexpr double kMaxBank = 0.7;

// The turn of the ship along its path. The asteroids move toward the camera at the flow speed, so
// the ship moves forward through them at the flow speed plus the forward speed of the path.
ShipTurn TurnAlongPath(double time, double speedScale) {
    const ShipPath& path = AsteroidShipPath();
    const double step = 1.0 / 60;
    const Vec3 before = path.Offset(time - step);
    const Vec3 now = path.Offset(time);
    const Vec3 after = path.Offset(time + step);
    Vec3 velocity;
    Vec3 acceleration;
    for (size_t i = 0; i < 3; ++i) {
        velocity[i] = (after[i] - before[i]) / (2 * step);
        acceleration[i] = (after[i] - 2 * now[i] + before[i]) / (step * step);
    }
    const double forward = kAsteroidFlowSpeed * speedScale + velocity[2];
    const double roll =
        std::max(-kMaxBank, std::min(kMaxBank, acceleration[0] * kBankPerAcceleration));
    return {
        .yaw = std::atan2(velocity[0], forward),
        .pitch = std::atan2(velocity[1], std::hypot(forward, velocity[0])),
        .roll = roll,
    };
}

class AsteroidScene : public Scene {
  public:
    explicit AsteroidScene(const SharedObjects& shared)
        : Scene({.name = "Asteroids and ship", .duration = 20, .cameraAngle = 0.0}),
          shared_(shared),
          asteroids_(shared.device, shared.format, shared.depthFormat, *shared.sun,
                     shared.shipCenter, shared.heading, AsteroidShipPath(), shared.cameraStart),
          // The planet is to the right of the view center and a little above it. The camera looks
          // 10 degrees down.
          sky_(shared.device, shared.format, shared.depthFormat, *shared.sun, shared.heading,
               {.nebula = true,
                .planet = PlanetOptions{
                    .rightDegrees = 17, .elevationDegrees = -2, .radiusDegrees = 6.5}}) {}

    void Update(const FrameInfo& frame) override {
        shared_.moveShip(AsteroidShipPath().Offset(frame.sceneTime),
                         TurnAlongPath(frame.sceneTime, frame.speedScale));
        asteroids_.SetCamera(frame.viewProjection, frame.cameraPosition);
        sky_.SetCamera(frame.viewProjection, frame.cameraPosition);
        asteroids_.Update(frame.encoder, frame.seconds, frame.speedScale, frame.sceneTime);
    }

    void Draw(const wgpu::RenderPassEncoder& pass) override {
        asteroids_.Draw(pass);
        // After the asteroids, so that the depth test skips the sky behind them.
        sky_.Draw(pass);
    }

  private:
    SharedObjects shared_;
    Asteroids asteroids_;
    Sky sky_;
};

}  // namespace

std::unique_ptr<Scene> CreateAsteroidScene(const SharedObjects& shared) {
    return std::make_unique<AsteroidScene>(shared);
}

}  // namespace hackathon
