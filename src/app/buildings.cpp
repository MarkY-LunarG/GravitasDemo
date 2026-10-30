#include "app/buildings.h"

#include "app/light.h"
#include "app/ship.h"
#include "shaders.h"
#include "util/gpu.h"
#include "util/random.h"
#include "util/shader_builder.h"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <string>

namespace hackathon {

namespace {

constexpr size_t kTowerCount = 64;
// The ship reflections: at most kMaxMirrors walls, which are less than kMirrorDistance meters from
// the ship.
constexpr size_t kMaxMirrors = 48;
constexpr double kMirrorDistance = 900.0;
// The towers are in a band along the heading: kAlong is the range in front of and behind the ship
// center, and kSide is the range to the right of the ship (negative values are at the far side of
// the ship from the camera). A tower that goes past the back of the band comes back at the front.
constexpr std::array<double, 2> kAlong = {-1400.0, 2600.0};
constexpr std::array<double, 2> kSide = {-1800.0, -120.0};
// The first kFrontCount towers are a row of tall glass towers on the far edge of the street, at
// equal intervals along the band. Their walls are near the ship, so they show its reflection.
constexpr size_t kFrontCount = 12;
constexpr std::array<double, 2> kFrontSide = {-320.0, -200.0};
constexpr std::array<double, 2> kFrontWidth = {120.0, 200.0};
constexpr std::array<double, 2> kFrontDepth = {60.0, 100.0};
constexpr std::array<double, 2> kFrontHeight = {540.0, 640.0};
// The heights and widths of the towers. The bottom of each tower is at kTowerBase, in the ground.
// Many towers are taller than the camera height (500 meters), so that their upper walls reflect
// the sky. Walls that the camera sees from above reflect the ground.
constexpr std::array<double, 2> kTowerHeight = {220.0, 760.0};
constexpr std::array<double, 2> kTowerWidth = {40.0, 120.0};
constexpr double kTowerBase = -150.0;
// Each tower turns from the heading by an angle in this range (degrees), to the left or the
// right. A wall that is parallel to the heading shows the ship reflection directly behind the
// ship, where the ship hides it. A turned wall shows the reflection farther along the street.
constexpr std::array<double, 2> kTowerTurn = {10.0, 28.0};
constexpr uint32_t kRandomSeed = 112233;

// The cube maps: their size in pixels, and their center relative to the ship center (right, up,
// and heading). The center is on a street with no towers, because a tower that moves through the
// center would hide all of the surroundings, and the reflections would go dark.
constexpr uint32_t kCubeSize = 256;
constexpr Vec3 kCubeCenter = {-500.0, -200.0, 0.0};
constexpr wgpu::TextureFormat kCubeFormat = wgpu::TextureFormat::RGBA8Unorm;
constexpr wgpu::TextureFormat kCubeDepthFormat = wgpu::TextureFormat::Depth24Plus;
// The sine of the angle of the horizon below the horizontal, for the background of the cube faces.
constexpr double kHorizonSin = 0.03;

// The center (3 floats) and reflectivity, the size (3) and the yaw, and the tint (4).
constexpr size_t kTowerFloats = 12;
// viewProjection (16 floats), position (4), right (4), up (4), and forward (4).
constexpr size_t kCameraFloats = 32;

// A unit box from -0.5 to 0.5, with the normal of each face: 4 vertices for each face, and
// triangles that are counterclockwise from the outside.
void MakeBox(std::vector<float>& vertices, std::vector<uint16_t>& indices) {
    const std::array<std::array<Vec3, 2>, 6> faces = {{
        {{{1, 0, 0}, {0, 1, 0}}},
        {{{-1, 0, 0}, {0, 1, 0}}},
        {{{0, 0, 1}, {0, 1, 0}}},
        {{{0, 0, -1}, {0, 1, 0}}},
        {{{0, 1, 0}, {0, 0, 1}}},
        {{{0, -1, 0}, {0, 0, 1}}},
    }};
    for (size_t face = 0; face < faces.size(); ++face) {
        const Vec3& n = faces[face][0];
        const Vec3& v = faces[face][1];
        // u = v x n, so u x v = n, and the corners in the order below are counterclockwise from
        // the outside.
        const Vec3 u = {v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2],
                        v[0] * n[1] - v[1] * n[0]};
        for (const auto& [a, b] :
             std::array<std::array<double, 2>, 4>{{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}}) {
            for (size_t i = 0; i < 3; ++i) {
                vertices.push_back(static_cast<float>((n[i] + u[i] * a + v[i] * b) * 0.5));
            }
            for (size_t i = 0; i < 3; ++i) {
                vertices.push_back(static_cast<float>(n[i]));
            }
        }
        const uint16_t first = static_cast<uint16_t>(face * 4);
        indices.insert(indices.end(),
                       {first, static_cast<uint16_t>(first + 1), static_cast<uint16_t>(first + 2),
                        first, static_cast<uint16_t>(first + 2), static_cast<uint16_t>(first + 3)});
    }
}

// The view directions of the 6 cube faces, in the order of the cube layers (+X, -X, +Y, -Y, +Z,
// -Z), with the world directions of the screen right and up of each face. These are the
// directions that the GPU uses to sample a cube map, so a face image is mirrored compared with a
// normal view.
struct CubeFace {
    Vec3 forward;
    Vec3 right;
    Vec3 up;
    const char* name;
};
constexpr std::array<CubeFace, 6> kCubeFaces = {{
    {{1, 0, 0}, {0, 0, -1}, {0, 1, 0}, "+X"},
    {{-1, 0, 0}, {0, 0, 1}, {0, 1, 0}, "-X"},
    {{0, 1, 0}, {1, 0, 0}, {0, 0, -1}, "+Y"},
    {{0, -1, 0}, {1, 0, 0}, {0, 0, 1}, "-Y"},
    {{0, 0, 1}, {1, 0, 0}, {0, 1, 0}, "+Z"},
    {{0, 0, -1}, {-1, 0, 0}, {0, 1, 0}, "-Z"},
}};

double Dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// The view matrix of a camera at eye with the given screen directions. The camera looks along
// forward, so the view-space -Z is forward.
Mat4 FaceView(const Vec3& eye, const Vec3& right, const Vec3& up, const Vec3& forward) {
    // clang-format off
    const std::array<double, 16> values = {
        right[0], up[0], -forward[0], 0,
        right[1], up[1], -forward[1], 0,
        right[2], up[2], -forward[2], 0,
        -Dot(right, eye), -Dot(up, eye), Dot(forward, eye), 1,
    };
    // clang-format on
    Mat4 view;
    for (size_t i = 0; i < 16; ++i) {
        view[i] = static_cast<float>(values[i]);
    }
    return view;
}

}  // namespace

