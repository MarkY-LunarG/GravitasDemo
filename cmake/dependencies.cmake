# The dependencies of the desktop target: Dawn and GLFW. find_package is tried first. If it does
# not find a dependency, FetchContent downloads and builds it. Set
# FETCHCONTENT_TRY_FIND_PACKAGE_MODE=NEVER to always build them from source.

include(FetchContent)

# On Linux, find the window systems that the host can build, so that X11 and Wayland can both be in
# the build. GLFW selects one at run time.
set(HACKATHON_HAVE_X11 OFF)
set(HACKATHON_HAVE_WAYLAND OFF)
if (UNIX AND NOT APPLE)
    # The X11 backend of GLFW needs more than Xlib.
    find_package(X11)
    if (X11_FOUND AND X11_Xrandr_FOUND AND X11_Xinerama_FOUND AND X11_Xcursor_FOUND
            AND X11_Xi_FOUND AND X11_Xext_FOUND)
        set(HACKATHON_HAVE_X11 ON)
    endif()

    find_package(PkgConfig QUIET)
    if (PkgConfig_FOUND)
        pkg_check_modules(HACKATHON_WAYLAND QUIET wayland-client wayland-cursor wayland-egl xkbcommon)
        find_program(WAYLAND_SCANNER_EXECUTABLE NAMES wayland-scanner)
        if (HACKATHON_WAYLAND_FOUND AND WAYLAND_SCANNER_EXECUTABLE)
            set(HACKATHON_HAVE_WAYLAND ON)
        endif()
    endif()

    if (NOT HACKATHON_HAVE_X11 AND NOT HACKATHON_HAVE_WAYLAND)
        message(FATAL_ERROR
            "No X11 or Wayland development libraries were found. Install the X11 libraries "
            "(libx11, libxrandr, libxinerama, libxcursor, libxi, libxext) or the Wayland "
            "libraries (wayland, wayland-protocols, libxkbcommon).")
    endif()
    message(STATUS "Window systems: X11=${HACKATHON_HAVE_X11} Wayland=${HACKATHON_HAVE_WAYLAND}")
endif()

# Dawn. The revision is the one that Premium-GFXR builds. libwebgpu_gfxrecon compiles against the
# webgpu.h of that revision, so change this pin only together with the Premium-GFXR pin.
# Dawn must be a shared library: Premium-GFXR captures by interposing that library.
set(DAWN_BUILD_MONOLITHIC_LIBRARY SHARED)
set(DAWN_FETCH_DEPENDENCIES ON)
set(DAWN_USE_GLFW OFF)
set(DAWN_BUILD_SAMPLES OFF)
set(DAWN_BUILD_TESTS OFF)
set(TINT_BUILD_TESTS OFF)
if (UNIX AND NOT APPLE)
    set(DAWN_USE_X11 ${HACKATHON_HAVE_X11})
    set(DAWN_USE_WAYLAND ${HACKATHON_HAVE_WAYLAND})
endif()

message(STATUS "Fetching or finding Dawn")
FetchContent_Declare(
    Dawn
    GIT_REPOSITORY https://dawn.googlesource.com/dawn.git
    GIT_TAG 72871431b55aa888c0cf5e0f8942421da125994a
    # A shallow clone cannot fetch a commit that is not at the tip of a branch.
    GIT_SHALLOW FALSE
    GIT_SUBMODULES ""
    SOURCE_DIR ${EXTERNAL_DEPS_SOURCE_DIR}/dawn
    BINARY_DIR ${EXTERNAL_DEPS_BINARY_DIR}/dawn
    FIND_PACKAGE_ARGS
)
FetchContent_MakeAvailable(Dawn)

# GLFW, at a release tag, so that a GLFW change cannot change the build without review.
set(GLFW_BUILD_DOCS OFF)
set(GLFW_BUILD_EXAMPLES OFF)
set(GLFW_BUILD_TESTS OFF)
set(GLFW_INSTALL OFF)
if (UNIX AND NOT APPLE)
    set(GLFW_BUILD_X11 ${HACKATHON_HAVE_X11})
    set(GLFW_BUILD_WAYLAND ${HACKATHON_HAVE_WAYLAND})
endif()

message(STATUS "Fetching or finding GLFW")
FetchContent_Declare(
    glfw3
    GIT_REPOSITORY https://github.com/glfw/glfw.git
    GIT_TAG 3.4
    GIT_SHALLOW TRUE
    SOURCE_DIR ${EXTERNAL_DEPS_SOURCE_DIR}/glfw
    BINARY_DIR ${EXTERNAL_DEPS_BINARY_DIR}/glfw
    FIND_PACKAGE_ARGS 3.4
)
FetchContent_MakeAvailable(glfw3)
