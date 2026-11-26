import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { FFMPEG_MISSING, findFfmpeg } from "./src/audio.js";
import {
  claudeBackend,
  createEditor,
  DEFAULT_EDIT_MODEL,
  openRouterBackend,
} from "./src/edit.js";
import { createEngines } from "./src/engines.js";
import {
  createDictationHistory,
  HISTORY_MIGRATIONS,
  type DictationRecord,
} from "./src/history.js";
import { lexiconTerms } from "./src/lexicon.js";
import { transcribe } from "./src/pipeline.js";
import { createGeminiEngine } from "./src/gemini.js";
import { createWhisperEngine } from "./src/whisper.js";

const DISPLAY_NAMES = {
  openrouter: "OpenRouter dictation",
  chatgpt: "ChatGPT subscription dictation",
  whisper: "Local Whisper dictation",
  "x-gemini": "Gemini dictation (Antigravity CLI)",
};

function formatPreview(text: string, maxChars = 120): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 1)}…`;
}

function formatRecordLine(record: DictationRecord): string {
  const duration =
    record.durationSec !== null ? `${Math.round(record.durationSec)}s` : "-";
  const body =
    record.status === "failed"
      ? `[FAILED] ${record.errorMessage ?? "unknown error"}`
      : formatPreview(record.editedText || record.rawText);
  return `#${record.id} ${record.createdAt} [${record.serviceId} ${duration}] ${body}`;
}

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
        "After transcription, a model fixes terms, punctuation and recognition errors: the OpenRouter editing model when the API key is set, then Claude Haiku through the Claude Code CLI when OpenRouter fails or has no key. If both fail or run out of time, the raw transcript is inserted.",
      default: true,
    },
    editModel: {
      type: "string",
      label: "Editing model",
      description: "OpenRouter model ID used for editing.",
      default: DEFAULT_EDIT_MODEL,
    },
    whisperLanguage: {
      type: "string",
      label: "Local Whisper language",
      description:
        "Language code for the local Whisper service, for example `ru` or `en`. Leave empty to detect it from each recording.",
      default: "",
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
    saveHistory: {
      type: "boolean",
      label: "Save dictation history to SQLite",
      description:
        "Persist every raw and edited transcript locally in the plugin's SQLite database (data.db). Inspect with `bb dictation list`, `bb dictation search`, or `bb dictation show`.",
      default: true,
    },
  });

  const history = createDictationHistory(() => {
    const db = bb.storage.database();
    bb.storage.migrate(db, [...HISTORY_MIGRATIONS]);
    return db;
  });

  const ENGINES = {
    ...createEngines(async () => (await settings.get()).openrouterApiKey),
    whisper: createWhisperEngine(
      async () => (await settings.get()).whisperLanguage,
    ),
    "x-gemini": createGeminiEngine(),
  };
  // bb's Automatic tries ready services in id order: `whisper` comes after
  // `openrouter` as the fallback that needs no account, and `x-gemini`, about
  // five times slower than local Whisper, comes last.
  for (const id of ["openrouter", "chatgpt", "whisper", "x-gemini"] as const) {
    const engine = ENGINES[id];
    bb.experimental_aiServices.register({
      id,
      displayName: DISPLAY_NAMES[id],
      status: async () =>
        (await findFfmpeg())
          ? engine.status()
          : { ready: false, message: FFMPEG_MISSING },
      transcribe: async (file, opts) => {
        const startedAt = performance.now();
        const current = await settings.get();
        const key = current.openrouterApiKey?.trim();
        const model = current.editModel.trim() || DEFAULT_EDIT_MODEL;
        const edit = current.editTranscripts
          ? createEditor(
              {
                lexicon: current.lexicon,
                instructions: current.editInstructions,
              },
              [...(key ? [openRouterBackend(key, model)] : []), claudeBackend()],
              bb.log,
            )
          : undefined;
        let savedId: number | undefined;
        const hooks = current.saveHistory
          ? {
              onTranscribed(info: {
                rawText: string;
                durationSec: number;
                parts: number;
                elapsedMs: number;
              }) {
                savedId = history.recordTranscribed({
                  serviceId: id,
                  durationSec: info.durationSec,
                  elapsedMs: info.elapsedMs,
                  audioBytes: file.size,
                  mimeType: file.type || "application/octet-stream",
                  parts: info.parts,
                  rawText: info.rawText,
                });
              },
              onEdited(info: {
                editedText: string;
                editModel: string;
                elapsedMs: number;
              }) {
                if (savedId === undefined) return;
                history.updateEdited({
                  id: savedId,
                  editedText: info.editedText,
                  editModel: info.editModel,
                  elapsedMs: info.elapsedMs,
                });
              },
            }
          : undefined;
        try {
          return await transcribe(
            file,
            { ...opts, terms: lexiconTerms(current.lexicon) },
            engine,
            bb.log,
            edit,
            hooks,
          );
        } catch (error) {
          if (current.saveHistory && savedId === undefined && !opts.signal.aborted) {
            try {
              history.recordFailure({
                serviceId: id,
                elapsedMs: performance.now() - startedAt,
                audioBytes: file.size,
                mimeType: file.type || "application/octet-stream",
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
            } catch (storageError) {
              bb.log.warn(
                `History failure write failed: ${storageError instanceof Error ? storageError.message : String(storageError)}`,
              );
            }
          }
          throw error;
        }
      },
    });
  }

  bb.cli.register(
    defineCli({
      name: "dictation",
      summary: "Inspect and search saved voice dictation transcripts",
      commands: {
        list: cliCommand({
          summary: "List recent saved dictations (newest first)",
          options: {
            limit: {
              type: "integer",
              min: 1,
              max: 200,
              default: 20,
              description: "Maximum rows to return (1-200)",
            },
            since: {
              type: "string",
              description: "Filter by ISO timestamp or YYYY-MM-DD prefix",
            },
            service: {
              type: "enum",
              values: ["openrouter", "chatgpt", "whisper", "x-gemini"],
              description: "Filter by transcription service",
            },
            failed: {
              type: "boolean",
              description: "Include failed dictation attempts",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input) {
            const rows = history.list({
              limit: input.options.limit,
              since: input.options.since,
              serviceId: input.options.service,
              includeFailed: input.options.failed,
            });
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(rows, null, 2) };
            }
            if (rows.length === 0) {
              return { exitCode: 0, stdout: "No saved dictations." };
            }
            return {
              exitCode: 0,
              stdout: rows.map(formatRecordLine).join("\n"),
            };
          },
        }),
        show: cliCommand({
          summary: "Print the full transcript for a saved dictation ID",
          positionals: [
            { name: "id", description: "Numeric dictation ID", required: true },
          ],
          options: {
            raw: {
              type: "boolean",
              description: "Show raw pre-edit STT transcript",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input) {
            const id = Number.parseInt(input.positionals.id, 10);
            if (!Number.isFinite(id) || id <= 0) {
              throw new PluginCliError(`Invalid dictation id: ${input.positionals.id}`, {
                code: "invalid_id",
                hint: "Run `bb dictation list` to see available numeric IDs.",
              });
            }
            const record = history.get(id);
            if (!record) {
              throw new PluginCliError(`Dictation #${id} not found`, {
                code: "not_found",
                hint: "Run `bb dictation list` to see saved dictations.",
              });
            }
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(record, null, 2) };
            }
            const text = input.options.raw
              ? record.rawText
              : record.editedText || record.rawText;
            return { exitCode: 0, stdout: text };
          },
        }),
        search: cliCommand({
          summary: "Search saved dictations (case-insensitive, Unicode-aware)",
          positionals: [
            { name: "query", description: "Substring to search for", required: true },
          ],
          options: {
            limit: {
              type: "integer",
              min: 1,
              max: 200,
              default: 20,
              description: "Maximum matches to return (1-200)",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input) {
            const rows = history.search(input.positionals.query, {
              limit: input.options.limit,
            });
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(rows, null, 2) };
            }
            if (rows.length === 0) {
              return { exitCode: 0, stdout: "No matching dictations." };
            }
            return {
              exitCode: 0,
              stdout: rows.map(formatRecordLine).join("\n"),
            };
          },
        }),
        stats: cliCommand({
          summary: "Show summary statistics for saved dictations",
          options: {
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input) {
            const stats = history.stats();
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(stats, null, 2) };
            }
            const mins = (stats.totalDurationSec / 60).toFixed(1);
            return {
              exitCode: 0,
              stdout: `Dictations: ${stats.ok} ok, ${stats.failed} failed (${stats.total} total) · ${mins} min audio · ${stats.totalChars} chars`,
            };
          },
        }),
      },
    }),
  );
}
