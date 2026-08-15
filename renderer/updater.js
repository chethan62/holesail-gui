/* updater.js — desktop-only in-app update check + install.
   Depends on ui.js only. */

import { $, log, toast } from './ui.js'

/// Desktop only: the updater plugin is not built into mobile releases, so
/// the `plugin:updater|check` command is absent there and the boot call is a
/// silent no-op. NOTE: there is no `window.__TAURI__.updater` global in this
/// no-bundler renderer (withGlobalTauri injects core only) — the plugin
/// command is invoked directly, bridge.js style.
/// Non-fatal by design — offline or not-yet-released updates just skip.
/// manual=true is the topbar ⬆ button: it surfaces "up to date" and error
/// toasts too, while the boot check stays silent.
export async function checkForUpdate(manual = false) {
  const core = window.__TAURI__ && window.__TAURI__.core
  if (!core) return
  const btn = $('#update-check')
  if (manual && btn) {
    btn.disabled = true
    btn.textContent = '…'
  }
  try {
    const res = await core.invoke('plugin:updater|check')
    // raw command payload: Update | null; the JS wrapper's shouldUpdate
    // getter is just version !== currentVersion
    const shouldUpdate = !!res && res.version !== res.currentVersion
    if (shouldUpdate) {
      const v = res.version || '?'
      toast(`Update available: v${v}`)
      log(`Update available: v${v}`, 'ok', [
        { label: 'Download & install', onClick: () => installUpdate(v) }
      ])
    } else if (manual) {
      toast('You are up to date')
      log('Update check: up to date', 'ok')
    }
  } catch (err) {
    // offline / no published release yet — only worth telling a human who
    // explicitly asked for the check
    if (manual) {
      toast('Update check failed — offline or no release yet', true)
      log(`Update check failed: ${err}`, 'err')
    }
  } finally {
    if (manual && btn) {
      btn.disabled = false
      btn.textContent = '⬆'
    }
  }
}

/// Desktop only: download + install the offered update in-app. The plugin
/// protocol is a 3-step chain — check() returns a Metadata with a `rid`
/// (the Update lives in the webview's resource table), download(rid, Channel)
/// streams the artifact with Started/Progress/Finished events, install()
/// swaps the binary and relaunches the app on desktop. `updater:default`
/// already grants all three commands.
export async function installUpdate(version) {
  const core = window.__TAURI__ && window.__TAURI__.core
  if (!core || !core.Channel) {
    toast('In-app update unavailable — download from the releases page', true)
    return
  }
  let contentLength = 0
  const ch = new core.Channel()
  ch.onmessage = (e) => {
    if (!e) return
    if (e.event === 'Started') {
      contentLength = (e.data && e.data.contentLength) || 0
      toast(`Downloading v${version}…`)
    } else if (e.event === 'Progress') {
      if (contentLength && e.data && e.data.chunkLength) {
        const pct = Math.min(99, Math.round((e.data.chunkLength / contentLength) * 100))
        toast(`Downloading v${version}… ${pct}%`)
      }
    } else if (e.event === 'Finished') {
      toast(`v${version} downloaded — installing…`)
    }
  }
  try {
    const meta = await core.invoke('plugin:updater|check')
    if (!meta || !meta.rid) throw new Error('no update available')
    const bytesRid = await core.invoke('plugin:updater|download', { rid: meta.rid, onEvent: ch })
    await core.invoke('plugin:updater|install', { updateRid: meta.rid, bytesRid })
    // install() relaunches the app on desktop; landing here means no
    // relaunch happened (unexpected) — tell the user how to proceed
    toast('Update installed — restart the app to apply')
    log('Update installed — restart the app to apply', 'ok')
  } catch (err) {
    toast('Update failed: ' + err, true)
    log(`Update install failed: ${err}`, 'err')
  }
}
