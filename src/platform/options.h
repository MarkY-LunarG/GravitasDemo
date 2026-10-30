// The options of a run. They are the same on both targets: command-line arguments on the desktop,
// and the URL query in the browser (see OptionArguments() in platform.h).

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace hackathon {

struct Options {
    // The benchmark scene to start at, from 1. 0 starts with the intro.
    int scene = 0;
    // Advance the animation by this time in seconds each frame. 0 uses the real frame time.
    double fixedStep = 0.0;
    // Stop after this number of frames. 0 has no limit.
    uint64_t frames = 0;
    // Stop at the results page, with no click on Exit.
    bool exitOnFinish = false;
    // Write the output of these frames (from 1) to screenshot_<frame>.png. Desktop only.
    std::vector<uint64_t> screenshotFrames;
};

// Parse "--name=value" arguments. Returns false and writes an error for an unknown or incorrect
// argument.
bool ParseOptions(const std::vector<std::string>& arguments, Options& options, std::string& error);

}  // namespace hackathon
