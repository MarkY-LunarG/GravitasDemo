#include "app/scenes/scene.h"

namespace hackathon {

std::vector<SceneFactory> BenchmarkScenes() {
    // Milestone 2 of the port has the first scene. The asteroid, entry, and city scenes follow.
    return {CreateTerrainScene};
}

}  // namespace hackathon
