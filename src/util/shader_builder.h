// Make the WGSL code of a shader module from the embedded .wgsl files (generated/shaders.h).
//
// The C++ code defines each constant one time, and WgslConstants writes WGSL const declarations
// from them. The .wgsl files use the names. Code that is generated from data goes into a {{NAME}}
// placeholder.

#pragma once

#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

#include <cstdint>
#include <initializer_list>
#include <string>
#include <string_view>
#include <utility>

namespace hackathon {

// A WGSL float literal of a value. It always has a decimal point or an exponent, so it is a float
// also where WGSL has no type to convert it to.
std::string WgslFloat(double value);
// vec3f(x, y, z).
std::string WgslVec3(const Vec3& value);

// WGSL const declarations, for the start of a shader.
class WgslConstants {
  public:
    WgslConstants& U32(std::string_view name, uint32_t value);
    WgslConstants& F32(std::string_view name, double value);
    WgslConstants& Bool(std::string_view name, bool value);
    WgslConstants& Vec3f(std::string_view name, const Vec3& value);
    // A declaration with no type, as `const NAME = 0.55;`. A float value is then an abstract
    // float, as in a shader that has the number in its text.
    WgslConstants& Abstract(std::string_view name, double value);
    // A declaration of an abstract integer, as `const NAME = 5;`. WGSL converts it to the type that
    // each use needs, for example f32 or u32.
    WgslConstants& AbstractInt(std::string_view name, int64_t value);
    // A declaration with a type and a value that the caller writes, for example an array.
    WgslConstants& Raw(std::string_view name, std::string_view type, std::string_view value);

    const std::string& Text() const { return text_; }

  private:
    std::string text_;
};

// Put the parts one after the other, with a blank line between them.
std::string JoinWgsl(std::initializer_list<std::string_view> parts);

// Replace each {{NAME}} in text with its value. Aborts if text has a placeholder with no value, or
// a value has no placeholder, so that a missing part cannot go unnoticed.
std::string FillPlaceholders(
    std::string_view text,
    std::initializer_list<std::pair<std::string_view, std::string_view>> values);

wgpu::ShaderModule CreateShaderModule(const wgpu::Device& device, std::string_view code,
                                      std::string_view label);

}  // namespace hackathon