Buildings::Buildings(const wgpu::Device& device, wgpu::TextureFormat format,
                     wgpu::TextureFormat depthFormat, const DirectionalLight& light,
                     const Vec3& shipCenter, const Vec3& heading, const Ship& ship)
    : device_(device),
      shipCenter_(shipCenter),
      heading_(heading),
      right_({-heading[2], 0.0, heading[0]}),
      towerData_(kTowerCount * kTowerFloats, 0.0f),
      ship_(ship),
      mirrorData_(kMaxMirrors * kMirrorFloats, 0.0f) {
    auto offset = [this](size_t i) {
        return right_[i] * kCubeCenter[0] + heading_[i] * kCubeCenter[2];
    };
    cubeCenter_ = {shipCenter[0] + offset(0), shipCenter[1] + kCubeCenter[1],
                   shipCenter[2] + offset(2)};

    Random random(kRandomSeed);
    auto between = [&random](const std::array<double, 2>& range) {
        return random.Between(range[0], range[1]);
    };
    // The yaw that puts the local x axis of a tower along the heading.
    const double headingYaw = std::atan2(-heading[2], heading[0]);
    // Do not change the order of the random values: it sets the contents of the scene, so a
    // different order gives a different benchmark.
    // A front tower is always glass, so it takes no random value for the glass.
    for (size_t i = 0; i < kTowerCount; ++i) {
        const bool front = i < kFrontCount;
        const bool glass = front || random.Next() < 0.6;
        const double interval = (kAlong[1] - kAlong[0]) / kFrontCount;
        const double along =
            front ? kAlong[0] + (i + 0.3 + 0.4 * random.Next()) * interval : between(kAlong);
        const double side = between(front ? kFrontSide : kSide);
        const double width = between(front ? kFrontWidth : kTowerWidth);
        const double depth = between(front ? kFrontDepth : kTowerWidth);
        TowerState tower;
        tower.along = along;
        tower.side = AwayFromStreet(side, width, depth);
        tower.width = width;
        tower.depth = depth;
        tower.height = between(front ? kFrontHeight : kTowerHeight);
        tower.reflectivity = front ? 0.85 + 0.1 * random.Next() : 0.6 + 0.35 * random.Next();
        const double turnSign = random.Next() < 0.5 ? -1.0 : 1.0;
        tower.yaw = headingYaw + turnSign * between(kTowerTurn) * (std::numbers::pi / 180);
        // Blue-gray glass, or bronze glass.
        tower.tint = glass ? Vec3{0.55, 0.65, 0.75} : Vec3{0.8, 0.62, 0.42};
        towers_.push_back(tower);
    }

    std::vector<float> boxVertices;
    std::vector<uint16_t> boxIndices;
    MakeBox(boxVertices, boxIndices);
    const wgpu::Buffer vertexBuffer =
        CreateBufferWithData(device, boxVertices, wgpu::BufferUsage::Vertex);
    const wgpu::Buffer indexBuffer =
        CreateBufferWithData(device, boxIndices, wgpu::BufferUsage::Index);
    towerBuffer_ = CreateBuffer(device, towerData_.size() * sizeof(float),
                                wgpu::BufferUsage::Storage | wgpu::BufferUsage::CopyDst);
    // indexCount, instanceCount, firstIndex, baseVertex, firstInstance.
    const std::vector<uint32_t> towerArgsData = {static_cast<uint32_t>(boxIndices.size()),
                                                 kTowerCount, 0, 0, 0};
    const wgpu::Buffer towerArgs =
        CreateBufferWithData(device, towerArgsData, wgpu::BufferUsage::Indirect);
    // vertexCount, instanceCount, firstVertex, firstInstance.
    const std::vector<uint32_t> backgroundArgsData = {3, 1, 0, 0};
    const wgpu::Buffer backgroundArgs =
        CreateBufferWithData(device, backgroundArgsData, wgpu::BufferUsage::Indirect);

    auto cameraBuffer = [&device] {
        return CreateBuffer(device, kCameraFloats * sizeof(float),
                            wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    };
    for (size_t face = 0; face < kCubeFaces.size(); ++face) {
        faceCameras_.push_back(cameraBuffer());
    }
    mainCamera_ = cameraBuffer();

    std::array<wgpu::TextureView, 2> cubeViews;
    for (size_t target = 0; target < 2; ++target) {
        const wgpu::TextureDescriptor descriptor = {
            .usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding,
            .size = {kCubeSize, kCubeSize, 6},
            .format = kCubeFormat,
        };
        const wgpu::Texture cube = device.CreateTexture(&descriptor);
        for (uint32_t layer = 0; layer < kCubeFaces.size(); ++layer) {
            const wgpu::TextureViewDescriptor viewDescriptor = {
                .dimension = wgpu::TextureViewDimension::e2D,
                .baseArrayLayer = layer,
                .arrayLayerCount = 1,
            };
            cubeFaceViews_[target].push_back(cube.CreateView(&viewDescriptor));
        }
        const wgpu::TextureViewDescriptor cubeDescriptor = {.dimension =
                                                                wgpu::TextureViewDimension::Cube};
        cubeViews[target] = cube.CreateView(&cubeDescriptor);
    }
    {
        const wgpu::TextureDescriptor descriptor = {
            .usage = wgpu::TextureUsage::RenderAttachment,
            .size = {kCubeSize, kCubeSize, 1},
            .format = kCubeDepthFormat,
        };
        cubeDepthView_ = device.CreateTexture(&descriptor).CreateView();
    }
    const wgpu::SamplerDescriptor samplerDescriptor = {.magFilter = wgpu::FilterMode::Linear,
                                                       .minFilter = wgpu::FilterMode::Linear};
    const wgpu::Sampler sampler = device.CreateSampler(&samplerDescriptor);

    // One bind group layout for all pipelines.
    const wgpu::BindGroupLayoutEntry layoutEntries[] = {
        UniformEntry(0, wgpu::ShaderStage::Vertex | wgpu::ShaderStage::Fragment),
        {.binding = 1,
         .visibility = wgpu::ShaderStage::Vertex,
         .buffer = {.type = wgpu::BufferBindingType::ReadOnlyStorage}},
        {.binding = 2,
         .visibility = wgpu::ShaderStage::Fragment,
         .texture = {.sampleType = wgpu::TextureSampleType::Float,
                     .viewDimension = wgpu::TextureViewDimension::Cube}},
        {.binding = 3,
         .visibility = wgpu::ShaderStage::Fragment,
         .sampler = {.type = wgpu::SamplerBindingType::Filtering}},
    };
    const wgpu::BindGroupLayoutDescriptor layoutDescriptor = {.entryCount = 4,
                                                              .entries = layoutEntries};
    const wgpu::BindGroupLayout layout = device.CreateBindGroupLayout(&layoutDescriptor);
    auto bindGroup = [&](const wgpu::Buffer& camera, const wgpu::TextureView& environment) {
        const wgpu::BindGroupEntry entries[] = {
            {.binding = 0, .buffer = camera},
            {.binding = 1, .buffer = towerBuffer_},
            {.binding = 2, .textureView = environment},
            {.binding = 3, .sampler = sampler},
        };
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = layout, .entryCount = 4, .entries = entries};
        return device.CreateBindGroup(&descriptor);
    };

    WgslConstants constants;
    constants.F32("HORIZON_SIN", kHorizonSin);
    const wgpu::ShaderModule module = CreateShaderModule(
        device, JoinWgsl({shaders::kLight, constants.Text(), shaders::kBuildings}), "buildings");
    const wgpu::BindGroupLayout layouts[] = {layout, light.BindGroupLayout()};
    const wgpu::PipelineLayoutDescriptor pipelineLayoutDescriptor = {.bindGroupLayoutCount = 2,
                                                                     .bindGroupLayouts = layouts};
    const wgpu::PipelineLayout pipelineLayout =
        device.CreatePipelineLayout(&pipelineLayoutDescriptor);
    const wgpu::VertexAttribute towerAttributes[] = {
        {.format = wgpu::VertexFormat::Float32x3, .offset = 0, .shaderLocation = 0},
        {.format = wgpu::VertexFormat::Float32x3, .offset = 12, .shaderLocation = 1},
    };
    const wgpu::VertexBufferLayout towerBuffers = {
        .arrayStride = 24, .attributeCount = 2, .attributes = towerAttributes};
    // The cube face views are mirrored, so the triangles turn the other way. The cube pipelines
    // draw both sides of the triangles.
    auto towerPipeline = [&](const wgpu::PipelineLayout& pipelineLayoutForTowers,
                             const char* fragmentEntry, wgpu::TextureFormat target,
                             wgpu::TextureFormat depth, wgpu::CullMode cullMode) {
        const wgpu::ColorTargetState colorTarget = {.format = target};
        const wgpu::FragmentState fragment = {.module = module,
                                              .entryPoint = fragmentEntry,
                                              .targetCount = 1,
                                              .targets = &colorTarget};
        const wgpu::DepthStencilState depthStencil = {.format = depth,
                                                      .depthWriteEnabled = wgpu::OptionalBool::True,
                                                      .depthCompare = wgpu::CompareFunction::Less};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = pipelineLayoutForTowers,
            .vertex = {.module = module,
                       .entryPoint = "vs_tower",
                       .bufferCount = 1,
                       .buffers = &towerBuffers},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList, .cullMode = cullMode},
            .depthStencil = &depthStencil,
            .fragment = &fragment,
        };
        return device.CreateRenderPipeline(&descriptor);
    };
    const wgpu::RenderPipeline cubeTowerPipeline = towerPipeline(
        pipelineLayout, "fs_tower", kCubeFormat, kCubeDepthFormat, wgpu::CullMode::None);
    // The main pipeline also reads the ship reflection images (group 2).
    const wgpu::BindGroupLayoutEntry reflectionEntries[] = {
        {.binding = 0,
         .visibility = wgpu::ShaderStage::Fragment,
         .texture = {.sampleType = wgpu::TextureSampleType::UnfilterableFloat,
                     .viewDimension = wgpu::TextureViewDimension::e2D}},
        {.binding = 1,
         .visibility = wgpu::ShaderStage::Fragment,
         .texture = {.sampleType = wgpu::TextureSampleType::Uint,
                     .viewDimension = wgpu::TextureViewDimension::e2D}},
    };
    const wgpu::BindGroupLayoutDescriptor reflectionLayoutDescriptor = {
        .entryCount = 2, .entries = reflectionEntries};
    reflectionLayout_ = device.CreateBindGroupLayout(&reflectionLayoutDescriptor);
    const wgpu::BindGroupLayout mainLayouts[] = {layout, light.BindGroupLayout(),
                                                 reflectionLayout_};
    const wgpu::PipelineLayoutDescriptor mainPipelineLayout = {.bindGroupLayoutCount = 3,
                                                               .bindGroupLayouts = mainLayouts};
    const wgpu::RenderPipeline mainTowerPipeline =
        towerPipeline(device.CreatePipelineLayout(&mainPipelineLayout), "fs_tower_main", format,
                      depthFormat, wgpu::CullMode::Back);

    // The ship reflections: the walls (mirrors), and the camera of the main view.
    mirrorBuffer_ = CreateBuffer(device, mirrorData_.size() * sizeof(float),
                                 wgpu::BufferUsage::Storage | wgpu::BufferUsage::CopyDst);
    mirrorViewBuffer_ = CreateBuffer(device, kMirrorViewFloats * sizeof(float),
                                     wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    {
        const wgpu::BindGroupEntry entries[] = {{.binding = 0, .buffer = mirrorViewBuffer_},
                                                {.binding = 1, .buffer = mirrorBuffer_}};
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = ship.MirrorBindGroupLayout(), .entryCount = 2, .entries = entries};
        mirrorBindGroup_ = device.CreateBindGroup(&descriptor);
    }
    wgpu::RenderPipeline backgroundPipeline;
    {
        const wgpu::ColorTargetState target = {.format = kCubeFormat};
        const wgpu::FragmentState fragment = {
            .module = module, .entryPoint = "fs_background", .targetCount = 1, .targets = &target};
        // The background is at the far plane, and it does not write depth.
        const wgpu::DepthStencilState depthStencil = {
            .format = kCubeDepthFormat,
            .depthWriteEnabled = wgpu::OptionalBool::False,
            .depthCompare = wgpu::CompareFunction::LessEqual};
        const wgpu::RenderPipelineDescriptor descriptor = {
            .layout = pipelineLayout,
            .vertex = {.module = module, .entryPoint = "vs_background"},
            .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
            .depthStencil = &depthStencil,
            .fragment = &fragment,
        };
        backgroundPipeline = device.CreateRenderPipeline(&descriptor);
    }

    // Record the draws of the towers in a bundle, with a debug group and a debug marker.
    auto drawTowers = [vertexBuffer, indexBuffer, towerArgs](
                          const wgpu::RenderBundleEncoder& encoder,
                          const wgpu::RenderPipeline& pipeline, const std::string& marker) {
        encoder.PushDebugGroup("Towers");
        encoder.InsertDebugMarker(marker.c_str());
        encoder.SetPipeline(pipeline);
        encoder.SetVertexBuffer(0, vertexBuffer);
        encoder.SetIndexBuffer(indexBuffer, wgpu::IndexFormat::Uint16);
        encoder.DrawIndexedIndirect(towerArgs, 0);
        encoder.PopDebugGroup();
    };

    // The cube faces: the background, then the towers. The towers in A reflect B, and the towers
    // in B reflect A.
    for (size_t target = 0; target < 2; ++target) {
        for (size_t index = 0; index < kCubeFaces.size(); ++index) {
            const wgpu::RenderBundleEncoderDescriptor descriptor = {
                .colorFormatCount = 1,
                .colorFormats = &kCubeFormat,
                .depthStencilFormat = kCubeDepthFormat,
            };
            const wgpu::RenderBundleEncoder encoder = device.CreateRenderBundleEncoder(&descriptor);
            const std::string group = std::string("Cube ") + (target == 0 ? "A" : "B") + " face " +
                                      kCubeFaces[index].name;
            encoder.PushDebugGroup(group.c_str());
            encoder.SetBindGroup(0, bindGroup(faceCameras_[index], cubeViews[1 - target]));
            light.Bind(encoder);
            encoder.PushDebugGroup("Background");
            encoder.SetPipeline(backgroundPipeline);
            encoder.DrawIndirect(backgroundArgs, 0);
            encoder.PopDebugGroup();
            drawTowers(encoder, cubeTowerPipeline,
                       std::string("Reflect cube ") + (target == 0 ? "B" : "A"));
            encoder.PopDebugGroup();
            faceBundles_[target].push_back(encoder.Finish());
        }
    }

    // The main pass: the towers reflect B, and the walls add the mirror images of the ship.
    const wgpu::BindGroup mainBindGroup = bindGroup(mainCamera_, cubeViews[1]);
    recordMainBundle_ = [device, format, depthFormat, mainBindGroup, &light, drawTowers,
                         mainTowerPipeline](const wgpu::BindGroup& reflections) {
        const wgpu::RenderBundleEncoderDescriptor descriptor = {
            .colorFormatCount = 1,
            .colorFormats = &format,
            .depthStencilFormat = depthFormat,
        };
        const wgpu::RenderBundleEncoder encoder = device.CreateRenderBundleEncoder(&descriptor);
        encoder.SetBindGroup(0, mainBindGroup);
        light.Bind(encoder);
        encoder.SetBindGroup(2, reflections);
        drawTowers(encoder, mainTowerPipeline, "Reflect cube B and the ship");
        return encoder.Finish();
    };
}

