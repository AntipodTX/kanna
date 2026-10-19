import { existsSync } from "node:fs"

const localConfigUrl = new URL("./postcss.local.config.js", import.meta.url)
const localConfig = existsSync(localConfigUrl)
  ? ((await import(localConfigUrl.href)).default ?? {})
  : {}

const baseConfig = {
  plugins: {
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
}

export default {
  ...baseConfig,
  ...localConfig,
  plugins: {
    ...baseConfig.plugins,
    ...(localConfig.plugins ?? {}),
  },
}
