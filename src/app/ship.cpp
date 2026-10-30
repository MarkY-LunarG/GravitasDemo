#include "app/ship.h"

#include "app/light.h"
#include "shaders.h"
#include "util/gpu.h"
#include "util/random.h"
#include "util/shader_builder.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace hackathon {

namespace {

// The animation names and the flame root node name, from assets/lunarg-ship/README.md.
constexpr const char* kIgniteAnimation = "EnginesIgnite";
constexpr const char* kRunningAnimation = "EnginesRunning";
constexpr const char* kShutdownAnimation = "EnginesShutdown";
constexpr const char* kFlameRootNode = "EngineL_Flames";
// Each node with a name that ends with this text is the flame root of one engine. Its parent is
// the engine node.
constexpr std::string_view kFlameRootSuffix = "_Flames";

// The engine lights, from assets/lunarg-ship/viewer.html: an orange light 2.5 m behind each
// nozzle, in the coordinates of the engine node. The strength follows the flame size, so the light
// fades in when the engines ignite and fades out when they shut down.
// At kEngineLightReference meters the light has half of kEngineLightIntensity, and at
// kEngineLightRange meters it has none. The ship is approximately 50 m long, so a reference
// distance of 30 m keeps much of the light across the whole ship.
// The flicker is the product of two sine waves of kEngineLightFlickerRates (radians per second),
// so it does not repeat in a short regular pattern. kEngineLightFlicker is the amplitude.
constexpr uint32_t kEngineLightCount = 2;
constexpr Vec3 kEngineLightOffset = {0.0, 0.0, -2.5};
constexpr Vec3 kEngineLightColor = {1.0, 0.6, 0.25};
constexpr double kEngineLightIntensity = 3.0;
constexpr double kEngineLightReference = 30.0;
constexpr double kEngineLightRange = 50.0;
constexpr double kEngineLightFlicker = 0.3;
constexpr std::array<double, 2> kEngineLightFlickerRates = {37.0, 23.0};

// The glow sprite of each engine light. kGlowRadius is the half width of the quad in meters.
// The quad moves kGlowPull meters from the light toward the camera, so that it does not cut into
// the engine. The glow has the flicker and the fade of the light.
constexpr double kGlowRadius = 13.0;
constexpr double kGlowPull = 6.0;
constexpr double kGlowBrightness = 0.9;

// Re-entry heating. SetHeat() sets the level from 0 to 1. The hull surfaces that face forward
// glow, from orange to white. A heat shell, the hull moved kHeatShell meters out along its normals
// (more at the front, and stretched back by kHeatTrail), adds a glowing bow shock around the
// outline of the ship. The shell draws only its back faces, so the ship hides the shell, except at
// the outline. The glow is brightest near the hull and fades to 0 at the outer edge of the shell.
constexpr double kHeatShell = 1.5;
constexpr double kHeatShellFront = 5.0;
constexpr double kHeatTrail = 3.0;
constexpr double kHeatShellBrightness = 0.45;

// Plasma streaks of the re-entry. Each streak starts at a random point on the surface of a solid
// part of the ship (the hull, the pylon, or an engine), where the normal points forward or to the
// side by more than kStreakFront, and goes back along the flow. A streak is a ribbon that faces the
// camera and gets wider toward its end. Its brightness moves along it with noise, so the plasma
// seems to flow. The color goes from almost white at the ship, through pink and orange, to violet
// at the end. Streaks at the outline of the ship, as the camera sees it, are brightest. Streaks
// over the body have kStreakBodyBrightness of that brightness, so they do not hide the body.
constexpr const char* kHullNode = "Hull";
// The streaks are only an accent of the large flame of the scene: each streak shows only at random
// times.
constexpr uint32_t kStreakCount = 160;
// The light of the re-entry fire on the ship, at full heat: orange, strongest on the surfaces that
// face back into the flame, and it flickers.
constexpr Vec3 kFireLight = {1.0, 0.42, 0.12};
constexpr double kFireLightStrength = 1.3;
constexpr double kStreakFront = -0.05;
constexpr double kStreakBodyBrightness = 0.3;
constexpr std::array<double, 2> kStreakLength = {25.0, 75.0};
constexpr std::array<double, 2> kStreakWidth = {0.6, 2.2};
constexpr std::array<double, 2> kStreakSpeed = {2.0, 5.0};
constexpr double kStreakBrightness = 0.4;
constexpr uint32_t kStreakSeed = 9031;
// The local position (3 floats), local normal (3), and length, width, seed, and speed (4).
constexpr size_t kStreakFloats = 10;

// The engine lights (8 floats each), heat (4), camera (4), and viewProjection (16).
constexpr size_t kShipEffectsFloats = kEngineLightCount * 8 + 24;

// The flame colors are multiplied by this value. The viewer uses HDR colors and bloom to make
// the flames glow. This renderer has no HDR, so a smaller value keeps more of the color.
// This is the brightness during a boost. Outside a boost, see kBoostBaseLevel.
constexpr double kFlameBrightness = 1.5;

// The engine boost. SetBoost() turns the boost on and off. The boost works only while the engines
// run. Outside a boost, the flames, the engine lights, and the glow have kBoostBaseLevel of their
// full brightness. During a boost, they have full brightness, and the flames are kBoostFlameLength
// times longer. The boost level goes from 0 to 1 in kBoostRiseTime seconds, and from 1 to 0 in
// kBoostFallTime seconds, so the change is smooth.
constexpr double kBoostRiseTime = 0.4;
constexpr double kBoostFallTime = 1.2;
constexpr double kBoostBaseLevel = 0.5;
constexpr double kBoostFlameLength = 1.6;
// A mesh with a world scale smaller than this is not drawn. The flames have a scale of 0.0001
// when the engines are off.
constexpr double kMinDrawScale = 0.001;

// Morph target positions are offsets from the base positions. A primitive can have at most
// kMaxMorphTargets targets. Primitives with fewer targets use zero offsets.
constexpr size_t kMaxMorphTargets = 2;

// mvp (16 floats), model (16), baseColor (4), morphWeights (4).
constexpr size_t kDrawUniformFloats = 40;
// viewProjection (16 floats), cameraPosition (4), cameraRight (4), cameraUp (4).
constexpr size_t kGlowUniformFloats = 28;

void AddShipEffectsConstants(WgslConstants& constants) {
    constants.U32("ENGINE_LIGHT_COUNT", kEngineLightCount)
        .F32("ENGINE_LIGHT_INTENSITY", kEngineLightIntensity);
}

std::string MakeShader() {
    WgslConstants constants;
    AddShipEffectsConstants(constants);
    constants.F32("FLAME_BRIGHTNESS", kFlameBrightness)
        .F32("ENGINE_LIGHT_REFERENCE", kEngineLightReference)
        .F32("ENGINE_LIGHT_RANGE", kEngineLightRange)
        .Vec3f("FIRE_LIGHT", kFireLight)
        .F32("FIRE_LIGHT_STRENGTH", kFireLightStrength)
        .F32("HEAT_SHELL", kHeatShell)
        .F32("HEAT_SHELL_FRONT", kHeatShellFront)
        .F32("HEAT_TRAIL", kHeatTrail)
        .F32("HEAT_SHELL_BRIGHTNESS", kHeatShellBrightness)
        .F32("STREAK_BODY_BRIGHTNESS", kStreakBodyBrightness)
        .F32("STREAK_BRIGHTNESS", kStreakBrightness);
    return JoinWgsl({shaders::kLight, shaders::kNoise, shaders::kShipEffects, constants.Text(),
                     shaders::kShip});
}

std::string MakeGlowShader() {
    WgslConstants constants;
    AddShipEffectsConstants(constants);
    constants.F32("GLOW_RADIUS", kGlowRadius)
        .F32("GLOW_PULL", kGlowPull)
        .F32("GLOW_BRIGHTNESS", kGlowBrightness);
    return JoinWgsl({shaders::kShipEffects, constants.Text(), shaders::kShipGlow});
}

const GltfAnimation* FindAnimation(const GltfModel& model, const char* name, std::string& error) {
    for (const GltfAnimation& animation : model.animations) {
        if (animation.name == name) {
            return &animation;
        }
    }
    error = std::string("The ship model has no animation named ") + name;
    return nullptr;
}

int FindNode(const GltfModel& model, std::string_view name) {
    for (size_t i = 0; i < model.nodes.size(); ++i) {
        if (model.nodes[i].name == name) {
            return static_cast<int>(i);
        }
    }
    return -1;
}

std::vector<double>& PosePath(std::vector<double>& translation, std::vector<double>& rotation,
                              std::vector<double>& scale, std::vector<double>& weights,
                              GltfPath path) {
    switch (path) {
        case GltfPath::Translation:
            return translation;
        case GltfPath::Rotation:
            return rotation;
        case GltfPath::Scale:
            return scale;
        case GltfPath::Weights:
            break;
    }
    return weights;
}

template <typename T>
void Set(std::vector<float>& data, size_t offset, const T& values) {
    size_t i = offset;
    for (const auto value : values) {
        data[i++] = static_cast<float>(value);
    }
}

}  // namespace

