#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod appearance;
mod attachments;
mod bridge;
mod browser_view;
mod close;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Rust-only sensitive-sync contract; production sync awaits a verified local-service producer"
    )
)]
mod connection_actor_http_port;
mod connection_actor_port;
mod desktop_tab;
mod diagnostics;
mod documents;
mod file_download;
mod file_download_attachment_validation;
mod file_journal;
mod host_services;
mod native_preferences;
mod native_ssh_bridge;
mod native_ui;
#[cfg(target_os = "windows")]
mod notification_identity_windows;
mod notification_store_grant;
mod notifications;
mod open_in_apps;
mod policy;
mod resources;
mod runner_args;
mod ssh;
mod terminal_host;
mod terminal_transport;
mod terminal_viewport;
#[cfg_attr(
    test,
    allow(
        dead_code,
        reason = "Tests deliberately disable the real credential constructor"
    )
)]
mod vault;
mod window_geometry;
mod window_kernel;
mod window_persistence;
mod window_sampling;
#[allow(
    dead_code,
    reason = "Frozen storage recovery/unknown-inspection APIs have no production recovery UI yet"
)]
mod window_state;

use nsh_engine::Bundle;
use std::{path::PathBuf, process::ExitCode};

#[cfg(target_os = "macos")]
use nsh_platform_macos as platform;
#[cfg(target_os = "windows")]
use nsh_platform_windows as platform;

fn bundle_path() -> Result<PathBuf, String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let Some(path) = runner_args::parse(&args, cfg!(target_os = "windows"))?.bundle {
        return Ok(path);
    }
    let exe = std::env::current_exe().map_err(|_| "executable_path_failed")?;
    let parent = exe.parent().ok_or("executable_path_failed")?;
    #[cfg(target_os = "macos")]
    let root = parent.join("../Resources/nsh");
    #[cfg(target_os = "windows")]
    let root = parent.join("nsh");
    Ok(root.join("bundle.js"))
}

fn run() -> Result<ExitCode, String> {
    let path = bundle_path()?
        .canonicalize()
        .map_err(|_| "bundle_not_found")?;
    // Sidecars are mandatory: a missing capabilities file must not become an unrestricted bundle.
    let root = path.parent().ok_or("bundle_not_found")?;
    let caps: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("capabilities.json")).map_err(|_| "capabilities_missing")?,
    )
    .map_err(|_| "capabilities_invalid")?;
    let app: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("app.json")).map_err(|_| "app_metadata_missing")?,
    )
    .map_err(|_| "app_metadata_invalid")?;
    if app["id"] != "com.yee94.yuri.nsh" {
        return Err("app_identity_mismatch".into());
    }
    let bundle = Bundle::read(&path).map_err(|_| "bundle_read_failed")?;
    let root = root.to_owned();
    let persistence = window_persistence::Port::native()?;
    let mut process = bridge::process::Process::native(appearance::metadata(&app))?;
    if caps["host"].as_array().is_some_and(|names| {
        names.iter().any(|name| {
            name.as_str()
                .is_some_and(|name| native_ssh_bridge::METHODS.contains(&name))
        })
    }) {
        process.install_ssh(
            native_ssh_bridge::native_driver(),
            app["version"].as_str().unwrap_or("").to_owned(),
        )?;
    }
    let process = std::rc::Rc::new(std::cell::RefCell::new(process));
    let factory_process = process.clone();
    native_ui::run_factory(
        process,
        Box::new(move || {
            let saved = persistence.status()?;
            if let Some(error) = saved.error {
                return Err(error);
            }
            if saved
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.windows.len() > 1)
            {
                return Err("window_restore_multiple_writers_not_enabled".into());
            }
            let restored = saved.snapshot.and_then(|s| s.windows.into_iter().next());
            assemble_window(
                &factory_process.borrow(),
                bundle.clone(),
                root.clone(),
                &caps,
                &app,
                persistence.clone(),
                restored,
            )
        }),
    )
}

fn assemble_window(
    process: &bridge::process::Process,
    bundle: Bundle,
    root: PathBuf,
    caps: &serde_json::Value,
    app: &serde_json::Value,
    persistence: window_persistence::Port,
    restored: Option<window_state::MainWindow>,
) -> Result<native_ui::Window, String> {
    let components = platform::Components::default();
    let terminal = terminal_viewport::register(&components)?;
    let tabs = desktop_tab::register(&components)?;
    let (picker, picks) = attachments::channel();
    let (saver, saves) = documents::channel();
    let (diagnostic_port, diagnostic_jobs) = diagnostics::channel();
    let (download_port, download_jobs) = file_download::channel();
    let (ui, inbox) = native_ui::channel();
    let metadata = appearance::metadata(app);
    if let Some(saved) = &restored {
        if saved.runtime_key != format!("nsh:{}", saved.connection_id) {
            return Err("window_restore_runtime_identity_unsupported".into());
        }
        if saved.window_key != "primary" {
            return Err("window_restore_secondary_not_enabled".into());
        }
    }
    let installed = bridge::process::factory::open(
        process,
        restored
            .as_ref()
            .map_or_else(|| "primary".into(), |saved| saved.window_key.clone()),
        caps.clone(),
        metadata.clone(),
        ui,
        restored.as_ref().map(|saved| saved.connection_id.clone()),
    )?;
    installed.owner.services().install_tabs(tabs)?;
    let data_dir = nsh_engine::data_dir()
        .ok_or("native_data_directory_unavailable")?
        .join("com.yee94.yuri.nsh");
    installed.install_stores(
        &data_dir,
        terminal,
        notification_store_grant::terminal_catalog(&installed.namespace)?,
    )?;
    let bridge::process::factory::Installed {
        host,
        mut owner,
        window_key,
        ..
    } = installed;
    owner.install_attachments(&host, picker)?;
    owner.services().install_documents(&host, saver)?;
    owner
        .services()
        .install_file_download(&host, download_port)?;
    native_ui::prepare_application()?;
    let notification_jobs = match notification_store_grant::native() {
        Ok(storage) => {
            Some(owner.install_notifications(&host, storage, native_ui::notification_factory())?)
        }
        Err(_) => {
            for &method in notifications::METHODS {
                host.handle(method, |call| {
                    call.reject("notification_unsupported_private_directory")
                });
            }
            None
        }
    };
    owner.services().install_diagnostics_with_preference(
        &host,
        diagnostic_port,
        metadata["version"].clone(),
        metadata["build"].clone(),
        Some(Box::new(native_preferences::Consent::native())),
    )?;
    // The AppKit AppView and native appearance mailbox stay on the process main thread.
    Ok(native_ui::Window {
        // The stable key also selected the native journal/catalog namespace before Engine load.
        window_key,
        source: platform::AppSource::Bundle(bundle),
        options: platform::AppOptions {
            app_id: "com.yee94.yuri.nsh".into(),
            title: "Yuri Native".into(),
            size: (1280, 860),
            asset_base: Some(platform::AssetBase::Directory(root.join("assets"))),
            host,
            components,
            ..Default::default()
        },
        inbox,
        services: owner.services(),
        dialogs: native_ui::Dialogs {
            picks: Some(picks),
            saves: Some(saves),
            diagnostics: Some(diagnostic_jobs),
            notifications: notification_jobs,
            downloads: Some(download_jobs),
        },
        lifetime: Some(owner),
        persistence: Some(persistence),
        restored,
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Yuri Native: {error}");
            ExitCode::FAILURE
        }
    }
}
