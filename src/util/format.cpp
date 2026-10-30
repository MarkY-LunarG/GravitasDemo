#include "util/format.h"

#include <cmath>
#include <cstdio>

namespace hackathon {

namespace {

std::string ToFixed(double value, int digits) {
    const double scale = digits == 1 ? 10.0 : 100.0;
    const double scaled = value * scale;
    // At an exact tie, use the larger value, as toFixed() does.
    if (std::isfinite(scaled) && scaled - std::floor(scaled) == 0.5) {
        value = (std::floor(scaled) + 1.0) / scale;
    }
    char text[64];
    std::snprintf(text, sizeof(text), "%.*f", digits, value);
    return text;
}

}  // namespace

std::string ToFixed1(double value) { return ToFixed(value, 1); }

std::string ToFixed2(double value) { return ToFixed(value, 2); }

}  // namespace hackathon