std::unique_ptr<Ship> Ship::Create(const wgpu::Device& device, wgpu::TextureFormat format,
                                   wgpu::TextureFormat depthFormat, const DirectionalLight& light,
                                   GltfModel model, std::string& error) {
    std::unique_ptr<Ship> ship(new Ship(device, light, std::move(model)));
    if (!ship->Initialize(format, depthFormat, error)) {
        return nullptr;
    }
    return ship;
}

Ship::Ship(const wgpu::Device& device, const DirectionalLight& light, GltfModel model)
    : device_(device),
      light_(light),
      model_(std::move(model)),
      engineLightData_(kShipEffectsFloats, 0.0f),
      uniformData_(kDrawUniformFloats, 0.0f) {}

bool Ship::Initialize(wgpu::TextureFormat format, wgpu::TextureFormat depthFormat,
                      std::string& error) {
    ignite_ = FindAnimation(model_, kIgniteAnimation, error);
    running_ = FindAnimation(model_, kRunningAnimation, error);
    shutdown_ = FindAnimation(model_, kShutdownAnimation, error);
    if (!ignite_ || !running_ || !shutdown_) {
        return false;
    }
    flameRoot_ = FindNode(model_, kFlameRootNode);
    if (flameRoot_ < 0) {
        error = std::string("The ship model has no node named ") + kFlameRootNode;
        return false;
    }
    poses_.resize(model_.nodes.size());
    worldMatrices_.resize(model_.nodes.size(), Identity());

    for (size_t index = 0; index < model_.nodes.size(); ++index) {
        const std::string& name = model_.nodes[index].name;
        if (name.size() >= kFlameRootSuffix.size() &&
            name.compare(name.size() - kFlameRootSuffix.size(), kFlameRootSuffix.size(),
                         kFlameRootSuffix) == 0) {
            for (size_t parent = 0; parent < model_.nodes.size(); ++parent) {
                const std::vector<int>& children = model_.nodes[parent].children;
                if (std::find(children.begin(), children.end(), static_cast<int>(index)) !=
                    children.end()) {
                    engines_.push_back({static_cast<int>(index), static_cast<int>(parent)});
                    break;
                }
            }
        }
    }
    if (engines_.size() != kEngineLightCount) {
        error = "The ship model must have " + std::to_string(kEngineLightCount) +
                " engines with flame roots";
        return false;
    }
    engineLightBuffer_ = CreateBuffer(device_, engineLightData_.size() * sizeof(float),
                                      wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);

    const wgpu::ShaderStage vertexFragment =
        wgpu::ShaderStage::Vertex | wgpu::ShaderStage::Fragment;
    // The heat shell reads the effects in its vertex shader.
    const wgpu::BindGroupLayoutEntry drawEntries[] = {UniformEntry(0, vertexFragment),
                                                      UniformEntry(1, vertexFragment)};
    const wgpu::BindGroupLayoutDescriptor drawLayoutDescriptor = {.entryCount = 2,
                                                                  .entries = drawEntries};
    const wgpu::BindGroupLayout drawLayout = device_.CreateBindGroupLayout(&drawLayoutDescriptor);
    const wgpu::BindGroupLayout layouts[] = {drawLayout, light_.BindGroupLayout()};
    const wgpu::PipelineLayoutDescriptor pipelineLayoutDescriptor = {.bindGroupLayoutCount = 2,
                                                                     .bindGroupLayouts = layouts};
    const wgpu::PipelineLayout pipelineLayout =
        device_.CreatePipelineLayout(&pipelineLayoutDescriptor);
    const wgpu::ShaderModule shaderModule = CreateShaderModule(device_, MakeShader(), "ship");

    auto float3 = [](uint32_t location) {
        return wgpu::VertexAttribute{
            .format = wgpu::VertexFormat::Float32x3, .offset = 0, .shaderLocation = location};
    };
    const wgpu::VertexAttribute position = float3(0);
    const wgpu::VertexAttribute normal = float3(1);
    const wgpu::VertexBufferLayout litBuffers[] = {
        {.arrayStride = 12, .attributeCount = 1, .attributes = &position},
        {.arrayStride = 12, .attributeCount = 1, .attributes = &normal},
    };
    const wgpu::VertexAttribute color = {
        .format = wgpu::VertexFormat::Float32x4, .offset = 0, .shaderLocation = 1};
    const wgpu::VertexAttribute target0 = float3(2);
    const wgpu::VertexAttribute target1 = float3(3);
    const wgpu::VertexBufferLayout unlitBuffers[] = {
        {.arrayStride = 12, .attributeCount = 1, .attributes = &position},
        {.arrayStride = 16, .attributeCount = 1, .attributes = &color},
        {.arrayStride = 12, .attributeCount = 1, .attributes = &target0},
        {.arrayStride = 12, .attributeCount = 1, .attributes = &target1},
    };

    // The mirror images: the color target, the id target, and the depth of the mirror pass. The
    // mirror matrix turns the triangles the other way, so the pipeline draws both sides.
    const wgpu::BindGroupLayoutEntry mirrorEntries[] = {
        UniformEntry(0, vertexFragment),
        {.binding = 1,
         .visibility = vertexFragment,
         .buffer = {.type = wgpu::BufferBindingType::ReadOnlyStorage}},
    };
    const wgpu::BindGroupLayoutDescriptor mirrorLayoutDescriptor = {.entryCount = 2,
                                                                    .entries = mirrorEntries};
    mirrorBindGroupLayout_ = device_.CreateBindGroupLayout(&mirrorLayoutDescriptor);
    {
        const wgpu::BindGroupLayout mirrorLayouts[] = {drawLayout, light_.BindGroupLayout(),
                                                       mirrorBindGroupLayout_};
        const wgpu::PipelineLayoutDescriptor mirrorPipelineLayout = {
            .bindGroupLayoutCount = 3, .bindGroupLayouts = mirrorLayouts};
        const wgpu::ColorTargetState targets[] = {{.format = kMirrorColorFormat},
                                                  {.format = kMirrorIdFormat}};
        const wgpu::FragmentState fragment = {.module = shaderModule,
                                              .entryPoint = "fs_mirrored",
                                              .targetCount = 2,
                                              .targets = targets};
        const wgpu::DepthStencilState depthStencil = {.format = kMirrorDepthFormat,
                                                      .depthWriteEnabled = wgpu::OptionalBool::True,
                                                      .depthCompare = wgpu::CompareFunction::Less};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = device_.CreatePipelineLayout(&mirrorPipelineLayout),
            .vertex = {.module = shaderModule,
                       .entryPoint = "vs_mirrored",
                       .bufferCount = 2,
                       .buffers = litBuffers},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList,
                          .cullMode = wgpu::CullMode::None},
            .depthStencil = &depthStencil,
            .fragment = &fragment,
        };
        mirrorPipeline_ = device_.CreateRenderPipeline(&descriptor);
    }

    // The blended effects add light, and they do not write depth.
    const wgpu::DepthStencilState blendedDepth = {.format = depthFormat,
                                                  .depthWriteEnabled = wgpu::OptionalBool::False,
                                                  .depthCompare = wgpu::CompareFunction::Less};
    const wgpu::ColorTargetState additiveTarget = {.format = format, .blend = &kAdditiveBlend};

    // The glow sprites.
    {
        const wgpu::BindGroupLayoutEntry glowEntries[] = {
            UniformEntry(0, wgpu::ShaderStage::Vertex), UniformEntry(1, wgpu::ShaderStage::Vertex)};
        const wgpu::BindGroupLayoutDescriptor glowLayoutDescriptor = {.entryCount = 2,
                                                                      .entries = glowEntries};
        const wgpu::BindGroupLayout glowLayout =
            device_.CreateBindGroupLayout(&glowLayoutDescriptor);
        glowUniformBuffer_ = CreateBuffer(device_, kGlowUniformFloats * sizeof(float),
                                          wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
        const wgpu::BindGroupEntry entries[] = {{.binding = 0, .buffer = glowUniformBuffer_},
                                                {.binding = 1, .buffer = engineLightBuffer_}};
        const wgpu::BindGroupDescriptor bindGroupDescriptor = {
            .layout = glowLayout, .entryCount = 2, .entries = entries};
        glowBindGroup_ = device_.CreateBindGroup(&bindGroupDescriptor);
        const wgpu::ShaderModule glowModule =
            CreateShaderModule(device_, MakeGlowShader(), "ship glow");
        const wgpu::PipelineLayoutDescriptor glowPipelineLayout = {.bindGroupLayoutCount = 1,
                                                                   .bindGroupLayouts = &glowLayout};
        const wgpu::FragmentState fragment = {.module = glowModule,
                                              .entryPoint = "fs_glow",
                                              .targetCount = 1,
                                              .targets = &additiveTarget};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = device_.CreatePipelineLayout(&glowPipelineLayout),
            .vertex = {.module = glowModule, .entryPoint = "vs_glow"},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
            .depthStencil = &blendedDepth,
            .fragment = &fragment,
        };
        glowPipeline_ = device_.CreateRenderPipeline(&descriptor);
    }

    // The plasma streaks are instances: one start point and its parameters for each streak.
    {
        std::vector<float> streaks;
        if (!MakeStreaks(streaks, error)) {
            return false;
        }
        streakBuffer_ = CreateBufferWithData(device_, streaks, wgpu::BufferUsage::Vertex);
        const wgpu::VertexAttribute attributes[] = {
            {.format = wgpu::VertexFormat::Float32x3, .offset = 0, .shaderLocation = 0},
            {.format = wgpu::VertexFormat::Float32x3, .offset = 12, .shaderLocation = 1},
            {.format = wgpu::VertexFormat::Float32x4, .offset = 24, .shaderLocation = 2},
        };
        const wgpu::VertexBufferLayout buffer = {.stepMode = wgpu::VertexStepMode::Instance,
                                                 .arrayStride = kStreakFloats * sizeof(float),
                                                 .attributeCount = 3,
                                                 .attributes = attributes};
        const wgpu::FragmentState fragment = {.module = shaderModule,
                                              .entryPoint = "fs_streak",
                                              .targetCount = 1,
                                              .targets = &additiveTarget};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = pipelineLayout,
            .vertex = {.module = shaderModule,
                       .entryPoint = "vs_streak",
                       .bufferCount = 1,
                       .buffers = &buffer},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
            .depthStencil = &blendedDepth,
            .fragment = &fragment,
        };
        streakPipeline_ = device_.CreateRenderPipeline(&descriptor);
    }

    // The heat shell culls front faces, so that only its back faces draw, and the ship hides them
    // except at its outline.
    {
        const wgpu::FragmentState fragment = {.module = shaderModule,
                                              .entryPoint = "fs_heat",
                                              .targetCount = 1,
                                              .targets = &additiveTarget};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = pipelineLayout,
            .vertex = {.module = shaderModule,
                       .entryPoint = "vs_heat",
                       .bufferCount = 2,
                       .buffers = litBuffers},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList,
                          .cullMode = wgpu::CullMode::Front},
            .depthStencil = &blendedDepth,
            .fragment = &fragment,
        };
        heatPipeline_ = device_.CreateRenderPipeline(&descriptor);
    }

    // One pipeline for each combination of material properties that the model uses.
    auto pipelineFor = [&](const GltfMaterial& material) {
        const auto key = std::make_tuple(material.unlit, material.blend, material.doubleSided);
        auto found = pipelines_.find(key);
        if (found != pipelines_.end()) {
            return found->second;
        }
        // Additive blending: overlapping flame layers add their light.
        const wgpu::ColorTargetState target = {
            .format = format, .blend = material.blend ? &kAlphaAdditiveBlend : nullptr};
        const wgpu::FragmentState fragment = {.module = shaderModule,
                                              .entryPoint = material.unlit ? "fs_unlit" : "fs_lit",
                                              .targetCount = 1,
                                              .targets = &target};
        // Blended surfaces do not write depth, so they do not hide each other.
        const wgpu::DepthStencilState depthStencil = {
            .format = depthFormat,
            .depthWriteEnabled =
                material.blend ? wgpu::OptionalBool::False : wgpu::OptionalBool::True,
            .depthCompare = wgpu::CompareFunction::Less};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = pipelineLayout,
            .vertex = {.module = shaderModule,
                       .entryPoint = material.unlit ? "vs_unlit" : "vs_lit",
                       .bufferCount = material.unlit ? 4u : 2u,
                       .buffers = material.unlit ? unlitBuffers : litBuffers},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList,
                          .cullMode =
                              material.doubleSided ? wgpu::CullMode::None : wgpu::CullMode::Back},
            .depthStencil = &depthStencil,
            .fragment = &fragment,
        };
        wgpu::RenderPipeline pipeline = device_.CreateRenderPipeline(&descriptor);
        pipelines_.emplace(key, pipeline);
        return pipeline;
    };

    // The two engines use the same meshes, so make the GPU buffers once for each primitive.
    auto gpuPrimitiveFor = [&](const GltfPrimitive& primitive) -> const GpuPrimitive* {
        auto found = gpuPrimitives_.find(&primitive);
        if (found != gpuPrimitives_.end()) {
            return &found->second;
        }
        if (primitive.targets.size() > kMaxMorphTargets) {
            error = "The ship shader supports at most " + std::to_string(kMaxMorphTargets) +
                    " morph targets";
            return nullptr;
        }
        GpuPrimitive gpu;
        const wgpu::BufferUsage vertex = wgpu::BufferUsage::Vertex;
        if (model_.Material(primitive).unlit) {
            const size_t vertexCount = primitive.VertexCount();
            const std::vector<float> zeroOffsets(vertexCount * 3, 0.0f);
            const std::vector<float> white(vertexCount * 4, 1.0f);
            gpu.vertexBuffers = {
                CreateBufferWithData(device_, primitive.positions, vertex),
                CreateBufferWithData(device_, primitive.colors.empty() ? white : primitive.colors,
                                     vertex),
                CreateBufferWithData(
                    device_, primitive.targets.size() > 0 ? primitive.targets[0] : zeroOffsets,
                    vertex),
                CreateBufferWithData(
                    device_, primitive.targets.size() > 1 ? primitive.targets[1] : zeroOffsets,
                    vertex),
            };
        } else {
            gpu.vertexBuffers = {CreateBufferWithData(device_, primitive.positions, vertex),
                                 CreateBufferWithData(device_, primitive.normals, vertex)};
        }
        if (primitive.uses32BitIndices) {
            gpu.indexBuffer =
                CreateBufferWithData(device_, primitive.indices32, wgpu::BufferUsage::Index);
            gpu.indexFormat = wgpu::IndexFormat::Uint32;
        } else {
            gpu.indexBuffer =
                CreateBufferWithData(device_, primitive.indices16, wgpu::BufferUsage::Index);
            gpu.indexFormat = wgpu::IndexFormat::Uint16;
        }
        gpu.indexCount = static_cast<uint32_t>(primitive.IndexCount());
        return &gpuPrimitives_.emplace(&primitive, std::move(gpu)).first->second;
    };

    for (size_t nodeIndex = 0; nodeIndex < model_.nodes.size(); ++nodeIndex) {
        const GltfNode& node = model_.nodes[nodeIndex];
        if (node.mesh < 0) {
            continue;
        }
        for (const GltfPrimitive& primitive : model_.meshes[node.mesh].primitives) {
            const GltfMaterial& material = model_.Material(primitive);
            const GpuPrimitive* gpuPrimitive = gpuPrimitiveFor(primitive);
            if (!gpuPrimitive) {
                return false;
            }
            DrawItem item = {
                .node = static_cast<int>(nodeIndex),
                .primitive = &primitive,
                .material = &material,
                .gpuPrimitive = gpuPrimitive,
                .pipeline = pipelineFor(material),
                .uniformBuffer =
                    CreateBuffer(device_, kDrawUniformFloats * sizeof(float),
                                 wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst),
            };
            const wgpu::BindGroupEntry entries[] = {{.binding = 0, .buffer = item.uniformBuffer},
                                                    {.binding = 1, .buffer = engineLightBuffer_}};
            const wgpu::BindGroupDescriptor bindGroupDescriptor = {
                .layout = drawLayout, .entryCount = 2, .entries = entries};
            item.bindGroup = device_.CreateBindGroup(&bindGroupDescriptor);
            if (material.blend) {
                blendedItems_.push_back(std::move(item));
            } else {
                if (node.name == kHullNode && hullItem_ < 0) {
                    hullItem_ = static_cast<int>(opaqueItems_.size());
                }
                opaqueItems_.push_back(std::move(item));
            }
        }
    }

    // The placement is the identity here, so the world matrices are in model space.
    UpdatePose();
    std::vector<const DrawItem*> all;
    std::vector<const DrawItem*> solid;
    for (const DrawItem& item : opaqueItems_) {
        all.push_back(&item);
        solid.push_back(&item);
    }
    for (const DrawItem& item : blendedItems_) {
        all.push_back(&item);
    }
    const Bounds allBounds = ComputeBounds(all);
    center_ = {(allBounds.min[0] + allBounds.max[0]) / 2, (allBounds.min[1] + allBounds.max[1]) / 2,
               (allBounds.min[2] + allBounds.max[2]) / 2};
    const Bounds solidBounds = ComputeBounds(solid);
    height_ = solidBounds.max[1] - solidBounds.min[1];
    return true;
}

