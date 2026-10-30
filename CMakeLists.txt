cmake_minimum_required(VERSION 3.28)

set(HACKATHON_LANGUAGES C CXX)
if (APPLE)
    list(APPEND HACKATHON_LANGUAGES OBJCXX)
endif()
project(webgpu_hackathon LANGUAGES ${HACKATHON_LANGUAGES})

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Where FetchContent puts the sources and the builds of the dependencies. A cache variable or an
# environment variable of the same name can change them, so that several build directories can
# share one Dawn checkout.
set(EXTERNAL_DEPS_SOURCE_DIR "${CMAKE_BINARY_DIR}/external_deps_src" CACHE PATH
    "Directory for the sources of the dependencies")
if (IS_DIRECTORY "$ENV{EXTERNAL_DEPS_SOURCE_DIR}")
    set(EXTERNAL_DEPS_SOURCE_DIR "$ENV{EXTERNAL_DEPS_SOURCE_DIR}")
endif()
set(EXTERNAL_DEPS_BINARY_DIR "${CMAKE_BINARY_DIR}/external_deps_bin" CACHE PATH
    "Directory for the builds of the dependencies")
if (IS_DIRECTORY "$ENV{EXTERNAL_DEPS_BINARY_DIR}")
    set(EXTERNAL_DEPS_BINARY_DIR "$ENV{EXTERNAL_DEPS_BINARY_DIR}")
endif()

if (EMSCRIPTEN)
    include(cmake/emscripten.cmake)
else()
    include(cmake/dependencies.cmake)
endif()

# The files that the application reads at run time, relative to assets/.
set(HACKATHON_ASSETS
    lunarg-ship/lunarg_ship.glb
    textures/2025-LunarG-Color-Logo-with-tagline.png
    textures/LunarG-Logo-Neon-Transparent.png
    textures/LunarG-Logo-NeonTube-Transparent.png
)

# The WGSL shaders. cmake/embed_shaders.cmake puts them into generated/shaders.h.
set(HACKATHON_SHADERS
    shaders/asteroid_common.wgsl
    shaders/asteroid_render.wgsl
    shaders/asteroid_shape.wgsl
    shaders/asteroid_update.wgsl
    shaders/blit.wgsl
    shaders/buildings.wgsl
    shaders/clouds.wgsl
    shaders/fade.wgsl
    shaders/gpu_timer.wgsl
    shaders/lens_flare.wgsl
    shaders/light.wgsl
    shaders/lightning.wgsl
    shaders/noise.wgsl
    shaders/rain.wgsl
    shaders/reentry_flame.wgsl
    shaders/reentry_smoke.wgsl
    shaders/ship.wgsl
    shaders/ship_effects.wgsl
    shaders/ship_glow.wgsl
    shaders/sky.wgsl
    shaders/sky_planet.wgsl
    shaders/sky_planet_fragment.wgsl
    shaders/terrain.wgsl
)
list(TRANSFORM HACKATHON_SHADERS PREPEND "${CMAKE_CURRENT_SOURCE_DIR}/")
include(cmake/embed_shaders.cmake)

add_executable(hackathon
    src/main.cpp
    src/app/app.cpp
    src/app/asteroids.cpp
    src/app/blit.cpp
    src/app/buildings.cpp
    src/app/clouds.cpp
    src/app/fade.cpp
    src/app/gpu_timer.cpp
    src/app/lens_flare.cpp
    src/app/light.cpp
    src/app/lightning.cpp
    src/app/rain.cpp
    src/app/reentry.cpp
    src/app/scenes/asteroid_scene.cpp
    src/app/scenes/city_scene.cpp
    src/app/scenes/entry_scene.cpp
    src/app/scenes/scenes.cpp
    src/app/scenes/terrain_scene.cpp
    src/app/ship.cpp
    src/app/ship_path.cpp
    src/app/sky.cpp
    src/app/terrain.cpp
    src/platform/gpu_init.cpp
    src/platform/options.cpp
    src/platform/platform_glfw.cpp
    src/util/gltf.cpp
    src/util/mat4.cpp
    src/util/screenshot.cpp
    src/util/shader_builder.cpp
)
target_include_directories(hackathon PRIVATE src)
# cgltf is a third-party header, so the project warnings do not apply to it.
target_include_directories(hackathon SYSTEM PRIVATE external/cgltf external/stb)
hackathon_embed_shaders(hackathon ${HACKATHON_SHADERS})

