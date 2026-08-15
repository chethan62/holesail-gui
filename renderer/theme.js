/* theme.js — dark/light theme toggle. Leaf module (depends only on ui.js). */

import { $, THEME_KEY } from './ui.js'

export function applyTheme(theme) {
  document.body.dataset.theme = theme
  $('#theme-toggle').textContent = theme === 'light' ? '🌙' : '🌓'
}

export function initTheme() {
  let theme = 'dark'
  try {
    theme = localStorage.getItem(THEME_KEY) || 'dark'
  } catch {}
  applyTheme(theme)
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.body.dataset.theme === 'light' ? 'dark' : 'light'
    applyTheme(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {}
  })
}
