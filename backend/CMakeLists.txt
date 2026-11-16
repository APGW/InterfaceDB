cmake_minimum_required(VERSION 3.16)
project(pqm_live_api VERSION 1.0.0 LANGUAGES CXX)

find_package(Drogon CONFIG REQUIRED)

add_executable(pqm-live-api src/main.cpp)
target_compile_features(pqm-live-api PRIVATE cxx_std_17)
target_link_libraries(pqm-live-api PRIVATE Drogon::Drogon)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(pqm-live-api PRIVATE -Wall -Wextra -Wpedantic)
endif()

install(TARGETS pqm-live-api RUNTIME DESTINATION bin)
