#include "app/asteroids.h"

#include "app/light.h"
#include "app/ship_path.h"
#include "shaders.h"
#include "util/gpu.h"
#include "util/random.h"
#include "util/shader_builder.h"

#include <cmath>
#include <cstring>
#include <map>
#include <numbers>
#include <utility>

namespace hackathon {

namespace {

constexpr uint32_t kAsteroidCount = 4000;
constexpr uint32_t kAsteroidShapes = 8;
// The icosphere subdivisions of each LOD: 4 gives 5120 triangles, and 2 gives 320 triangles.
constexpr std::array<int, 2> kLodSubdivisions = {4, 2};
// An asteroid uses LOD 0 when radius / distance is larger than this value. At 1920 x 1080 with a
// 45-degree vertical field of view, 0.02 is a radius of approximately 26 pixels.
constexpr double kLodThreshold = 0.02;
// The radius of an asteroid is between kAsteroidRadius[0] and kAsteroidRadius[1] meters.
// Small asteroids are much more common than large asteroids.
constexpr std::array<double, 2> kAsteroidRadius = {2.0, 60.0};
// The surface is at most this many times the radius from the center. The culling uses it.
constexpr double kBoundingScale = 1.5;

// The surface of each shape: Perlin noise with kShapeOctaves octaves, and kShapeCraters small
// craters. The values are relative to a radius of 1. kShapeStretch is the range of the random
// scale on each axis, so that the shapes are not round.
constexpr double kShapeNoiseFrequency = 1.5;
constexpr double kShapeNoiseAmplitude = 0.22;
constexpr uint32_t kShapeOctaves = 4;
constexpr uint32_t kShapeCraters = 14;
constexpr std::array<double, 2> kShapeCraterRadius = {0.08, 0.3};
constexpr std::array<double, 2> kShapeStretch = {0.65, 1.0};

// The asteroids move in a box around the ship. The box axes are the heading (toward the front of
// the ship), right, and up, and the values are meters from the ship center. An asteroid that
// leaves the box on one side comes back on the other side.
// More asteroids start near the center of the box than near its sides: the right and up positions
// are a random number to the power kBoxCenterBias, so that some asteroids are near the ship path.
// Each asteroid also has a random velocity of up to kVelocitySpread in each direction.
constexpr std::array<double, 2> kBoxHeading = {-400.0, 4000.0};
constexpr std::array<double, 2> kBoxRight = {-1500.0, 1500.0};
constexpr std::array<double, 2> kBoxUp = {-600.0, 600.0};
constexpr double kBoxCenterBias = 1.8;
constexpr double kVelocitySpread = 15.0;
constexpr std::array<double, 2> kSpinSpeed = {0.05, 0.6};
// No asteroid can go into two tubes along the heading:
// - The ship tube follows the ship path. An asteroid at a distance d in front of the ship comes to
//   the ship after d / (its closing speed) seconds, so it stays kShipClearance meters from the
//   position of the ship path at that time. Thus the ship flies near the asteroids, but it does
//   not hit them.
// - The camera tube is a straight tube through the camera, with a radius of kCameraClearance.
constexpr double kShipClearance = 50.0;
constexpr double kCameraClearance = 50.0;
// The speed in meters per second at which an asteroid in a tube moves out of it.
constexpr double kClearPushSpeed = 200.0;

constexpr uint32_t kRandomSeed = 20261029;
constexpr uint32_t kWorkgroupSize = 64;

constexpr uint32_t kLodCount = kLodSubdivisions.size();
constexpr uint32_t kDrawCount = kAsteroidShapes * kLodCount;
// Each indirect draw has 5 u32 values: indexCount, instanceCount, firstIndex, baseVertex, and
// firstInstance.
constexpr uint32_t kDrawArgsSize = 5;
// position + radius, velocity + shape, spinAxis + spinSpeed, orientation: 16 floats.
constexpr size_t kAsteroidFloats = 16;
// planes (6 vec4f), shipCenter, right, up, heading, cameraPosition (5 vec4f), and
// seconds, flowSpeed, pathTime, and 1 unused float.
constexpr size_t kUpdateParamsFloats = 48;

struct Icosphere {
    std::vector<Vec3> vertices;
    std::vector<uint32_t> indices;
};

Vec3 Normalize(const Vec3& v) {
    const double length = std::hypot(v[0], v[1], v[2]);
    return {v[0] / length, v[1] / length, v[2] / length};
}

// Make an icosphere: an icosahedron with each triangle divided into 4, subdivisions times.
// All vertices are on the unit sphere. The triangles are counterclockwise from the outside.
Icosphere MakeIcosphere(int subdivisions) {
    const double t = (1 + std::sqrt(5.0)) / 2;
    Icosphere sphere;
    for (const Vec3& v : std::initializer_list<Vec3>{{-1, t, 0},
                                                     {1, t, 0},
                                                     {-1, -t, 0},
                                                     {1, -t, 0},
                                                     {0, -1, t},
                                                     {0, 1, t},
                                                     {0, -1, -t},
                                                     {0, 1, -t},
                                                     {t, 0, -1},
                                                     {t, 0, 1},
                                                     {-t, 0, -1},
                                                     {-t, 0, 1}}) {
        sphere.vertices.push_back(Normalize(v));
    }
    std::vector<std::array<uint32_t, 3>> triangles = {
        {0, 11, 5},  {0, 5, 1},  {0, 1, 7},  {0, 7, 10}, {0, 10, 11}, {1, 5, 9}, {5, 11, 4},
        {11, 10, 2}, {10, 7, 6}, {7, 1, 8},  {3, 9, 4},  {3, 4, 2},   {3, 2, 6}, {3, 6, 8},
        {3, 8, 9},   {4, 9, 5},  {2, 4, 11}, {6, 2, 10}, {8, 6, 7},   {9, 8, 1},
    };
    for (int level = 0; level < subdivisions; ++level) {
        // The two triangles on each side of an edge use the same new vertex.
        std::map<std::pair<uint32_t, uint32_t>, uint32_t> midpoints;
        auto midpoint = [&](uint32_t a, uint32_t b) {
            const auto key = a < b ? std::make_pair(a, b) : std::make_pair(b, a);
            const auto found = midpoints.find(key);
            if (found != midpoints.end()) {
                return found->second;
            }
            const Vec3& pa = sphere.vertices[a];
            const Vec3& pb = sphere.vertices[b];
            sphere.vertices.push_back(Normalize({pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]}));
            const uint32_t index = static_cast<uint32_t>(sphere.vertices.size() - 1);
            midpoints.emplace(key, index);
            return index;
        };
        std::vector<std::array<uint32_t, 3>> next;
        for (const auto& [a, b, c] : triangles) {
            // The same order of new vertices as the TypeScript version.
            const uint32_t ab = midpoint(a, b);
            const uint32_t bc = midpoint(b, c);
            const uint32_t ca = midpoint(c, a);
            next.insert(next.end(), {{a, ab, ca}, {b, bc, ab}, {c, ca, bc}, {ab, bc, ca}});
        }
        triangles = std::move(next);
    }
    for (const auto& triangle : triangles) {
        sphere.indices.insert(sphere.indices.end(), triangle.begin(), triangle.end());
    }
    return sphere;
}

void AddCommonConstants(WgslConstants& constants) {
    constants.U32("WORKGROUP_SIZE", kWorkgroupSize).U32("COUNT", kAsteroidCount);
}

}  // namespace

