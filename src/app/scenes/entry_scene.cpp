// Scene: the ship flies into the atmosphere of a yellow-brown planet. The camera does not move. It
// is at the right side of the ship, so the front of the ship points to the right of the screen.
//
// Timeline, in seconds from the start of the scene:
// - 0 to 25: the ship goes from space down into the atmosphere. The horizon comes up, and the haze
//   covers the stars.
// - 1 to 26: re-entry fire: flames around the front of the ship that trail back, and smoke. The
//   fire lights the ship. It is strongest from 6 to 16, and it goes out as the rain starts. The
//   ship shakes with the heat and in the rain.
// - From 10: clouds come past the ship. From 18: rain on the camera lens, which the air pushes
//   from the front of the ship to its back. From 20: lightning around the edges.
// From 26 seconds to the end at 33 seconds, the rain, the clouds, and the lightning continue.

#include "app/clouds.h"
#include "app/lightning.h"
#include "app/rain.h"
#include "app/reentry.h"
#include "app/scenes/scene.h"
#include "app/ship.h"
#include "app/sky.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>

namespace hackathon {

namespace {

double Smoothstep(double edge0, double edge1, double x) {
    const double t = std::min(std::max((x - edge0) / (edge1 - edge0), 0.0), 1.0);
    return t * t * (3 - 2 * t);
}

// The angle of the horizon below the horizontal, in space and deep in the atmosphere.
constexpr std::array<double, 2> kHorizonDip = {0.3, 0.03};
// The tilt of the horizon: it is higher in front of the ship (at the right of the screen) and
// lower behind it, so the ship seems to go down into the planet.
constexpr double kHorizonTilt = 14 * std::numbers::pi / 180;
// The size in meters and radians of the shake at full strength.
constexpr double kShakeOffset = 1.2;
constexpr double kShakeRoll = 0.03;
// The air pushes the drops on the lens straight toward the back of the ship. kRainFall is the size
// of a fall, relative to the push.
constexpr double kRainFall = 0.0;

class EntryScene : public Scene {
  public:
    explicit EntryScene(const SharedObjects& shared)
        : Scene({.name = "Atmospheric entry",
                 .duration = 33,
                 // The ship falls into the atmosphere with its engines off.
                 .engines = false,
                 .cameraAngle = -90.0}),
          shared_(shared),
          sky_(shared.device, shared.format, shared.depthFormat, *shared.sun, shared.heading,
               {.nebula = false, .atmosphere = true}),
          clouds_(shared.device, shared.format, shared.depthFormat, *shared.sun, shared.shipCenter,
                  shared.heading),
          rain_(shared.device, shared.format),
          lightning_(shared.device, shared.format, shared.depthFormat),
          reentry_(shared.device, shared.format, shared.depthFormat) {}

    void Update(const FrameInfo& frame) override {
        const double t = frame.sceneTime;
        const double depth = Smoothstep(0, 25, t);
        // The re-entry fire: it grows from 1 to 6, and it goes out from 16 to 26, as the rain
        // starts.
        const double heat = Smoothstep(1, 6, t) * (1 - Smoothstep(16, 26, t));
        const double cloudDensity = Smoothstep(10, 18, t);
        const double rainLevel = Smoothstep(18, 26, t);

        // The ship shakes with the heat, and less in the rain. Sums of sine waves at different
        // rates give a shake that does not repeat in a short pattern.
        const double shake = std::min(1.0, heat * 1.3 + rainLevel * 0.35);
        shared_.ship->SetHeat(heat);
        reentry_.Update(frame.seconds, t, heat, shared_.shipCenter, shared_.heading,
                        frame.viewProjection, frame.cameraPosition);
        shared_.moveShip(
            {(std::sin(t * 13.1) + 0.5 * std::sin(t * 31.7)) * kShakeOffset * shake,
             (std::sin(t * 17.3 + 1.0) + 0.5 * std::sin(t * 27.9)) * kShakeOffset * shake, 0.0},
            {.yaw = 0,
             .pitch = 0,
             .roll = (std::sin(t * 9.7) + 0.6 * std::sin(t * 23.3)) * kShakeRoll * shake});

        const double aspect = static_cast<double>(frame.width) / frame.height;
        lightning_.Update(t, t > 20, aspect);
        const double flash = lightning_.Brightness();
        const std::array<double, 2> flashPosition = lightning_.Position();
        sky_.SetCamera(frame.viewProjection, frame.cameraPosition);
        sky_.SetAtmosphere(depth, flash, flashPosition,
                           kHorizonDip[0] + (kHorizonDip[1] - kHorizonDip[0]) * depth, kHorizonTilt,
                           aspect);
        clouds_.Update(frame.seconds, cloudDensity, flash, flashPosition, aspect,
                       frame.viewProjection, frame.cameraPosition);
        // The screen direction to the back of the ship comes from two points on the ship axis.
        const Mat4& m = frame.viewProjection;
        auto project = [&](const Vec3& p) {
            const double w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
            return std::array<double, 2>{
                ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w) * frame.width,
                ((m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) * frame.height,
            };
        };
        const std::array<double, 2> front = project(shared_.shipCenter);
        Vec3 backPoint;
        for (size_t i = 0; i < 3; ++i) {
            backPoint[i] = shared_.shipCenter[i] - shared_.heading[i] * 50;
        }
        const std::array<double, 2> back = project(backPoint);
        const std::array<double, 2> toBack = {back[0] - front[0], back[1] - front[1]};
        double toBackLength = std::hypot(toBack[0], toBack[1]);
        if (toBackLength == 0.0) {
            toBackLength = 1.0;
        }
        rain_.Update(t, rainLevel, frame.width, frame.height,
                     {toBack[0] / toBackLength, toBack[1] / toBackLength - kRainFall});
    }

    void Draw(const wgpu::RenderPassEncoder& pass) override { sky_.Draw(pass); }

    // The ship can be in the clouds. The lightning is on the screen.
    void DrawAfterShip(const wgpu::RenderPassEncoder& pass) override {
        clouds_.Draw(pass);
        // The fire and its smoke glow through the clouds near the ship.
        reentry_.Draw(pass);
        lightning_.Draw(pass);
    }

    // The rain is on the camera lens: it bends the image of the scene.
    void DrawPost(const wgpu::RenderPassEncoder& pass,
                  const wgpu::TextureView& sceneView) override {
        rain_.Draw(pass, sceneView);
    }

  private:
    SharedObjects shared_;
    Sky sky_;
    Clouds clouds_;
    Rain rain_;
    Lightning lightning_;
    Reentry reentry_;
};

}  // namespace

std::unique_ptr<Scene> CreateEntryScene(const SharedObjects& shared) {
    return std::make_unique<EntryScene>(shared);
}

}  // namespace hackathon
