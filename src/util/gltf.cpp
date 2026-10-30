#include "util/gltf.h"

#define CGLTF_IMPLEMENTATION
#include <cgltf.h>

#include <algorithm>
#include <cmath>
#include <memory>

namespace hackathon {

namespace {

const GltfMaterial kDefaultMaterial = {.name = "default"};

struct CgltfDataDeleter {
    void operator()(cgltf_data* data) const { cgltf_free(data); }
};

std::string Name(const char* name) { return name ? name : ""; }

// Read a float accessor. cgltf removes the stride of the buffer view.
bool ReadFloats(const cgltf_accessor* accessor, std::vector<float>& output, std::string& error) {
    if (!accessor || !accessor->buffer_view || accessor->is_sparse) {
        error = "Sparse accessors and accessors without data are not supported";
        return false;
    }
    if (accessor->component_type != cgltf_component_type_r_32f) {
        error = "An accessor has no float data";
        return false;
    }
    output.resize(cgltf_accessor_unpack_floats(accessor, nullptr, 0));
    cgltf_accessor_unpack_floats(accessor, output.data(), output.size());
    return true;
}

bool ReadIndices(const cgltf_accessor* accessor, GltfPrimitive& primitive, std::string& error) {
    if (!accessor->buffer_view || accessor->is_sparse) {
        error = "Sparse index accessors are not supported";
        return false;
    }
    if (accessor->component_type == cgltf_component_type_r_16u) {
        primitive.indices16.resize(accessor->count);
        cgltf_accessor_unpack_indices(accessor, primitive.indices16.data(), sizeof(uint16_t),
                                      accessor->count);
        primitive.uses32BitIndices = false;
    } else if (accessor->component_type == cgltf_component_type_r_32u) {
        primitive.indices32.resize(accessor->count);
        cgltf_accessor_unpack_indices(accessor, primitive.indices32.data(), sizeof(uint32_t),
                                      accessor->count);
        primitive.uses32BitIndices = true;
    } else {
        error = "Indices must be 16-bit or 32-bit unsigned integers";
        return false;
    }
    return true;
}

bool ReadPrimitive(const cgltf_data* data, const cgltf_mesh& mesh, const cgltf_primitive& source,
                   GltfPrimitive& primitive, std::string& error) {
    const std::string where = "Mesh " + Name(mesh.name) + ": ";
    if (source.type != cgltf_primitive_type_triangles) {
        error = where + "only triangle lists are supported";
        return false;
    }
    const cgltf_accessor* positions = nullptr;
    const cgltf_accessor* normals = nullptr;
    const cgltf_accessor* colors = nullptr;
    for (size_t i = 0; i < source.attributes_count; ++i) {
        const cgltf_attribute& attribute = source.attributes[i];
        if (attribute.type == cgltf_attribute_type_position) {
            positions = attribute.data;
        } else if (attribute.type == cgltf_attribute_type_normal) {
            normals = attribute.data;
        } else if (attribute.type == cgltf_attribute_type_color && attribute.index == 0) {
            colors = attribute.data;
        }
    }
    if (!source.indices || !positions || !normals) {
        error = where + "primitives must have indices, positions, and normals";
        return false;
    }
    if (!ReadIndices(source.indices, primitive, error) ||
        !ReadFloats(positions, primitive.positions, error) ||
        !ReadFloats(normals, primitive.normals, error)) {
        error = where + error;
        return false;
    }
    if (colors) {
        // The colors go to the GPU as they are, so only RGBA float colors are supported.
        if (colors->type != cgltf_type_vec4 || !ReadFloats(colors, primitive.colors, error)) {
            error = where + "vertex colors must be RGBA floats";
            return false;
        }
    }
    for (size_t t = 0; t < source.targets_count; ++t) {
        const cgltf_morph_target& target = source.targets[t];
        const cgltf_accessor* targetPositions = nullptr;
        for (size_t i = 0; i < target.attributes_count; ++i) {
            if (target.attributes[i].type == cgltf_attribute_type_position) {
                targetPositions = target.attributes[i].data;
            }
        }
        primitive.targets.emplace_back();
        if (!ReadFloats(targetPositions, primitive.targets.back(), error)) {
            error = where + "morph target: " + error;
            return false;
        }
    }
    primitive.material =
        source.material ? static_cast<int>(cgltf_material_index(data, source.material)) : -1;
    if (positions->has_min) {
        primitive.min = {positions->min[0], positions->min[1], positions->min[2]};
    }
    if (positions->has_max) {
        primitive.max = {positions->max[0], positions->max[1], positions->max[2]};
    }
    return true;
}

void CopyKeyframe(const std::vector<float>& values, size_t keyframe, size_t size,
                  std::vector<double>& output) {
    for (size_t i = 0; i < size; ++i) {
        output[i] = values[keyframe * size + i];
    }
}

// Spherical linear interpolation between the quaternions at offsets a and b.
void Slerp(const std::vector<float>& values, size_t a, size_t b, double fraction,
           std::vector<double>& output) {
    double dot = 0.0;
    for (size_t i = 0; i < 4; ++i) {
        dot += static_cast<double>(values[a + i]) * values[b + i];
    }
    // Use the shorter path: q and -q are the same rotation.
    const double sign = dot < 0.0 ? -1.0 : 1.0;
    dot *= sign;
    double weightA = 1.0 - fraction;
    double weightB = fraction;
    // For nearly equal quaternions, linear interpolation is accurate and avoids a division by zero.
    if (dot < 0.9995) {
        const double angle = std::acos(dot);
        const double sinAngle = std::sin(angle);
        weightA = std::sin((1.0 - fraction) * angle) / sinAngle;
        weightB = std::sin(fraction * angle) / sinAngle;
    }
    double length = 0.0;
    for (size_t i = 0; i < 4; ++i) {
        output[i] = weightA * values[a + i] + weightB * sign * values[b + i];
        length += output[i] * output[i];
    }
    length = std::sqrt(length);
    for (size_t i = 0; i < 4; ++i) {
        output[i] /= length;
    }
}

}  // namespace

const GltfMaterial& GltfModel::Material(const GltfPrimitive& primitive) const {
    return primitive.material >= 0 ? materials[primitive.material] : kDefaultMaterial;
}

bool ParseGlb(const std::vector<uint8_t>& fileData, GltfModel& model, std::string& error) {
    cgltf_options options = {};
    options.type = cgltf_file_type_glb;
    cgltf_data* rawData = nullptr;
    if (cgltf_parse(&options, fileData.data(), fileData.size(), &rawData) != cgltf_result_success) {
        error = "The data is not a glTF 2.0 binary file";
        return false;
    }
    const std::unique_ptr<cgltf_data, CgltfDataDeleter> data(rawData);
    // A GLB file has its binary chunk in the data, so no file is read.
    if (cgltf_load_buffers(&options, data.get(), "") != cgltf_result_success) {
        error = "The glTF binary file has buffers that are not in the binary chunk";
        return false;
    }
    model = {};

    for (size_t m = 0; m < data->materials_count; ++m) {
        const cgltf_material& source = data->materials[m];
        GltfMaterial material;
        material.name = Name(source.name);
        if (source.has_pbr_metallic_roughness) {
            if (source.pbr_metallic_roughness.base_color_texture.texture) {
                error = "Material " + material.name + ": textures are not supported";
                return false;
            }
            const cgltf_float* color = source.pbr_metallic_roughness.base_color_factor;
            material.baseColor = {color[0], color[1], color[2], color[3]};
        }
        material.unlit = source.unlit != 0;
        material.blend = source.alpha_mode == cgltf_alpha_mode_blend;
        material.doubleSided = source.double_sided != 0;
        model.materials.push_back(material);
    }

    for (size_t m = 0; m < data->meshes_count; ++m) {
        const cgltf_mesh& source = data->meshes[m];
        GltfMesh mesh;
        mesh.name = Name(source.name);
        for (size_t p = 0; p < source.primitives_count; ++p) {
            mesh.primitives.emplace_back();
            if (!ReadPrimitive(data.get(), source, source.primitives[p], mesh.primitives.back(),
                               error)) {
                return false;
            }
        }
        if (source.weights_count > 0) {
            mesh.weights.assign(source.weights, source.weights + source.weights_count);
        } else {
            const size_t targetCount =
                mesh.primitives.empty() ? 0 : mesh.primitives[0].targets.size();
            mesh.weights.assign(targetCount, 0.0);
        }
        model.meshes.push_back(std::move(mesh));
    }

    for (size_t n = 0; n < data->nodes_count; ++n) {
        const cgltf_node& source = data->nodes[n];
        GltfNode node;
        node.name = Name(source.name);
        if (source.has_matrix || source.skin) {
            error = "Node " + node.name + ": matrix transforms and skins are not supported";
            return false;
        }
        node.mesh = source.mesh ? static_cast<int>(cgltf_mesh_index(data.get(), source.mesh)) : -1;
        for (size_t c = 0; c < source.children_count; ++c) {
            node.children.push_back(
                static_cast<int>(cgltf_node_index(data.get(), source.children[c])));
        }
        if (source.has_translation) {
            node.translation = {source.translation[0], source.translation[1],
                                source.translation[2]};
        }
        if (source.has_rotation) {
            node.rotation = {source.rotation[0], source.rotation[1], source.rotation[2],
                             source.rotation[3]};
        }
        if (source.has_scale) {
            node.scale = {source.scale[0], source.scale[1], source.scale[2]};
        }
        if (source.weights_count > 0) {
            node.weights.assign(source.weights, source.weights + source.weights_count);
        } else if (node.mesh >= 0) {
            node.weights = model.meshes[node.mesh].weights;
        }
        model.nodes.push_back(std::move(node));
    }

    for (size_t a = 0; a < data->animations_count; ++a) {
        const cgltf_animation& source = data->animations[a];
        GltfAnimation animation;
        animation.name = Name(source.name);
        for (size_t c = 0; c < source.channels_count; ++c) {
            const cgltf_animation_channel& channelSource = source.channels[c];
            const cgltf_animation_sampler& sampler = *channelSource.sampler;
            if (sampler.interpolation != cgltf_interpolation_type_linear) {
                error = "Animation " + animation.name + ": only LINEAR interpolation is supported";
                return false;
            }
            if (!channelSource.target_node) {
                error = "Animation " + animation.name + ": channels must have a target node";
                return false;
            }
            GltfChannel channel;
            channel.node =
                static_cast<int>(cgltf_node_index(data.get(), channelSource.target_node));
            switch (channelSource.target_path) {
                case cgltf_animation_path_type_translation:
                    channel.path = GltfPath::Translation;
                    break;
                case cgltf_animation_path_type_rotation:
                    channel.path = GltfPath::Rotation;
                    break;
                case cgltf_animation_path_type_scale:
                    channel.path = GltfPath::Scale;
                    break;
                case cgltf_animation_path_type_weights:
                    channel.path = GltfPath::Weights;
                    break;
                default:
                    error = "Animation " + animation.name + ": unknown channel path";
                    return false;
            }
            if (!ReadFloats(sampler.input, channel.times, error) ||
                !ReadFloats(sampler.output, channel.values, error) || channel.times.empty()) {
                error = "Animation " + animation.name + ": " + error;
                return false;
            }
            animation.duration = std::max<double>(animation.duration, channel.times.back());
            animation.channels.push_back(std::move(channel));
        }
        model.animations.push_back(std::move(animation));
    }

    const cgltf_scene* scene =
        data->scene ? data->scene : (data->scenes_count > 0 ? data->scenes : nullptr);
    if (!scene) {
        error = "The glTF file has no scene";
        return false;
    }
    for (size_t n = 0; n < scene->nodes_count; ++n) {
        model.roots.push_back(static_cast<int>(cgltf_node_index(data.get(), scene->nodes[n])));
    }
    return true;
}

void SampleChannel(const GltfChannel& channel, double time, std::vector<double>& output) {
    const std::vector<float>& times = channel.times;
    const std::vector<float>& values = channel.values;
    const size_t size = values.size() / times.size();
    if (output.size() < size) {
        output.resize(size, 0.0);
    }
    const size_t last = times.size() - 1;
    if (time <= times[0] || last == 0) {
        CopyKeyframe(values, 0, size, output);
        return;
    }
    if (time >= times[last]) {
        CopyKeyframe(values, last, size, output);
        return;
    }

    // Find the keyframe pair that contains the time.
    size_t low = 0;
    size_t high = last;
    while (high - low > 1) {
        const size_t middle = (low + high) / 2;
        if (times[middle] <= time) {
            low = middle;
        } else {
            high = middle;
        }
    }
    const double fraction = (time - times[low]) / (static_cast<double>(times[high]) - times[low]);

    if (channel.path == GltfPath::Rotation) {
        Slerp(values, low * 4, high * 4, fraction, output);
        return;
    }
    for (size_t i = 0; i < size; ++i) {
        const double a = values[low * size + i];
        output[i] = a + (values[high * size + i] - a) * fraction;
    }
}

}  // namespace hackathon