// The box around the items in model space, in the current pose.
Ship::Bounds Ship::ComputeBounds(const std::vector<const DrawItem*>& items) const {
    constexpr double infinity = std::numeric_limits<double>::infinity();
    Bounds bounds = {{infinity, infinity, infinity}, {-infinity, -infinity, -infinity}};
    for (const DrawItem* item : items) {
        const Vec3& low = item->primitive->min;
        const Vec3& high = item->primitive->max;
        for (int corner = 0; corner < 8; ++corner) {
            const Vec3 point =
                TransformPoint(worldMatrices_[item->node],
                               {corner & 1 ? high[0] : low[0], corner & 2 ? high[1] : low[1],
                                corner & 4 ? high[2] : low[2]});
            for (size_t axis = 0; axis < 3; ++axis) {
                bounds.min[axis] = std::min(bounds.min[axis], point[axis]);
                bounds.max[axis] = std::max(bounds.max[axis], point[axis]);
            }
        }
    }
    return bounds;
}

void Ship::SetPlacement(const Vec3& translation, const Quat& rotation) {
    placement_ = Compose(translation, rotation, {1.0, 1.0, 1.0});
    UpdateWorldMatrices();
}

void Ship::SetCamera(const Mat4& view, const Mat4& projection) {
    viewProjection_ = Multiply(projection, view);
    // The rows of the view rotation are the camera right, up, and back directions, and the
    // translation is -rotation * cameraPosition.
    const Vec3 t = {view[12], view[13], view[14]};
    Vec3 cameraPosition;
    for (size_t i = 0; i < 3; ++i) {
        cameraPosition[i] = -(view[i * 4] * t[0] + view[i * 4 + 1] * t[1] + view[i * 4 + 2] * t[2]);
    }
    std::vector<float> glowData(kGlowUniformFloats, 0.0f);
    Set(glowData, 0, viewProjection_);
    Set(glowData, 16,
        std::array<double, 4>{cameraPosition[0], cameraPosition[1], cameraPosition[2], 0.0});
    Set(glowData, 20, std::array<float, 4>{view[0], view[4], view[8], 0.0f});
    Set(glowData, 24, std::array<float, 4>{view[1], view[5], view[9], 0.0f});
    WriteBuffer(device_, glowUniformBuffer_, 0, glowData.data(), glowData.size());
    cameraPosition_ = cameraPosition;
}

