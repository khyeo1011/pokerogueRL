// Config for the batch runner (bridge/batch/*.batch.ts): bridge/vitest.config.ts with only the batch
// files, which the normal test run leaves out. Launched by scripts/run_games.sh.

import { resolve } from "node:path";
import type { ConfigEnv } from "vite";
import bridgeConfig from "../vitest.config.ts";

export default async (env: ConfigEnv) => {
  const config = await bridgeConfig(env);
  config.test.dir = resolve(import.meta.dirname);
  config.test.include = [`${config.test.dir}/*.batch.ts`];
  // The driver ends a run that hits an unhandled error as truncated ("crash") and logs it. Don't also
  // fail the whole process for it, so one bad run doesn't mark the batch as failed.
  config.test.dangerouslyIgnoreUnhandledErrors = true;
  return config;
};
