pub mod api;
pub mod audio;
pub mod connect;
pub mod contract;
pub mod live;
pub mod permissions;
pub mod queue;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the recorder");
}
