/* renderer/bridge.js — Tauri bridge.
   Uses window.__TAURI__ (enabled via "withGlobalTauri": true in tauri.conf.json),
   so no bundler / npm runtime deps are needed. */

'use strict'

export async function rpc(method, params) {
  return await window.__TAURI__.core.invoke('rpc', { method, params })
}

export async function workerDiagnostics() {
  return await window.__TAURI__.core.invoke('worker_diagnostics')
}

export async function workerRestart() {
  return await window.__TAURI__.core.invoke('worker_restart')
}

export async function takePendingDeepLinks() {
  return await window.__TAURI__.core.invoke('take_pending_deep_links')
}

export async function versionInfo() {
  return await window.__TAURI__.core.invoke('version_info')
}

export async function onAppEvent(callback) {
  return await window.__TAURI__.event.listen('app:event', (event) => callback(event.payload))
}

export async function onEvent(callback) {
  return await window.__TAURI__.event.listen('worker:event', (event) => callback(event.payload))
}