Asteroids::Asteroids(const wgpu::Device& device, wgpu::TextureFormat format,
                     wgpu::TextureFormat depthFormat, const DirectionalLight& light,
                     const Vec3& shipCenter, const Vec3& heading, const ShipPath& shipPath,
                     const Vec3& cameraPosition)
    : device_(device),
      light_(light),
      shipCenter_(shipCenter),
      // right = heading x up, for a right-handed system with +Y up.
      right_({-heading[2], 0.0, heading[0]}),
      up_({0.0, 1.0, 0.0}),
      heading_(heading),
      updateParams_(kUpdateParamsFloats, 0.0f) {
    // The icosphere of each LOD. One index buffer has the indices of LOD 0, then of LOD 1.
    const std::array<Icosphere, 2> spheres = {MakeIcosphere(kLodSubdivisions[0]),
                                              MakeIcosphere(kLodSubdivisions[1])};
    const std::array<uint32_t, 2> vertexCounts = {
        static_cast<uint32_t>(spheres[0].vertices.size()),
        static_cast<uint32_t>(spheres[1].vertices.size())};
    const std::array<uint32_t, 2> indexCounts = {static_cast<uint32_t>(spheres[0].indices.size()),
                                                 static_cast<uint32_t>(spheres[1].indices.size())};
    std::vector<float> directions;
    std::vector<uint32_t> indices;
    for (const Icosphere& sphere : spheres) {
        for (const Vec3& v : sphere.vertices) {
            directions.insert(directions.end(), {static_cast<float>(v[0]), static_cast<float>(v[1]),
                                                 static_cast<float>(v[2]), 0.0f});
        }
        indices.insert(indices.end(), sphere.indices.begin(), sphere.indices.end());
    }
    indexBuffer_ = CreateBufferWithData(device, indices, wgpu::BufferUsage::Index);

    // The draw for shape s and LOD l is s * kLodCount + l. Its vertices start at baseVertex,
    // its indices start at firstIndex, and its visible list starts at draw * kAsteroidCount.
    drawArgsTemplate_.assign(kDrawCount * kDrawArgsSize, 0);
    const std::array<uint32_t, 2> lodVertexStart = {0, kAsteroidShapes * vertexCounts[0]};
    const std::array<uint32_t, 2> lodIndexStart = {0, indexCounts[0]};
    for (uint32_t shape = 0; shape < kAsteroidShapes; ++shape) {
        for (uint32_t lod = 0; lod < kLodCount; ++lod) {
            uint32_t* args = &drawArgsTemplate_[(shape * kLodCount + lod) * kDrawArgsSize];
            args[0] = indexCounts[lod];
            args[1] = 0;
            args[2] = lodIndexStart[lod];
            args[3] = lodVertexStart[lod] + shape * vertexCounts[lod];
            args[4] = 0;
        }
    }
    drawArgsBuffer_ = CreateBufferWithData(
        device, drawArgsTemplate_, wgpu::BufferUsage::Storage | wgpu::BufferUsage::Indirect);

    const uint64_t shapeVertexCount = kAsteroidShapes * (vertexCounts[0] + vertexCounts[1]);
    // Two vec4f for each vertex.
    const wgpu::Buffer shapeVertexBuffer =
        CreateBuffer(device, shapeVertexCount * 8 * sizeof(float), wgpu::BufferUsage::Storage);
    MakeShapes(CreateBufferWithData(device, directions, wgpu::BufferUsage::Storage),
               shapeVertexBuffer, vertexCounts);

    const wgpu::Buffer asteroidBuffer = CreateBufferWithData(
        device, MakeAsteroids(shipPath, cameraPosition), wgpu::BufferUsage::Storage);
    const wgpu::Buffer visibleBuffer =
        CreateBuffer(device, uint64_t{kDrawCount} * kAsteroidCount * sizeof(uint32_t),
                     wgpu::BufferUsage::Storage);

    // The update and cull pass.
    updateParamsBuffer_ = CreateBuffer(device, kUpdateParamsFloats * sizeof(float),
                                       wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    {
        WgslConstants constants;
        AddCommonConstants(constants);
        constants.U32("LODS", kLodCount)
            .F32("LOD_THRESHOLD", kLodThreshold)
            .F32("BOUNDING_SCALE", kBoundingScale)
            .Vec3f("BOX_MIN", {kBoxRight[0], kBoxUp[0], kBoxHeading[0]})
            .Vec3f("BOX_MAX", {kBoxRight[1], kBoxUp[1], kBoxHeading[1]})
            .F32("SHIP_CLEARANCE", kShipClearance)
            .F32("CAMERA_CLEARANCE", kCameraClearance)
            .F32("CLEAR_PUSH_SPEED", kClearPushSpeed)
            .U32("DRAW_ARGS_SIZE", kDrawArgsSize);
        const std::string code =
            JoinWgsl({shaders::kNoise, shaders::kAsteroidCommon, shipPath.Wgsl(), constants.Text(),
                      shaders::kAsteroidUpdate});
        const wgpu::ComputePipelineDescriptor descriptor = {
            .compute = {.module = CreateShaderModule(device, code, "asteroid update"),
                        .entryPoint = "cs_update"},
        };
        updatePipeline_ = device.CreateComputePipeline(&descriptor);
        const wgpu::BindGroupEntry entries[] = {
            {.binding = 0, .buffer = updateParamsBuffer_},
            {.binding = 1, .buffer = asteroidBuffer},
            {.binding = 2, .buffer = drawArgsBuffer_},
            {.binding = 3, .buffer = visibleBuffer},
        };
        const wgpu::BindGroupDescriptor bindGroupDescriptor = {
            .layout = updatePipeline_.GetBindGroupLayout(0), .entryCount = 4, .entries = entries};
        updateBindGroup_ = device.CreateBindGroup(&bindGroupDescriptor);
    }

    // The render pass. Each draw has its own bind group, because the start of its visible list is
    // different. firstInstance must be 0 in an indirect draw without the indirect-first-instance
    // feature, so the start of the list cannot come from firstInstance.
    viewProjectionBuffer_ = CreateBuffer(device, 16 * sizeof(float),
                                         wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    const wgpu::ShaderStage vertexStage = wgpu::ShaderStage::Vertex;
    auto storageEntry = [](uint32_t binding) {
        return wgpu::BindGroupLayoutEntry{
            .binding = binding,
            .visibility = wgpu::ShaderStage::Vertex,
            .buffer = {.type = wgpu::BufferBindingType::ReadOnlyStorage}};
    };
    const wgpu::BindGroupLayoutEntry layoutEntries[] = {
        UniformEntry(0, vertexStage), UniformEntry(1, vertexStage), storageEntry(2),
        storageEntry(3), storageEntry(4)};
    const wgpu::BindGroupLayoutDescriptor layoutDescriptor = {.entryCount = 5,
                                                              .entries = layoutEntries};
    const wgpu::BindGroupLayout renderLayout = device.CreateBindGroupLayout(&layoutDescriptor);
    for (uint32_t draw = 0; draw < kDrawCount; ++draw) {
        const std::vector<uint32_t> drawInfo = {draw * kAsteroidCount, 0, 0, 0};
        const wgpu::BindGroupEntry entries[] = {
            {.binding = 0, .buffer = viewProjectionBuffer_},
            {.binding = 1,
             .buffer = CreateBufferWithData(device, drawInfo, wgpu::BufferUsage::Uniform)},
            {.binding = 2, .buffer = asteroidBuffer},
            {.binding = 3, .buffer = visibleBuffer},
            {.binding = 4, .buffer = shapeVertexBuffer},
        };
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = renderLayout, .entryCount = 5, .entries = entries};
        renderBindGroups_.push_back(device.CreateBindGroup(&descriptor));
    }
    {
        WgslConstants constants;
        AddCommonConstants(constants);
        const std::string code =
            JoinWgsl({shaders::kLight, shaders::kNoise, shaders::kAsteroidCommon, constants.Text(),
                      shaders::kAsteroidRender});
        const wgpu::ShaderModule module = CreateShaderModule(device, code, "asteroid render");
        const wgpu::BindGroupLayout layouts[] = {renderLayout, light.BindGroupLayout()};
        const wgpu::PipelineLayoutDescriptor pipelineLayout = {.bindGroupLayoutCount = 2,
                                                               .bindGroupLayouts = layouts};
        const wgpu::ColorTargetState target = {.format = format};
        const wgpu::FragmentState fragment = {
            .module = module, .entryPoint = "fs_asteroid", .targetCount = 1, .targets = &target};
        const wgpu::DepthStencilState depthStencil = {.format = depthFormat,
                                                      .depthWriteEnabled = wgpu::OptionalBool::True,
                                                      .depthCompare = wgpu::CompareFunction::Less};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = device.CreatePipelineLayout(&pipelineLayout),
            .vertex = {.module = module, .entryPoint = "vs_asteroid"},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList,
                          .cullMode = wgpu::CullMode::Back},
            .depthStencil = &depthStencil,
            .fragment = &fragment,
        };
        renderPipeline_ = device.CreateRenderPipeline(&descriptor);
    }
}

