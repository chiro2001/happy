#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_websocket::init())
    // Registered in release too, and registered here rather than in `setup` so
    // it is installed before anything else logs. A release build has no console
    // window, so `Stdout` alone would go nowhere: `LogDir` is what makes the
    // log survive the process.
    //
    // On Windows this lands in %LOCALAPPDATA%\com.slopus.happy\logs\happy.log.
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .targets([
          tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
            file_name: Some("happy".to_string()),
          }),
          tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
        ])
        // Bounds the damage from a runaway loop: the app forwards its console
        // to this file, and a log line inside a render loop would otherwise
        // grow it without limit.
        .max_file_size(20 * 1024 * 1024)
        .build(),
    )
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
