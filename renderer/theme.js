/* theme.js — dark/light theme toggle. Leaf module (depends only on ui.js). */

import { $, THEME_KEY } from './ui.js'

export function applyTheme(theme) {
  // The button holds both glyphs and CSS shows the one for the OTHER theme
  // (style.css), so there is no text to swap here.
  document.body.dataset.theme = theme
  // The glyph states the action, so the accessible name has to as well:
  // "Toggle light/dark theme" never says which theme you actually get.
  const btn = $('#theme-toggle')
  if (btn) {
    const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`
    btn.setAttribute('aria-label', label)
    btn.title = label
  }
}

export function initTheme() {
  let theme = 'dark'
  try {
    // With no stored choice, follow the OS instead of forcing dark on someone
    // running a light desktop. An explicit click wins from then on.
    theme =
      localStorage.getItem(THEME_KEY) ||
      (window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark')
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
