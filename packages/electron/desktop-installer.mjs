import { parseReleaseVersion } from '../../deploy/update-service/lib/semver.js';

/** Installer fallback is pinned to the shared OTA decision, never a latest feed. */
export class DesktopInstaller {
  constructor(updater, { onProgress = () => {}, onError = () => {} } = {}) {
    this.updater = updater;
    this.version = null;
    this.downloaded = false;
    this.checking = null;
    this.downloading = null;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.on('download-progress', onProgress);
    updater.on('error', onError);
  }

  /** True while a download is in flight; used by host-update admission only. */
  get busy() { return Boolean(this.downloading); }

  clear() {
    if (this.downloading) return;
    this.version = null;
    this.downloaded = false;
  }

  async check(version, { channel, rollback = false } = {}) {
    const parsed = parseReleaseVersion(version);
    if (!parsed || (version.includes('-') && channel !== 'beta')) throw new Error('Invalid installer release channel');
    // Every window shares one updater; concurrent callers join instead of failing.
    for (;;) {
      if (this.downloading) return { downloaded: this.downloaded };
      if (this.version === version) return { downloaded: this.downloaded };
      const pending = this.checking;
      if (!pending) break;
      if (pending.version === version && pending.channel === channel && pending.rollback === rollback) return pending.promise;
      await pending.promise.catch(() => {});
    }
    const run = this.runCheck(version, { channel, rollback });
    this.checking = { version, channel, rollback, promise: run };
    try {
      return await run;
    } finally {
      if (this.checking?.promise === run) this.checking = null;
    }
  }

  async runCheck(version, { channel, rollback }) {
    this.updater.allowPrerelease = channel === 'beta';
    this.updater.allowDowngrade = rollback;
    this.updater.setFeedURL({ provider: 'generic', channel: 'full',
      url: `https://github.com/yee94/yuri/releases/download/v${version}/`,
      useMultipleRangeRequest: false });
    const result = await this.updater.checkForUpdates();
    if (result?.updateInfo?.version !== version) throw new Error('Installer metadata does not match the selected release');
    if (!result.isUpdateAvailable) throw new Error('The selected installer is not applicable to this desktop');
    this.version = version;
    this.downloaded = false;
    return { downloaded: false };
  }

  async download() {
    if (this.downloading) return this.downloading;
    if (this.downloaded) return;
    if (!this.version) throw new Error('No installer update selected');
    const run = (async () => {
      const files = await this.updater.downloadUpdate();
      if (!files?.length) throw new Error('Installer download did not produce a package');
      this.downloaded = true;
    })();
    const task = run.finally(() => { if (this.downloading === task) this.downloading = null; });
    this.downloading = task;
    return task;
  }

  assertPending() {
    if (!this.version || !this.downloaded || this.downloading) throw new Error('No downloaded installer update');
  }

  install() {
    this.assertPending();
    this.updater.quitAndInstall(false, true);
  }
}