void Ship::DrawItemGeometry(const wgpu::RenderPassEncoder& pass, const DrawItem& item,
                            uint32_t instanceCount) const {
    const GpuPrimitive& gpu = *item.gpuPrimitive;
    pass.SetBindGroup(0, item.bindGroup);
    for (size_t slot = 0; slot < gpu.vertexBuffers.size(); ++slot) {
        pass.SetVertexBuffer(static_cast<uint32_t>(slot), gpu.vertexBuffers[slot]);
    }
    pass.SetIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
    pass.DrawIndexed(gpu.indexCount, instanceCount);
}

void Ship::DrawMirrored(const wgpu::RenderPassEncoder& pass, const wgpu::BindGroup& mirrors,
                        uint32_t count) const {
    if (count == 0) {
        return;
    }
    pass.SetPipeline(mirrorPipeline_);
    light_.Bind(pass);
    pass.SetBindGroup(2, mirrors);
    for (const DrawItem& item : opaqueItems_) {
        if (!item.material->unlit) {
            DrawItemGeometry(pass, item, count);
        }
    }
}

void Ship::SetHeat(double level) { heat_ = std::max(0.0, std::min(1.0, level)); }

void Ship::SetEnginesOn(bool on) {
    if (on && engineState_ != EngineState::Running) {
        if (engineState_ == EngineState::Off) {
            igniteTime_ = 0.0;
            runningTime_ = 0.0;
        } else {
            igniteTime_ = TimeAtFlameSize(*ignite_, FlameSize());
        }
        engineState_ = EngineState::Running;
    } else if (!on && engineState_ == EngineState::Running) {
        shutdownTime_ = TimeAtFlameSize(*shutdown_, FlameSize());
        engineState_ = EngineState::ShuttingDown;
    }
}