void Buildings::Update(const wgpu::CommandEncoder& encoder, double scroll,
                       const Mat4& viewProjection, const Vec3& cameraPosition, uint32_t width,
                       uint32_t height) {
    const double length = kAlong[1] - kAlong[0];
    for (size_t i = 0; i < towers_.size(); ++i) {
        const TowerState& tower = towers_[i];
        const double along =
            kAlong[0] +
            std::fmod(std::fmod(tower.along - scroll - kAlong[0], length) + length, length);
        // The tower goes from kTowerBase up to its height, so its center is halfway.
        const double values[kTowerFloats] = {
            shipCenter_[0] + heading_[0] * along + right_[0] * tower.side,
            (kTowerBase + tower.height) / 2,
            shipCenter_[2] + heading_[2] * along + right_[2] * tower.side,
            tower.reflectivity,
            tower.width,
            tower.height - kTowerBase,
            tower.depth,
            tower.yaw,
            tower.tint[0],
            tower.tint[1],
            tower.tint[2],
            0.0,
        };
        for (size_t k = 0; k < kTowerFloats; ++k) {
            towerData_[i * kTowerFloats + k] = static_cast<float>(values[k]);
        }
    }
    WriteBuffer(device_, towerBuffer_, 0, towerData_.data(), towerData_.size());

    const Mat4 projection = Perspective(std::numbers::pi / 2, 1, 2, 8000);
    for (size_t index = 0; index < kCubeFaces.size(); ++index) {
        const CubeFace& face = kCubeFaces[index];
        std::vector<float> data(kCameraFloats, 0.0f);
        const Mat4 faceViewProjection =
            Multiply(projection, FaceView(cubeCenter_, face.right, face.up, face.forward));
        std::copy(faceViewProjection.begin(), faceViewProjection.end(), data.begin());
        for (size_t k = 0; k < 3; ++k) {
            data[16 + k] = static_cast<float>(cubeCenter_[k]);
            data[20 + k] = static_cast<float>(face.right[k]);
            data[24 + k] = static_cast<float>(face.up[k]);
            data[28 + k] = static_cast<float>(face.forward[k]);
        }
        WriteBuffer(device_, faceCameras_[index], 0, data.data(), data.size());
    }
    std::vector<float> main(kCameraFloats, 0.0f);
    std::copy(viewProjection.begin(), viewProjection.end(), main.begin());
    for (size_t k = 0; k < 3; ++k) {
        main[16 + k] = static_cast<float>(cameraPosition[k]);
    }
    WriteBuffer(device_, mainCamera_, 0, main.data(), main.size());

    // Render A, then B. Each pass executes the bundle of its face.
    for (size_t target = 0; target < 2; ++target) {
        for (size_t face = 0; face < kCubeFaces.size(); ++face) {
            const wgpu::RenderPassColorAttachment colorAttachment = {
                .view = cubeFaceViews_[target][face],
                .loadOp = wgpu::LoadOp::Clear,
                .storeOp = wgpu::StoreOp::Store,
                .clearValue = {0.0, 0.0, 0.0, 1.0},
            };
            const wgpu::RenderPassDepthStencilAttachment depthAttachment = {
                .view = cubeDepthView_,
                .depthLoadOp = wgpu::LoadOp::Clear,
                .depthStoreOp = wgpu::StoreOp::Discard,
                .depthClearValue = 1.0f,
            };
            const wgpu::RenderPassDescriptor descriptor = {
                .colorAttachmentCount = 1,
                .colorAttachments = &colorAttachment,
                .depthStencilAttachment = &depthAttachment,
            };
            const wgpu::RenderPassEncoder pass = encoder.BeginRenderPass(&descriptor);
            pass.ExecuteBundles(1, &faceBundles_[target][face]);
            pass.End();
        }
    }

    RenderShipReflections(encoder, viewProjection, cameraPosition, width, height);
}

