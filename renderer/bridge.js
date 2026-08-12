/* renderer/bridge.js — Tauri bridge.
   Uses window.__TAURI__ (enabled via "withGlobalTauri": true in tauri.conf.json),
   so no bundler / npm runtime deps are needed. */

'use strict'

// RPC with an optional per-call timeout override. Default 30s (a hung
// worker surfaces fast); session-start calls (server:start, client:connect)
// pass 90s because cold DHT bootstrap genuinely takes that long.
export async function rpc(method, params, timeoutMs) {
  return await window.__TAURI__.core.invoke('rpc', { method, params, timeoutMs })
}

export async function workerDiagnostics() {
  return await window.__TAURI__.core.invoke('worker_diagnostics')
}

export async function workerRestart() {
  return await window.__TAURI__.core.invoke('worker_restart')
}

export async function workerRetrySpawn() {
  return await window.__TAURI__.core.invoke('retry_spawn_worker')
}

export async function takePendingDeepLinks() {
  return await window.__TAURI__.core.invoke('take_pending_deep_links')
}

export async function versionInfo() {
  return await window.__TAURI__.core.invoke('version_info')
}

export async function lanAddress() {
  return await window.__TAURI__.core.invoke('lan_address')
}

export async function logAppend(line) {
  return await window.__TAURI__.core.invoke('log_append', { line })
}

// saved tunnels (temp/permanent) — persisted by the Rust backend
export async function savedList() {
  return await window.__TAURI__.core.invoke('saved_list')
}
export async function savedSave(tunnel) {
  return await window.__TAURI__.core.invoke('saved_save', { tunnel })
}
export async function savedDelete(id) {
  return await window.__TAURI__.core.invoke('saved_delete', { id })
}
export async function savedDuplicate(id) {
  return await window.__TAURI__.core.invoke('saved_duplicate', { id })
}
export async function savedExport() {
  return await window.__TAURI__.core.invoke('saved_export')
}
export async function savedImport(json) {
  return await window.__TAURI__.core.invoke('saved_import', { json })
}

// recent keys — held by the Rust backend (OS keychain on desktop, 0600 file
// on Android); the renderer keeps only an in-memory copy
export async function recentList() {
  return await window.__TAURI__.core.invoke('recent_list')
}
export async function recentAdd(label) {
  return await window.__TAURI__.core.invoke('recent_add', { label })
}
export async function recentClear() {
  return await window.__TAURI__.core.invoke('recent_clear')
}

export async function onAppEvent(callback) {
  return await window.__TAURI__.event.listen('app:event', (event) => callback(event.payload))
}

export async function onEvent(callback) {
  return await window.__TAURI__.event.listen('worker:event', (event) => callback(event.payload))
}