void Ship::ResetEngines(bool on) {
    engineState_ = on ? EngineState::Running : EngineState::Off;
    igniteTime_ = ignite_->duration;
    runningTime_ = 0.0;
    UpdatePose();
}

void Ship::Update(double seconds) {
    clock_ += seconds;
    UpdateBoost(seconds);
    if (engineState_ == EngineState::Running) {
        igniteTime_ = std::min(igniteTime_ + seconds, ignite_->duration);
        runningTime_ = std::fmod(runningTime_ + seconds, running_->duration);
    } else if (engineState_ == EngineState::ShuttingDown) {
        shutdownTime_ += seconds;
        runningTime_ = std::fmod(runningTime_ + seconds, running_->duration);
        if (shutdownTime_ >= shutdown_->duration) {
            engineState_ = EngineState::Off;
        }
    }
    UpdatePose();
}

void Ship::Draw(const wgpu::RenderPassEncoder& pass) {
    WriteEngineLights();
    const double brightness = BoostBrightness();
    light_.Bind(pass);
    // Draw the blended flames after all opaque surfaces, so that the depth test hides the
    // parts of the flames that are behind the ship.
    for (const std::vector<DrawItem>* items : {&opaqueItems_, &blendedItems_}) {
        for (const DrawItem& item : *items) {
            const Mat4& world = worldMatrices_[item.node];
            if (std::hypot(static_cast<double>(world[0]), static_cast<double>(world[1]),
                           static_cast<double>(world[2])) < kMinDrawScale) {
                continue;
            }
            Set(uniformData_, 0, Multiply(viewProjection_, world));
            Set(uniformData_, 16, world);
            // The boost changes the brightness of the unlit flame materials.
            const std::array<double, 4>& baseColor = item.material->baseColor;
            const double scale = item.material->unlit ? brightness : 1.0;
            Set(uniformData_, 32,
                std::array<double, 4>{baseColor[0] * scale, baseColor[1] * scale,
                                      baseColor[2] * scale, baseColor[3]});
            const std::vector<double>& weights = poses_[item.node].weights;
            Set(uniformData_, 36,
                std::array<double, 4>{weights.size() > 0 ? weights[0] : 0.0,
                                      weights.size() > 1 ? weights[1] : 0.0, 0.0, 0.0});
            WriteBuffer(device_, item.uniformBuffer, 0, uniformData_.data(), uniformData_.size());

            pass.SetPipeline(item.pipeline);
            DrawItemGeometry(pass, item, 1);
        }
    }

    // The heat shell of each solid part. The uniforms of these parts are already set.
    if (heat_ > 0.001) {
        pass.SetPipeline(heatPipeline_);
        for (const DrawItem& item : opaqueItems_) {
            if (!item.material->unlit) {
                DrawItemGeometry(pass, item, 1);
            }
        }
    }

    // The plasma streaks of the re-entry.
    if (heat_ > 0.001 && hullItem_ >= 0) {
        pass.SetPipeline(streakPipeline_);
        pass.SetBindGroup(0, opaqueItems_[hullItem_].bindGroup);
        pass.SetVertexBuffer(0, streakBuffer_);
        pass.Draw(6, kStreakCount);
    }

    // The glow sprites go last, so that the depth test hides them behind all ship surfaces.
    // When the engines are off, the light color is 0, so the sprites add nothing.
    if (engineState_ != EngineState::Off) {
        pass.SetPipeline(glowPipeline_);
        pass.SetBindGroup(0, glowBindGroup_);
        pass.Draw(6, kEngineLightCount);
    }
}

