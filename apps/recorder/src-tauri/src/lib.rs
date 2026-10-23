pub mod api;
pub mod connect;
pub mod contract;
pub mod queue;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the recorder");
}