void Asteroids::SetCamera(const Mat4& viewProjection, const Vec3& cameraPosition) {
    const std::array<Plane, 6> planes = FrustumPlanes(viewProjection);
    for (size_t i = 0; i < planes.size(); ++i) {
        for (size_t k = 0; k < 4; ++k) {
            updateParams_[i * 4 + k] = static_cast<float>(planes[i][k]);
        }
    }
    auto setVector = [this](size_t offset, const Vec3& v) {
        for (size_t k = 0; k < 3; ++k) {
            updateParams_[offset + k] = static_cast<float>(v[k]);
        }
        updateParams_[offset + 3] = 0.0f;
    };
    setVector(24, shipCenter_);
    setVector(28, right_);
    setVector(32, up_);
    setVector(36, heading_);
    setVector(40, cameraPosition);
    WriteBuffer(device_, viewProjectionBuffer_, 0, viewProjection.data(), viewProjection.size());
}

void Asteroids::Update(const wgpu::CommandEncoder& encoder, double seconds, double speedScale,
                       double pathTime) {
    updateParams_[44] = static_cast<float>(seconds);
    updateParams_[45] = static_cast<float>(kAsteroidFlowSpeed * speedScale);
    updateParams_[46] = static_cast<float>(pathTime);
    WriteBuffer(device_, updateParamsBuffer_, 0, updateParams_.data(), updateParams_.size());
    // Start each frame with no visible instances.
    WriteBuffer(device_, drawArgsBuffer_, 0, drawArgsTemplate_.data(), drawArgsTemplate_.size());
    const wgpu::ComputePassEncoder pass = encoder.BeginComputePass();
    pass.SetPipeline(updatePipeline_);
    pass.SetBindGroup(0, updateBindGroup_);
    pass.DispatchWorkgroups((kAsteroidCount + kWorkgroupSize - 1) / kWorkgroupSize);
    pass.End();
}