// Put each engine light behind its nozzle, and set its color from the flame size and the flicker.
// Also write the heat, the ship front direction, and the camera.
void Ship::WriteEngineLights() {
    const auto [rateA, rateB] = kEngineLightFlickerRates;
    for (size_t i = 0; i < engines_.size(); ++i) {
        const Engine& engine = engines_[i];
        const Vec3 position = TransformPoint(worldMatrices_[engine.engine], kEngineLightOffset);
        const double size = poses_[engine.flameRoot].scale[0];
        // The phase offsets make the two engines flicker differently.
        const double flicker =
            std::sin(clock_ * rateA + i * 2.1) * std::sin(clock_ * rateB + static_cast<double>(i));
        // The flicker is in [-1, 1], so the strength changes between (1 - 2 * kEngineLightFlicker)
        // and 1 times its full value.
        const double flickerScale = 1 - kEngineLightFlicker + kEngineLightFlicker * flicker;
        // The glow uses the light color, so the boost also changes the glow.
        const double strength =
            size < 0.01 ? 0.0 : kEngineLightIntensity * size * flickerScale * BoostBrightness();
        Set(engineLightData_, i * 8,
            std::array<double, 4>{position[0], position[1], position[2], 0.0});
        Set(engineLightData_, i * 8 + 4,
            std::array<double, 4>{kEngineLightColor[0] * strength, kEngineLightColor[1] * strength,
                                  kEngineLightColor[2] * strength, 0.0});
    }
    // The ship front is +Z of the model, rotated by the placement.
    const Vec3 forward = {placement_[8], placement_[9], placement_[10]};
    const double length = std::hypot(forward[0], forward[1], forward[2]);
    const size_t lightFloats = kEngineLightCount * 8;
    Set(engineLightData_, lightFloats,
        std::array<double, 4>{forward[0] / length, forward[1] / length, forward[2] / length,
                              heat_});
    Set(engineLightData_, lightFloats + 4,
        std::array<double, 4>{cameraPosition_[0], cameraPosition_[1], cameraPosition_[2], clock_});
    Set(engineLightData_, lightFloats + 8, viewProjection_);
    WriteBuffer(device_, engineLightBuffer_, 0, engineLightData_.data(), engineLightData_.size());
}

