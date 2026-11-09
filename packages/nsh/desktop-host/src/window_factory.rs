//! The production pre-Engine installation seam. OS registration/dialogs stay on the UI thread.
use super::*;

pub(crate) struct Installed {
    pub host: HostChannel,
    pub owner: Owner,
    pub window_key: String,
    pub namespace: String,
}
pub(crate) fn open(
    process: &Process,
    window_key: String,
    capabilities: Value,
    metadata: Value,
    appearance: appearance::Port,
    restore_target: Option<String>,
) -> Result<Installed> {
    let namespace = crate::file_journal::window_namespace(&window_key).map_err(str::to_owned)?;
    let host = HostChannel::default();
    let owner = process
        .open_window(WindowRequest {
            window_key: window_key.clone(),
            host: host.clone(),
            capabilities,
            metadata,
            appearance,
            restore_target,
        })?
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "window_process_install_timeout")??;
    Ok(Installed {
        host,
        owner,
        window_key,
        namespace,
    })
}
impl Installed {
    pub fn install_stores(
        &self,
        data_dir: &std::path::Path,
        terminal: crate::terminal_viewport::Registration,
        catalog: crate::notifications::Store,
    ) -> Result<()> {
        self.owner.services().install_terminal(
            &self.host,
            terminal,
            crate::terminal_host::CatalogSource::Granted(catalog),
        )?;
        self.owner
            .services()
            .install_window_file_journal(&self.host, data_dir, &self.window_key)
    }
}
