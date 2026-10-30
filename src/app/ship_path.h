// A smooth path for the ship: a sum of sine waves on the right, up, and forward axes. The axes are
// the right, up, and heading directions of the ship start position, and the values are meters
// from that position.
//
// The path starts at the start position and eases in over rampTime seconds. The scene uses the
// path to place the ship, and the asteroid shader uses the same path (as WGSL) to keep the
// asteroids out of the way of the ship.

#pragma once

#include "util/mat4.h"

#include <string>
#include <vector>

namespace hackathon {

struct PathTerm {
    // 0 is right, 1 is up, and 2 is forward.
    int axis;
    double amplitude;
    // The period in seconds, and the phase in radians.
    double period;
    double phase;
};

class ShipPath {
  public:
    ShipPath(std::vector<PathTerm> terms, double rampTime)
        : terms_(std::move(terms)), rampTime_(rampTime) {}

    // The offset from the start position at a time in seconds from the start of the path.
    Vec3 Offset(double time) const;
    // The same function as Offset(), as the WGSL function shipPathOffset(time) -> vec3f.
    std::string Wgsl() const;

  private:
    // A smooth start: 0 at time 0, and 1 after rampTime. Each term also subtracts its value at
    // time 0, so that the path is at the start position at time 0.
    double Ramp(double time) const;

    std::vector<PathTerm> terms_;
    double rampTime_;
};

}  // namespace hackathon