void Asteroids::Draw(const wgpu::RenderPassEncoder& pass) const {
    pass.SetPipeline(renderPipeline_);
    light_.Bind(pass);
    pass.SetIndexBuffer(indexBuffer_, wgpu::IndexFormat::Uint32);
    for (uint32_t draw = 0; draw < kDrawCount; ++draw) {
        pass.SetBindGroup(0, renderBindGroups_[draw]);
        pass.DrawIndexedIndirect(drawArgsBuffer_, draw * kDrawArgsSize * sizeof(uint32_t));
    }
}

// Run the shape shader once, to make the vertices of all shapes and LODs.
void Asteroids::MakeShapes(const wgpu::Buffer& directionBuffer,
                           const wgpu::Buffer& shapeVertexBuffer,
                           const std::array<uint32_t, 2>& vertexCounts) {
    WgslConstants constants;
    AddCommonConstants(constants);
    constants.U32("VERTEX_COUNT_0", vertexCounts[0])
        .U32("VERTEX_COUNT_1", vertexCounts[1])
        .U32("SHAPES", kAsteroidShapes)
        .F32("NOISE_FREQUENCY", kShapeNoiseFrequency)
        .F32("NOISE_AMPLITUDE", kShapeNoiseAmplitude)
        .U32("OCTAVES", kShapeOctaves)
        .U32("CRATERS", kShapeCraters)
        .F32("CRATER_RADIUS_MIN", kShapeCraterRadius[0])
        .F32("CRATER_RADIUS_MAX", kShapeCraterRadius[1])
        .F32("STRETCH_MIN", kShapeStretch[0])
        .F32("STRETCH_MAX", kShapeStretch[1]);
    const std::string code = JoinWgsl(
        {shaders::kNoise, shaders::kAsteroidCommon, constants.Text(), shaders::kAsteroidShape});
    const wgpu::ComputePipelineDescriptor descriptor = {
        .compute = {.module = CreateShaderModule(device_, code, "asteroid shapes"),
                    .entryPoint = "cs_shapes"},
    };
    const wgpu::ComputePipeline pipeline = device_.CreateComputePipeline(&descriptor);
    const wgpu::BindGroupEntry entries[] = {
        {.binding = 0, .buffer = directionBuffer},
        {.binding = 1, .buffer = shapeVertexBuffer},
    };
    const wgpu::BindGroupDescriptor bindGroupDescriptor = {
        .layout = pipeline.GetBindGroupLayout(0), .entryCount = 2, .entries = entries};
    const wgpu::BindGroup bindGroup = device_.CreateBindGroup(&bindGroupDescriptor);
    const wgpu::CommandEncoder encoder = device_.CreateCommandEncoder();
    const wgpu::ComputePassEncoder pass = encoder.BeginComputePass();
    pass.SetPipeline(pipeline);
    pass.SetBindGroup(0, bindGroup);
    const uint32_t invocations = kAsteroidShapes * (vertexCounts[0] + vertexCounts[1]);
    pass.DispatchWorkgroups((invocations + kWorkgroupSize - 1) / kWorkgroupSize);
    pass.End();
    const wgpu::CommandBuffer commands = encoder.Finish();
    device_.GetQueue().Submit(1, &commands);
}

