import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { FFMPEG_MISSING, findFfmpeg } from "./src/audio.js";
import { createEditor, DEFAULT_EDIT_MODEL } from "./src/edit.js";
import { createEngines } from "./src/engines.js";
import { lexiconTerms } from "./src/lexicon.js";
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
    editTranscripts: {
      type: "boolean",
      label: "Edit transcripts with a model",
      description:
        "After transcription, an OpenRouter model fixes terms, punctuation and recognition errors. Needs the OpenRouter API key, also with the ChatGPT service. If editing fails or runs out of time, the raw transcript is inserted.",
      default: true,
    },
    editModel: {
      type: "string",
      label: "Editing model",
      description: "OpenRouter model ID used for editing.",
      default: DEFAULT_EDIT_MODEL,
    },
    lexicon: {
      type: "string",
      label: "Lexicon",
      description:
        "One line per entry: a term, or terms followed by a colon and the ways the recognizer distorts them, for example `Kubernetes: кубернетис, cube nettis`. The terms are sent to the recognizer and the whole text to the editing model.",
      experimental_multiline: true,
      default: "",
    },
    editInstructions: {
      type: "string",
      label: "Extra editing instructions",
      description:
        "Optional. Added after the built-in editing prompt, for example how you want filler words or paragraphs handled.",
      experimental_multiline: true,
      default: "",
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
      transcribe: async (file, opts) => {
        const current = await settings.get();
        const key = current.openrouterApiKey?.trim();
        const model = current.editModel.trim() || DEFAULT_EDIT_MODEL;
        const edit =
          current.editTranscripts && key
            ? createEditor(
                {
                  key,
                  model,
                  lexicon: current.lexicon,
                  instructions: current.editInstructions,
                },
                bb.log,
              )
            : undefined;
        return transcribe(
          file,
          { ...opts, terms: lexiconTerms(current.lexicon) },
          engine,
          bb.log,
          edit,
        );
      },
    });
  }
}