// The scale of the flame root node: 0 when the engines are off, and 1 when they are on.
double Ship::FlameSize() const { return poses_[flameRoot_].scale[0]; }

// The time in an animation where the flame root has a given scale.
double Ship::TimeAtFlameSize(const GltfAnimation& animation, double size) const {
    const GltfChannel* channel = nullptr;
    for (const GltfChannel& candidate : animation.channels) {
        if (candidate.node == flameRoot_ && candidate.path == GltfPath::Scale) {
            channel = &candidate;
            break;
        }
    }
    if (!channel) {
        return 0.0;
    }
    std::vector<double> value;
    double bestTime = 0.0;
    double bestError = std::numeric_limits<double>::infinity();
    constexpr int steps = 100;
    for (int step = 0; step <= steps; ++step) {
        const double time = (animation.duration * step) / steps;
        SampleChannel(*channel, time, value);
        const double error = std::abs(value[0] - size);
        if (error < bestError) {
            bestError = error;
            bestTime = time;
        }
    }
    return bestTime;
}

// The boost level moves toward its target at a limited rate, so that it does not jump, also when
// the engines shut down in the middle of a boost.
void Ship::UpdateBoost(double seconds) {
    const double target = boostOn_ && engineState_ == EngineState::Running ? 1.0 : 0.0;
    const double change =
        std::max(-seconds / kBoostFallTime, std::min(seconds / kBoostRiseTime, target - boost_));
    boost_ += change;
}

// The brightness of the flames, the engine lights, and the glow, as a fraction of full brightness.
double Ship::BoostBrightness() const { return kBoostBaseLevel + (1 - kBoostBaseLevel) * boost_; }

