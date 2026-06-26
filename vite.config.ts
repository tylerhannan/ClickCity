import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `base` must match the GitHub Pages path. For a project page published from the
// `gh-pages` branch the site lives at https://<user>.github.io/ClickCity/, so the
// asset base is "/ClickCity/". Override with VITE_BASE if the repo is renamed.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/ClickCity/',
})
