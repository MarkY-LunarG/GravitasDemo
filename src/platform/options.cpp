#include "platform/options.h"

#include <charconv>
#include <cstdlib>
#include <string_view>
#include <system_error>

namespace hackathon {

namespace {

template <typename T>
bool ParseNumber(std::string_view text, T& value) {
    const char* end = text.data() + text.size();
    const auto result = std::from_chars(text.data(), end, value);
    return result.ec == std::errc() && result.ptr == end;
}

// Some libc++ versions of Emscripten have no std::from_chars for double.
template <>
bool ParseNumber(std::string_view text, double& value) {
    const std::string copy(text);
    char* end = nullptr;
    value = std::strtod(copy.c_str(), &end);
    return !copy.empty() && end == copy.c_str() + copy.size();
}

}  // namespace

bool ParseOptions(const std::vector<std::string>& arguments, Options& options, std::string& error) {
    for (const std::string& argument : arguments) {
        const size_t equals = argument.find('=');
        const std::string_view name = std::string_view(argument).substr(0, equals);
        const std::string_view value = equals == std::string::npos
                                           ? std::string_view()
                                           : std::string_view(argument).substr(equals + 1);

        bool valid = true;
        if (name == "--scene") {
            valid = ParseNumber(value, options.scene) && options.scene >= 0;
        } else if (name == "--fixed-step") {
            valid = ParseNumber(value, options.fixedStep) && options.fixedStep >= 0.0;
        } else if (name == "--frames") {
            valid = ParseNumber(value, options.frames);
        } else if (name == "--screenshot") {
            valid = ParseNumber(value, options.screenshotFrame) && options.screenshotFrame >= 1;
        } else if (name == "--exit-on-finish") {
            valid = value.empty();
            options.exitOnFinish = true;
        } else {
            error = "Unknown option: " + argument;
            return false;
        }
        if (!valid) {
            error = "Incorrect value: " + argument;
            return false;
        }
    }
    return true;
}

}  // namespace hackathon