void Buildings::Draw(const wgpu::RenderPassEncoder& pass) const {
    if (mainBundle_) {
        pass.ExecuteBundles(1, &mainBundle_);
    }
}

// Select the walls that reflect the ship, and draw the mirror images of the ship.
void Buildings::RenderShipReflections(const wgpu::CommandEncoder& encoder,
                                      const Mat4& viewProjection, const Vec3& cameraPosition,
                                      uint32_t width, uint32_t height) {
    const ReflectionTargets& targets = ReflectionTargetsFor(width, height);
    struct Wall {
        double distance;
        std::array<double, kMirrorFloats> values;
    };
    std::vector<Wall> walls;
    for (size_t i = 0; i < kTowerCount; ++i) {
        // The tower values as the shader has them: rounded to float.
        const float* tower = &towerData_[i * kTowerFloats];
        const Vec3 center = {tower[0], tower[1], tower[2]};
        const Vec3 size = {tower[4], tower[5], tower[6]};
        // The local x and z axes of the tower after its rotation, as rotateYaw() in the shader.
        const double yaw = tower[7];
        const Vec3 axisX = {std::cos(yaw), 0.0, -std::sin(yaw)};
        const Vec3 axisZ = {std::sin(yaw), 0.0, std::cos(yaw)};
        auto negate = [](const Vec3& v) { return Vec3{-v[0], -v[1], -v[2]}; };
        // The four walls: +X, -X, +Z, and -Z, as in the wall ids of the shader.
        struct Side {
            Vec3 normal;
            double offset;
            Vec3 sideU;
            double halfU;
        };
        const std::array<Side, 4> sides = {{
            {axisX, size[0] / 2, axisZ, size[2] / 2},
            {negate(axisX), size[0] / 2, axisZ, size[2] / 2},
            {axisZ, size[2] / 2, axisX, size[0] / 2},
            {negate(axisZ), size[2] / 2, axisX, size[0] / 2},
        }};
        for (size_t side = 0; side < sides.size(); ++side) {
            const auto& [normal, offset, sideU, halfU] = sides[side];
            Vec3 wallCenter;
            Vec3 toCamera;
            Vec3 toShip;
            for (size_t k = 0; k < 3; ++k) {
                wallCenter[k] = center[k] + normal[k] * offset;
                toCamera[k] = cameraPosition[k] - wallCenter[k];
                toShip[k] = shipCenter_[k] - wallCenter[k];
            }
            const double distance = std::hypot(toShip[0], toShip[1], toShip[2]);
            if (Dot(normal, toCamera) <= 0 || Dot(normal, toShip) <= 0 ||
                distance > kMirrorDistance) {
                continue;
            }
            const double d = Dot(normal, wallCenter);
            const auto [nx, ny, nz] = normal;
            // The reflection through the plane: I - 2 n n^T, and a translation of 2 d n.
            // clang-format off
            walls.push_back({distance, {
                1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * nz, 0,
                -2 * nx * ny, 1 - 2 * ny * ny, -2 * ny * nz, 0,
                -2 * nx * nz, -2 * ny * nz, 1 - 2 * nz * nz, 0,
                2 * d * nx, 2 * d * ny, 2 * d * nz, 1,
                nx, ny, nz, d,
                wallCenter[0], wallCenter[1], wallCenter[2], static_cast<double>(i * 4 + side),
                sideU[0], sideU[1], sideU[2], halfU,
                0, 1, 0, size[1] / 2,
            }});
            // clang-format on
        }
    }
    // From near to far. A stable sort keeps the order of equal distances, as JavaScript does.
    std::stable_sort(walls.begin(), walls.end(),
                     [](const Wall& a, const Wall& b) { return a.distance < b.distance; });
    const size_t count = std::min(walls.size(), kMaxMirrors);
    for (size_t i = 0; i < count; ++i) {
        for (size_t k = 0; k < kMirrorFloats; ++k) {
            mirrorData_[i * kMirrorFloats + k] = static_cast<float>(walls[i].values[k]);
        }
    }
    if (count > 0) {
        WriteBuffer(device_, mirrorBuffer_, 0, mirrorData_.data(), count * kMirrorFloats);
    }
    std::vector<float> view(kMirrorViewFloats, 0.0f);
    std::copy(viewProjection.begin(), viewProjection.end(), view.begin());
    for (size_t k = 0; k < 3; ++k) {
        view[16 + k] = static_cast<float>(cameraPosition[k]);
    }
    WriteBuffer(device_, mirrorViewBuffer_, 0, view.data(), view.size());

    const wgpu::RenderPassColorAttachment colorAttachments[] = {
        {.view = targets.color,
         .loadOp = wgpu::LoadOp::Clear,
         .storeOp = wgpu::StoreOp::Store,
         .clearValue = {0.0, 0.0, 0.0, 0.0}},
        {.view = targets.id,
         .loadOp = wgpu::LoadOp::Clear,
         .storeOp = wgpu::StoreOp::Store,
         .clearValue = {0.0, 0.0, 0.0, 0.0}},
    };
    const wgpu::RenderPassDepthStencilAttachment depthAttachment = {
        .view = targets.depth,
        .depthLoadOp = wgpu::LoadOp::Clear,
        .depthStoreOp = wgpu::StoreOp::Discard,
        .depthClearValue = 1.0f,
    };
    const wgpu::RenderPassDescriptor descriptor = {
        .colorAttachmentCount = 2,
        .colorAttachments = colorAttachments,
        .depthStencilAttachment = &depthAttachment,
    };
    const wgpu::RenderPassEncoder pass = encoder.BeginRenderPass(&descriptor);
    ship_.DrawMirrored(pass, mirrorBindGroup_, static_cast<uint32_t>(count));
    pass.End();
}

