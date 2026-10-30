#include "util/shader_builder.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>

namespace hackathon {

std::string WgslFloat(double value) {
    // 17 significant digits give the same double, and thus the same f32, as the TypeScript text.
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    std::string text = buffer;
    if (text.find_first_of(".e") == std::string::npos) {
        text += ".0";
    }
    return text;
}

std::string WgslVec3(const Vec3& value) {
    return "vec3f(" + WgslFloat(value[0]) + ", " + WgslFloat(value[1]) + ", " +
           WgslFloat(value[2]) + ")";
}

WgslConstants& WgslConstants::U32(std::string_view name, uint32_t value) {
    return Raw(name, "u32", std::to_string(value) + "u");
}

WgslConstants& WgslConstants::F32(std::string_view name, double value) {
    return Raw(name, "f32", WgslFloat(value));
}

WgslConstants& WgslConstants::Bool(std::string_view name, bool value) {
    return Raw(name, "bool", value ? "true" : "false");
}

WgslConstants& WgslConstants::Vec3f(std::string_view name, const Vec3& value) {
    return Raw(name, "vec3f", WgslVec3(value));
}

WgslConstants& WgslConstants::Abstract(std::string_view name, double value) {
    text_ += "const ";
    text_ += name;
    text_ += " = ";
    text_ += WgslFloat(value);
    text_ += ";\n";
    return *this;
}

WgslConstants& WgslConstants::Raw(std::string_view name, std::string_view type,
                                  std::string_view value) {
    text_ += "const ";
    text_ += name;
    text_ += ": ";
    text_ += type;
    text_ += " = ";
    text_ += value;
    text_ += ";\n";
    return *this;
}

std::string JoinWgsl(std::initializer_list<std::string_view> parts) {
    std::string text;
    for (std::string_view part : parts) {
        text += part;
        text += "\n";
    }
    return text;
}

std::string FillPlaceholders(
    std::string_view text,
    std::initializer_list<std::pair<std::string_view, std::string_view>> values) {
    std::string result;
    size_t used = 0;
    size_t position = 0;
    while (true) {
        const size_t start = text.find("{{", position);
        if (start == std::string_view::npos) {
            result += text.substr(position);
            break;
        }
        const size_t end = text.find("}}", start);
        if (end == std::string_view::npos) {
            std::fprintf(stderr, "Shader text has an unclosed {{\n");
            std::abort();
        }
        const std::string_view name = text.substr(start + 2, end - start - 2);
        const auto* value = std::find_if(values.begin(), values.end(),
                                         [name](const auto& pair) { return pair.first == name; });
        if (value == values.end()) {
            std::fprintf(stderr, "No value for the shader placeholder {{%.*s}}\n",
                         static_cast<int>(name.size()), name.data());
            std::abort();
        }
        result += text.substr(position, start - position);
        result += value->second;
        ++used;
        position = end + 2;
    }
    if (used < values.size()) {
        std::fprintf(stderr, "A shader placeholder value is not used\n");
        std::abort();
    }
    return result;
}

wgpu::ShaderModule CreateShaderModule(const wgpu::Device& device, std::string_view code,
                                      std::string_view label) {
    wgpu::ShaderSourceWGSL source;
    source.code = code;
    wgpu::ShaderModuleDescriptor descriptor;
    descriptor.nextInChain = &source;
    descriptor.label = label;
    return device.CreateShaderModule(&descriptor);
}

}  // namespace hackathon
