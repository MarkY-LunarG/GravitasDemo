// Number text that matches the TypeScript version.

#pragma once

#include <string>

namespace hackathon {

// The text of value with one decimal, as JavaScript Number.prototype.toFixed(1) gives it. At an
// exact tie (for example 0.25), toFixed() rounds up, but printf("%.1f") rounds to even.
std::string ToFixed1(double value);
// The same for two decimals, as toFixed(2).
std::string ToFixed2(double value);

}  // namespace hackathon