// The reflection images of the ship, with the size of the view. A new size makes new images and
// records the main bundle again.
const Buildings::ReflectionTargets& Buildings::ReflectionTargetsFor(uint32_t width,
                                                                    uint32_t height) {
    if (!reflectionTargets_.color || reflectionTargets_.width != width ||
        reflectionTargets_.height != height) {
        auto texture = [&](wgpu::TextureFormat format, wgpu::TextureUsage usage) {
            const wgpu::TextureDescriptor descriptor = {
                .usage = usage, .size = {width, height, 1}, .format = format};
            return device_.CreateTexture(&descriptor).CreateView();
        };
        const wgpu::TextureUsage sampled =
            wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
        reflectionTargets_ = {
            .width = width,
            .height = height,
            .color = texture(kMirrorColorFormat, sampled),
            .id = texture(kMirrorIdFormat, sampled),
            .depth = texture(kMirrorDepthFormat, wgpu::TextureUsage::RenderAttachment),
        };
        const wgpu::BindGroupEntry entries[] = {
            {.binding = 0, .textureView = reflectionTargets_.color},
            {.binding = 1, .textureView = reflectionTargets_.id},
        };
        const wgpu::BindGroupDescriptor descriptor = {
            .layout = reflectionLayout_, .entryCount = 2, .entries = entries};
        mainBundle_ = recordMainBundle_(device_.CreateBindGroup(&descriptor));
    }
    return reflectionTargets_;
}

// Move a tower out of the street of the cube center. The towers turn by at most kTowerTurn from
// the heading, so the size of a tower across the street is less than 0.75 of its largest side.
double Buildings::AwayFromStreet(double side, double width, double depth) {
    const double clearance = 0.75 * std::max(width, depth) + 40;
    const double offset = side - kCubeCenter[0];
    if (std::abs(offset) >= clearance) {
        return side;
    }
    return kCubeCenter[0] + (offset < 0 ? -clearance : clearance);
}

}  // namespace hackathon
