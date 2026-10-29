// Tooling side of the site Worker: only where the assembled site lives
import { defineWranglerConfig } from 'wrangler/experimental-config'

export default defineWranglerConfig({
  assetsDirectory: '../dist/site'
})
