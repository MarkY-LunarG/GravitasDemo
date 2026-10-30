#include "app/scenes/scene.h"

namespace hackathon {

std::vector<SceneFactory> BenchmarkScenes() {
    return {CreateTerrainScene, CreateAsteroidScene, CreateEntryScene, CreateCityScene};
}

}  // namespace hackathon
