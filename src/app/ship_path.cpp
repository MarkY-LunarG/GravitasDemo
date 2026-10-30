#include "app/ship_path.h"

#include "util/shader_builder.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace hackathon {

Vec3 ShipPath::Offset(double time) const {
    Vec3 sum = {0.0, 0.0, 0.0};
    for (const PathTerm& term : terms_) {
        const double wave = std::sin((2 * std::numbers::pi * time) / term.period + term.phase) -
                            std::sin(term.phase);
        sum[term.axis] += term.amplitude * wave;
    }
    const double ramp = Ramp(time);
    return {sum[0] * ramp, sum[1] * ramp, sum[2] * ramp};
}

std::string ShipPath::Wgsl() const {
    std::string terms;
    for (const PathTerm& term : terms_) {
        terms += "  sum[" + std::to_string(term.axis) + "] += " + WgslFloat(term.amplitude) +
                 " * (sin(" + WgslFloat((2 * std::numbers::pi) / term.period) + " * time + " +
                 WgslFloat(term.phase) + ") - " + WgslFloat(std::sin(term.phase)) + ");\n";
    }
    return "fn shipPathOffset(time: f32) -> vec3f {\n"
           "  var sum = vec3f(0.0);\n" +
           terms + "  let ramp = smoothstep(0.0, " + WgslFloat(rampTime_) +
           ", max(time, 0.0));\n"
           "  return sum * ramp;\n"
           "}\n";
}

double ShipPath::Ramp(double time) const {
    const double x = std::min(std::max(time / rampTime_, 0.0), 1.0);
    return x * x * (3 - 2 * x);
}

}  // namespace hackathon
