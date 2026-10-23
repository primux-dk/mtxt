fn main() {
    // ONNX Runtime's static library calls `__isPlatformVersionAtLeast`, which
    // lives in clang's runtime library; a release build with LTO does not
    // pull it in by itself.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        if let Ok(out) = std::process::Command::new("clang").arg("--print-runtime-dir").output() {
            let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if std::path::Path::new(&dir).join("libclang_rt.osx.a").exists() {
                println!("cargo:rustc-link-search=native={dir}");
                println!("cargo:rustc-link-lib=static=clang_rt.osx");
            }
        }
    }
    tauri_build::build()
}
