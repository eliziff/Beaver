fn main() {
    // Node-API linkage applies to the native addon only, not the WebAssembly build.
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        napi_build::setup();
    }
}
