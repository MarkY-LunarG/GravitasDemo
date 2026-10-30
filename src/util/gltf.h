// A loader for binary glTF 2.0 (.glb) files, and a sampler for glTF animations. cgltf
// (external/cgltf) parses the file. The loader keeps only the features that the models in this
// project use: float vertex attributes, 16-bit or 32-bit indices, morph targets, node TRS
// transforms, material base colors, KHR_materials_unlit, and LINEAR animation channels. It gives
// an error for other features, so that a model does not draw incorrectly without a message.
//
// The vertex data and the keyframes are float, and the transforms and the weights are double.

#pragma once

#include "util/mat4.h"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace hackathon {

struct GltfMaterial {
    std::string name;
    std::array<double, 4> baseColor = {1.0, 1.0, 1.0, 1.0};
    bool unlit = false;
    // True for alphaMode BLEND.
    bool blend = false;
    bool doubleSided = false;
};

struct GltfPrimitive {
    std::vector<float> positions;
    std::vector<float> normals;
    // RGBA vertex colors (COLOR_0). Empty if the primitive has no vertex colors.
    std::vector<float> colors;
    // The indices, with 16-bit or 32-bit values as in the file.
    std::vector<uint16_t> indices16;
    std::vector<uint32_t> indices32;
    bool uses32BitIndices = false;
    // The position offsets of each morph target.
    std::vector<std::vector<float>> targets;
    // An index into GltfModel::materials, or -1 for the default material.
    int material = -1;
    // The bounding box of the positions, from the accessor min and max.
    Vec3 min = {0.0, 0.0, 0.0};
    Vec3 max = {0.0, 0.0, 0.0};

    size_t VertexCount() const { return positions.size() / 3; }
    size_t IndexCount() const { return uses32BitIndices ? indices32.size() : indices16.size(); }
};

struct GltfMesh {
    std::string name;
    std::vector<GltfPrimitive> primitives;
    std::vector<double> weights;
};

struct GltfNode {
    std::string name;
    // An index into GltfModel::meshes, or -1 for no mesh.
    int mesh = -1;
    std::vector<int> children;
    Vec3 translation = {0.0, 0.0, 0.0};
    Quat rotation = {0.0, 0.0, 0.0, 1.0};
    Vec3 scale = {1.0, 1.0, 1.0};
    // The morph target weights of the node, or of its mesh if the node has none.
    std::vector<double> weights;
};

enum class GltfPath { Translation, Rotation, Scale, Weights };

struct GltfChannel {
    int node = 0;
    GltfPath path = GltfPath::Translation;
    std::vector<float> times;
    // For each keyframe: 3 values for translation and scale, 4 for rotation, and one value for
    // each morph target for weights.
    std::vector<float> values;
};

struct GltfAnimation {
    std::string name;
    double duration = 0.0;
    std::vector<GltfChannel> channels;
};

struct GltfModel {
    std::vector<GltfMaterial> materials;
    std::vector<GltfMesh> meshes;
    std::vector<GltfNode> nodes;
    // The root nodes of the default scene.
    std::vector<int> roots;
    std::vector<GltfAnimation> animations;

    // The material of a primitive. A primitive with no material has the default material.
    const GltfMaterial& Material(const GltfPrimitive& primitive) const;
};

// Parse the contents of a .glb file. Returns false and writes an error if the file is not a
// supported glTF 2.0 binary file.
bool ParseGlb(const std::vector<uint8_t>& data, GltfModel& model, std::string& error);

// Write the value of a channel at a time into output. Times before the first keyframe or after
// the last keyframe use the value of that keyframe. output grows if it is too small.
void SampleChannel(const GltfChannel& channel, double time, std::vector<double>& output);

}  // namespace hackathon
