// Runs bridge/test/ with pokerogue's own vitest setup (jsdom, test/setup/*, the game's #aliases).
// Use scripts/test_bridge.sh: the default config loader breaks pokerogue's plugins when the config
// lives outside pokerogue/, so it needs `--configLoader native`.

import { resolve } from "node:path";
import type { ConfigEnv } from "vite";
import pokerogueConfig from "../pokerogue/vitest.config.ts";

export default async (env: ConfigEnv) => {
  const config = await pokerogueConfig(env);
  // Setup files and assets are resolved against pokerogue/.
  config.root = resolve(import.meta.dirname, "../pokerogue");
  config.test.dir = resolve(import.meta.dirname, "test");
  config.test.include = [`${config.test.dir}/**/*.test.ts`];
  return config;
};
