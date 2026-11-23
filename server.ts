import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { FFMPEG_MISSING, findFfmpeg } from "./src/audio.js";
import { createEngines } from "./src/engines.js";
import { transcribe } from "./src/pipeline.js";

const DISPLAY_NAMES = {
  openrouter: "OpenRouter dictation",
  chatgpt: "ChatGPT subscription dictation",
};

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    openrouterApiKey: {
      type: "string",
      label: "OpenRouter API key",
      secret: true,
    },
  });
  const ENGINES = createEngines(
    async () => (await settings.get()).openrouterApiKey,
  );
  for (const id of ["openrouter", "chatgpt"] as const) {
    const engine = ENGINES[id];
    bb.experimental_aiServices.register({
      id,
      displayName: DISPLAY_NAMES[id],
      status: async () =>
        (await findFfmpeg())
          ? engine.status()
          : { ready: false, message: FFMPEG_MISSING },
      transcribe: (file, opts) => transcribe(file, opts, engine, bb.log),
    });
  }
}