// The start state of all asteroids, at random positions in the box and out of the two tubes.
std::vector<float> Asteroids::MakeAsteroids(const ShipPath& shipPath,
                                            const Vec3& cameraPosition) const {
    Random random(kRandomSeed);
    auto between = [&random](const std::array<double, 2>& range) {
        return random.Between(range[0], range[1]);
    };
    std::vector<float> data(kAsteroidCount * kAsteroidFloats, 0.0f);
    for (uint32_t i = 0; i < kAsteroidCount; ++i) {
        // The cube of a random number makes small radii much more common than large radii.
        const double radius = kAsteroidRadius[0] * std::pow(kAsteroidRadius[1] / kAsteroidRadius[0],
                                                            std::pow(random.Next(), 3));
        // The order of the random values is the order of the TypeScript version.
        auto centered = [&random](const std::array<double, 2>& range) {
            const double side = random.Next() < 0.5 ? range[0] : range[1];
            return side * std::pow(random.Next(), kBoxCenterBias);
        };
        double x = centered(kBoxRight);
        double y = centered(kBoxUp);
        const double z = between(kBoxHeading);
        Vec3 velocity;
        for (double& component : velocity) {
            component = (random.Next() * 2 - 1) * kVelocitySpread;
        }
        // The same tubes as in the update shader, at path time 0.
        const double alongHeading =
            velocity[0] * heading_[0] + velocity[1] * heading_[1] + velocity[2] * heading_[2];
        const double closingSpeed = kAsteroidFlowSpeed - alongHeading;
        const Vec3 pathPoint = shipPath.Offset(z / closingSpeed);
        Vec3 relative;
        for (size_t axis = 0; axis < 3; ++axis) {
            relative[axis] = cameraPosition[axis] - shipCenter_[axis];
        }
        const std::array<double, 2> camera = {
            relative[0] * right_[0] + relative[1] * right_[1] + relative[2] * right_[2],
            relative[0] * up_[0] + relative[1] * up_[1] + relative[2] * up_[2],
        };
        const std::array<std::array<double, 3>, 2> tubes = {{
            {pathPoint[0], pathPoint[1], kShipClearance},
            {camera[0], camera[1], kCameraClearance},
        }};
        for (const auto& [cx, cy, clearance] : tubes) {
            const double minimum = clearance + radius * kBoundingScale;
            const double distance = std::hypot(x - cx, y - cy);
            if (distance < minimum) {
                const double scale = minimum / std::max(distance, 1e-3);
                x = cx + (x - cx) * scale;
                y = cy + (y - cy) * scale;
            }
        }
        Vec3 position;
        for (size_t axis = 0; axis < 3; ++axis) {
            position[axis] =
                shipCenter_[axis] + right_[axis] * x + up_[axis] * y + heading_[axis] * z;
        }
        // A random unit vector for the spin axis.
        const double axisZ = random.Next() * 2 - 1;
        const double axisAngle = random.Next() * 2 * std::numbers::pi;
        const double axisR = std::sqrt(1 - axisZ * axisZ);
        // A random unit quaternion (Shoemake's method) for the start orientation.
        const double u1 = random.Next();
        const double u2 = random.Next();
        const double u3 = random.Next();
        const std::array<double, 4> orientation = {
            std::sqrt(1 - u1) * std::sin(2 * std::numbers::pi * u2),
            std::sqrt(1 - u1) * std::cos(2 * std::numbers::pi * u2),
            std::sqrt(u1) * std::sin(2 * std::numbers::pi * u3),
            std::sqrt(u1) * std::cos(2 * std::numbers::pi * u3),
        };
        float* asteroid = &data[i * kAsteroidFloats];
        for (size_t k = 0; k < 3; ++k) {
            asteroid[k] = static_cast<float>(position[k]);
            asteroid[4 + k] = static_cast<float>(velocity[k]);
        }
        asteroid[3] = static_cast<float>(radius);
        // The shape is a u32 in the same buffer.
        const uint32_t shape = static_cast<uint32_t>(std::floor(random.Next() * kAsteroidShapes));
        std::memcpy(&asteroid[7], &shape, sizeof(shape));
        asteroid[8] = static_cast<float>(axisR * std::cos(axisAngle));
        asteroid[9] = static_cast<float>(axisR * std::sin(axisAngle));
        asteroid[10] = static_cast<float>(axisZ);
        asteroid[11] = static_cast<float>(between(kSpinSpeed));
        for (size_t k = 0; k < 4; ++k) {
            asteroid[12 + k] = static_cast<float>(orientation[k]);
        }
    }
    return data;
}

}  // namespace hackathon