if (MSVC)
    target_compile_options(hackathon PRIVATE /W4)
    target_compile_definitions(hackathon PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
else()
    target_compile_options(hackathon PRIVATE -Wall -Wextra)
endif()

if (EMSCRIPTEN)
    target_sources(hackathon PRIVATE src/platform/platform_web.cpp)
    hackathon_configure_web_target(hackathon)
else()
    target_sources(hackathon PRIVATE src/platform/platform_native.cpp)
    if (APPLE)
        target_sources(hackathon PRIVATE src/platform/metal_layer.mm)
        target_link_libraries(hackathon PRIVATE "-framework Cocoa" "-framework QuartzCore")
    endif()
    if (UNIX AND NOT APPLE)
        if (HACKATHON_HAVE_X11)
            target_compile_definitions(hackathon PRIVATE HACKATHON_HAVE_X11)
        endif()
        if (HACKATHON_HAVE_WAYLAND)
            target_compile_definitions(hackathon PRIVATE HACKATHON_HAVE_WAYLAND)
        endif()
    endif()
    find_package(Threads REQUIRED)
    target_link_libraries(hackathon PRIVATE dawn::webgpu_dawn glfw Threads::Threads)

    # Copy the assets next to the executable, where the application looks for them.
    foreach(asset IN LISTS HACKATHON_ASSETS)
        add_custom_command(TARGET hackathon POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${CMAKE_CURRENT_SOURCE_DIR}/assets/${asset}"
                "$<TARGET_FILE_DIR:hackathon>/assets/${asset}")
        get_filename_component(asset_directory "${asset}" DIRECTORY)
        install(FILES "assets/${asset}" DESTINATION "bin/assets/${asset_directory}")
    endforeach()

    if (WIN32)
        # Windows finds webgpu_dawn.dll next to the executable.
        add_custom_command(TARGET hackathon POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                $<TARGET_RUNTIME_DLLS:hackathon> $<TARGET_FILE_DIR:hackathon>
            COMMAND_EXPAND_LISTS)
        install(FILES $<TARGET_RUNTIME_DLLS:hackathon> DESTINATION bin)
    elseif (TARGET dawn::webgpu_dawn)
        # Linux and macOS find the Dawn library in ../lib of the installed executable.
        install(FILES $<TARGET_FILE:dawn::webgpu_dawn> DESTINATION lib)
        if (APPLE)
            set_target_properties(hackathon PROPERTIES INSTALL_RPATH "@executable_path/../lib")
        else()
            set_target_properties(hackathon PROPERTIES INSTALL_RPATH "$ORIGIN/../lib")
        endif()
    endif()
    install(TARGETS hackathon RUNTIME DESTINATION bin)

    # Premium-GFXR captures the desktop target only when Dawn is a separate shared library and the
    # code uses only webgpu.h. This test checks both.
    if (UNIX AND NOT APPLE)
        find_package(Python3 COMPONENTS Interpreter)
        if (Python3_FOUND)
            enable_testing()
            add_test(NAME desktop_link
                COMMAND Python3::Interpreter
                    "${CMAKE_CURRENT_SOURCE_DIR}/scripts/check_desktop_link.py"
                    --executable $<TARGET_FILE:hackathon>
                    --source "${CMAKE_CURRENT_SOURCE_DIR}/src")
        endif()
    endif()
endif()
