// A small random number generator with a fixed seed (mulberry32), so that each run of the benchmark
// is the same. It gives the same values as the mulberry32 functions of the TypeScript version:
// JavaScript does those operations on 32-bit integers, which wrap as uint32_t does.

#pragma once

#include <cstdint>

namespace hackathon {

class Random {
  public:
    explicit Random(uint32_t seed) : state_(seed) {}

    // A value in [0, 1).
    double Next() {
        state_ += 0x6d2b79f5u;
        uint32_t x = state_;
        x = (x ^ (x >> 15)) * (x | 1u);
        x ^= x + (x ^ (x >> 7)) * (x | 61u);
        return static_cast<double>(x ^ (x >> 14)) / 4294967296.0;
    }

    // A value in [low, high).
    double Between(double low, double high) { return low + (high - low) * Next(); }

  private:
    uint32_t state_;
};

}  // namespace hackathon