// The instance data of the plasma streaks: random points on the solid parts of the ship, where the
// normal points forward (+Z in the model) or to the side. The points are in the space of the hull
// node, because the streaks use the model matrix of the hull. A fixed seed gives the same streaks
// in each run.
bool Ship::MakeStreaks(std::vector<float>& data, std::string& error) const {
    const int hullIndex = FindNode(model_, kHullNode);
    if (hullIndex < 0 || model_.nodes[hullIndex].mesh < 0) {
        error = std::string("The ship model has no mesh in the node ") + kHullNode;
        return false;
    }
    // The rest transform of each node from the root of the scene.
    std::vector<int> parents(model_.nodes.size(), -1);
    for (size_t index = 0; index < model_.nodes.size(); ++index) {
        for (int child : model_.nodes[index].children) {
            parents[child] = static_cast<int>(index);
        }
    }
    auto restMatrix = [&](int index) {
        Mat4 matrix = Identity();
        bool first = true;
        // Multiply from the root down, so that each product is rounded to float in the same order.
        std::vector<int> chain;
        for (int node = index; node >= 0; node = parents[node]) {
            chain.push_back(node);
        }
        for (auto node = chain.rbegin(); node != chain.rend(); ++node) {
            const GltfNode& source = model_.nodes[*node];
            const Mat4 local = Compose(source.translation, source.rotation, source.scale);
            matrix = first ? local : Multiply(matrix, local);
            first = false;
        }
        return matrix;
    };
    const Mat4 hullInverse = Invert(restMatrix(hullIndex));

    // The candidate points: position and normal in the hull space.
    struct Point {
        Vec3 position;
        Vec3 normal;
    };
    std::vector<Point> points;
    for (size_t index = 0; index < model_.nodes.size(); ++index) {
        const GltfNode& node = model_.nodes[index];
        if (node.mesh < 0) {
            continue;
        }
        for (const GltfPrimitive& primitive : model_.meshes[node.mesh].primitives) {
            if (model_.Material(primitive).unlit) {
                continue;
            }
            const Mat4 matrix = Multiply(hullInverse, restMatrix(static_cast<int>(index)));
            for (size_t i = 0; i < primitive.VertexCount(); ++i) {
                const Vec3 normal = {primitive.normals[i * 3], primitive.normals[i * 3 + 1],
                                     primitive.normals[i * 3 + 2]};
                // The parts have no rotation, so the normal does not change.
                if (normal[2] > kStreakFront) {
                    const Vec3 position = TransformPoint(
                        matrix, {primitive.positions[i * 3], primitive.positions[i * 3 + 1],
                                 primitive.positions[i * 3 + 2]});
                    points.push_back({position, normal});
                }
            }
        }
    }
    if (points.empty()) {
        error = "The ship model has no surface points for the plasma streaks";
        return false;
    }

    Random random(kStreakSeed);
    data.assign(kStreakCount * kStreakFloats, 0.0f);
    for (size_t streak = 0; streak < kStreakCount; ++streak) {
        const Point& point = points[static_cast<size_t>(std::floor(random.Next() * points.size()))];
        Set(data, streak * kStreakFloats, point.position);
        Set(data, streak * kStreakFloats + 3, point.normal);
        // Do not change the order of the random values: it sets the contents of the scene, so a
        // different order gives a different benchmark.
        const double length = random.Between(kStreakLength[0], kStreakLength[1]);
        const double width = random.Between(kStreakWidth[0], kStreakWidth[1]);
        const double seed = random.Next() * 100;
        const double speed = random.Between(kStreakSpeed[0], kStreakSpeed[1]);
        Set(data, streak * kStreakFloats + 6, std::array<double, 4>{length, width, seed, speed});
    }
    return true;
}

// Start from the rest pose of each node, then apply the active animations.
void Ship::UpdatePose() {
    for (size_t index = 0; index < model_.nodes.size(); ++index) {
        const GltfNode& node = model_.nodes[index];
        NodePose& pose = poses_[index];
        pose.translation.assign(node.translation.begin(), node.translation.end());
        pose.rotation.assign(node.rotation.begin(), node.rotation.end());
        pose.scale.assign(node.scale.begin(), node.scale.end());
        pose.weights = node.weights;
    }
    if (engineState_ != EngineState::Off) {
        ApplyAnimation(*running_, runningTime_);
    }
    if (engineState_ == EngineState::Running) {
        ApplyAnimation(*ignite_, igniteTime_);
    } else if (engineState_ == EngineState::ShuttingDown) {
        ApplyAnimation(*shutdown_, shutdownTime_);
    }
    // The flames point along -Z of their root, so a larger Z scale makes them longer.
    const double length = 1 + (kBoostFlameLength - 1) * boost_;
    for (const Engine& engine : engines_) {
        poses_[engine.flameRoot].scale[2] *= length;
    }
    UpdateWorldMatrices();
}

void Ship::ApplyAnimation(const GltfAnimation& animation, double time) {
    for (const GltfChannel& channel : animation.channels) {
        NodePose& pose = poses_[channel.node];
        SampleChannel(
            channel, time,
            PosePath(pose.translation, pose.rotation, pose.scale, pose.weights, channel.path));
    }
}

void Ship::Visit(int index, const Mat4& parent) {
    const NodePose& pose = poses_[index];
    const Mat4 local =
        Compose({pose.translation[0], pose.translation[1], pose.translation[2]},
                {pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]},
                {pose.scale[0], pose.scale[1], pose.scale[2]});
    worldMatrices_[index] = Multiply(parent, local);
    for (int child : model_.nodes[index].children) {
        Visit(child, worldMatrices_[index]);
    }
}

void Ship::UpdateWorldMatrices() {
    for (int root : model_.roots) {
        Visit(root, placement_);
    }
}

}  // namespace hackathon
