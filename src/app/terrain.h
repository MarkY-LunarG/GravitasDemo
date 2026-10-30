// A ground grid that draws as a solid surface or as a wireframe.
// All world units are meters. The height of the ground comes from Perlin noise and craters.
//
// The grid is a sector of rings around the point below the camera, and it covers the view of the
// camera. The columns are at equal angles, and the radius of each row is a fixed ratio times the
// radius of the row before it. Thus a cell has approximately the same size on the screen at all
// distances: near cells are small and far cells are large. The grid is correct only for a camera
// at the grid center that looks approximately along the grid heading. When the camera moves,
// call SetGridCenter() again.
//
// The grid itself does not move. Update() offsets the point where the vertex shader samples the
// height field, so the terrain features move across the grid.

#pragma once

#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

namespace hackathon {

class DirectionalLight;

enum class TerrainRenderMode { Solid, Wireframe };

// The look of the terrain. Low ground has lowColor and high ground has highColor, and slopes are a
// little darker. heightScale multiplies the height of the hills and craters, and craterScale
// multiplies the depth of the craters (0 for no craters).
struct TerrainStyle {
    Vec3 lowColor;
    Vec3 highColor;
    double heightScale;
    double craterScale;
};

// Gray ground with the full height.
inline constexpr TerrainStyle kDefaultTerrainStyle = {
    .lowColor = {0.3, 0.3, 0.3},
    .highColor = {0.55, 0.55, 0.55},
    .heightScale = 1.0,
    .craterScale = 1.0,
};

// The distance from the grid center to the last ring, in meters.
inline constexpr double kTerrainRadius = 20000.0;

class Terrain {
  public:
    Terrain(const wgpu::Device& device, wgpu::TextureFormat format, wgpu::TextureFormat depthFormat,
            const DirectionalLight& light);

    TerrainRenderMode RenderMode() const { return mode_; }
    void SetRenderMode(TerrainRenderMode mode) { mode_ = mode; }

    // Set the colors and the height scale of the terrain.
    void SetStyle(const TerrainStyle& style);
    // The grid vertices are in world space, so the terrain needs no model matrix.
    void SetViewProjection(const Mat4& viewProjection);
    // Put the grid center below the camera, and turn the grid to the horizontal camera heading.
    // Only X and Z of position and heading are used. Call this each time the camera moves.
    void SetGridCenter(const Vec3& position, const Vec3& heading);
    // Set the point of the height field that is at the center of the grid. Only X and Z are used.
    // When the point moves along a direction, the terrain features move the opposite direction.
    void Update(const Vec3& worldPosition);

    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    wgpu::Device device_;
    const DirectionalLight& light_;
    wgpu::Buffer uniformBuffer_;
    wgpu::BindGroup bindGroup_;
    wgpu::RenderPipeline solidPipeline_;
    wgpu::RenderPipeline wirePipeline_;
    wgpu::Buffer indexBuffer_;
    TerrainRenderMode mode_ = TerrainRenderMode::Solid;
};

}  // namespace hackathon
