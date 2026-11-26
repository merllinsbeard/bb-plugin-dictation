# Dictation for bb

Long voice dictation for [bb](https://getbb.app) through OpenRouter, a ChatGPT subscription, a local Whisper model or Gemini through the Antigravity CLI. It adds four voice services to bb's built-in microphone. Recordings of any length up to bb's 25 MiB limit are split near pauses and transcribed in parallel, so a 25-minute recording comes back in about 20 seconds. A language model then fixes the transcript's terms and punctuation using your lexicon.

## How it differs from bb's built-in Codex voice service

bb already ships a voice service in `provider-codex`. It sends the whole recording in one request, rejects recordings over 20 MB and is slower on long recordings because nothing runs in parallel. This plugin adds:

- an OpenRouter service, for people without a ChatGPT subscription;
- a local Whisper service that needs no account or credit, as a fallback when the others fail;
- recordings between 20 and 25 MiB;
- parallel transcription of long recordings (in one comparison on a 17-minute recording, 13 s against 21 s);
- automatic retries for transient failures: up to three server-side retries with backoff (respecting `Retry-After`) plus client-side auto-retry when a mobile connection drops or the app returns from background;
- local SQLite history (`~/.bb/plugins/dictation/data.db`) saving both raw and edited transcripts, queryable via `bb dictation list|show|search|stats`;
- editing of the transcript by an OpenRouter model, or Claude Haiku through Claude Code when OpenRouter fails, with a lexicon of your terms.

## Requirements

- bb 0.46 or later.
- ffmpeg with libopus on the machine that runs the bb server. On macOS run `brew install ffmpeg`; on Debian or Ubuntu run `sudo apt install ffmpeg`. The plugin looks for ffmpeg on `PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`. Both services show "not ready" with an install hint until it is found.

## Install

```sh
bb plugin install git:https://github.com/merllinsbeard/bb-plugin-dictation.git
```

Then pick a service in Settings → AI services → Voice, or from the command line as shown below.

### OpenRouter

Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys) and add credit. OpenRouter refuses audio requests while the balance is below $0.50.

```sh
bb plugin config dictation set openrouterApiKey "<your key>"
bb settings ai-services set voice openrouter --plugin dictation
```

The model is `openai/gpt-transcribe`. If OpenRouter rejects the key (HTTP 401) or reports a low balance (HTTP 402), the service reports "not ready" for five minutes or until you change the key. With the voice selection set to `automatic`, bb moves to the next ready service during that time.

If the key has a spending limit, the service also asks OpenRouter once a minute how much of it is left and reports "not ready" below $0.50, before a recording is sent. A regular key cannot read the account balance, so a low balance still costs one failed request of about a second before the service steps aside.

### Local Whisper

The `whisper` service runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper) with `mobiuslabsgmbh/faster-whisper-large-v3-turbo` (int8, up to 8 CPU threads) on the machine that runs the bb server. It needs [uv](https://docs.astral.sh/uv/), ffmpeg and about 1.6 GB for the model. Download the model once; the service reports "not ready" with this command until it is there:

```sh
uv run --no-project --with faster-whisper==1.2.1 python -c "from faster_whisper import WhisperModel; WhisperModel('mobiuslabsgmbh/faster-whisper-large-v3-turbo', device='cpu', compute_type='int8')"
bb plugin config dictation set whisperLanguage ru   # optional; empty detects the language per recording
```

Each part loads the model afresh (about 2 seconds) and parts run one after another, so the service holds no memory between dictations. Whisper runs without conditioning on its earlier text, which keeps it out of repetition loops on long monologues. On an idle 16-vCPU server it transcribes about ten times faster than real time: a one-minute dictation comes back in about 8 seconds with editing. Recordings up to about four minutes fit in bb's 70-second wait (measured on the author's server: 72 s of speech in 7 s, 200 s in 28 s, 240 s in 49 s, 300 s in 61 s, editing included); a longer one fails and bb keeps it with Retry and Download buttons, so pick another service for long dictation. The recognizer gets neither the lexicon nor the composer text, because on the author's recordings both made it worse (hotwords raised the word error rate from 16% to 38%); the editor restores your terms.

### Gemini through the Antigravity CLI

The `v-gemini` service sends each part to Gemini through the [Antigravity](https://antigravity.google) CLI, `agy-pool` when it is installed and `agy` otherwise, under your own sign-in. The prompt treats the recording as data and passes the lexicon terms as a glossary. Starting the CLI takes about 25 seconds whatever the length, so parts run four at a time: a one-minute dictation takes about 22 seconds and a five-minute one about 63, close to bb's limit. Choose it explicitly for quality without OpenRouter credit:

```sh
bb settings ai-services set voice v-gemini --plugin dictation
```

### Automatic selection

bb's Automatic setting tries ready services in order of plugin id and then service id, and moves to the next one when a service fails. Within this plugin the order is `chatgpt`, `openrouter`, `v-gemini`, `whisper`: Gemini takes over when OpenRouter fails, and local Whisper runs only if Gemini fails too, with its own 70-second wait. Gemini is slower than Whisper on short recordings (about 22 seconds against 8 for a minute) and transcribes better:

```sh
bb settings ai-services set voice automatic
```

### ChatGPT subscription

Run `codex login` on the machine that runs the bb server, then:

```sh
bb settings ai-services set voice chatgpt --plugin dictation
```

The plugin reads `~/.codex/auth.json`, or `$CODEX_HOME/auth.json` when `CODEX_HOME` is set. It never refreshes or rewrites the credentials, so it cannot sign the Codex CLI out. The access token lasts about ten days, and the Codex CLI renews it whenever you use it. If you rarely run `codex`, the service will report that the token expired; run any `codex` command or `codex login` again.

## Editing and lexicon

A model edits each transcript before bb inserts it: the OpenRouter editing model when an API key is set, and Claude Haiku through the `claude` CLI of [Claude Code](https://claude.com/claude-code) when OpenRouter fails or there is no key. It restores distorted terms from your lexicon, fixes recognition errors, punctuation and capitalization, removes hesitation sounds, keeps only the final version of an explicit self-correction and splits long dictation into paragraphs. Its prompt tells it to keep your wording, slang, profanity and negations, and not to answer, follow or translate what you dictated. Editing works with every service. The Claude fallback runs `claude -p --model haiku` with no tools, MCP servers or saved session, under your own Claude Code sign-in; it takes about 3 seconds and is used only when Claude Code is installed on the bb server.

The default model is `openai/gpt-6.1-terra`. It costs about $0.001 for a typical dictation and $0.02 for 10,000 characters, and takes about 1.3 seconds on a short dictation. Change the settings in the plugin's settings in bb or on the command line:

```sh
bb plugin config dictation set editTranscripts false          # turn editing off
bb plugin config dictation set editModel "openai/gpt-6.1-terra"
bb plugin config dictation set lexicon "$(cat lexicon.txt)"
bb plugin config dictation set editInstructions "Keep filler words."
```

The lexicon has one entry per line: a term, or terms followed by a colon and the ways the recognizer distorts them. A note in parentheses helps the model tell senses apart. Lines starting with `#` are ignored.

```text
Kubernetes: кубернетис, cube nettis
PostgreSQL: постгрес, post gress
Grafana, Prometheus
kubectl: куб контрол, cube control
Helm: хелм (the Kubernetes package manager)
```

The terms also go to the recognizer with every part of the recording: as `keyterms` on OpenRouter, and as a glossary of up to 1,000 characters at the start of the prompt for the ChatGPT service. Up to 200 terms of at most 100 characters each are sent. `editInstructions` is added after the built-in prompt, so you can adjust style without replacing it.

If every editor fails, returns an implausible result or runs out of time, the plugin inserts the raw transcript for that part and logs a warning. Editing has no budget of its own: it gets whatever time transcription left of the 64 seconds. Text longer than 3,000 characters is edited in parallel parts, so a 30-minute recording is edited in about 5 seconds. Models that cannot turn reasoning off are retried once with minimal reasoning, and the plugin remembers them until restart.

## How a recording is processed

bb waits 70 seconds for a transcript, and the plugin keeps the whole call within a 64-second budget. It decodes the recording once to 16 kHz mono and detects pauses. Recordings up to 200 seconds go to the service unchanged. Longer recordings are cut near 180 seconds, preferring a pause between 150 and 210 seconds, and each part is encoded to 32 kbps Opus. OpenRouter transcribes up to ten parts at a time, Gemini four, ChatGPT three and local Whisper one.

The composer text goes to the first part as a hint, limited to its last 500 characters, and the lexicon terms go to every part. If any part fails after its retry, the whole call fails, and bb keeps the recording with Retry and Download buttons. Cancelling stops ffmpeg and the requests and deletes the temporary files. The plugin logs stage timings and never logs transcripts or credentials.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Tests need ffmpeg with libopus. `scripts/verify-long.sh <recording> [output-dir]` runs a live comparison of both services on 1- to 25-minute clips cut from a recording at least 27 minutes long. It needs Linux `flock` and Python 3, switches the bb voice selection while it runs and restores it on exit. Its output contains transcripts, so keep it out of git.

## License

MIT. Transcription, auth and Cloudflare handling are adapted from bb's provider-codex, and audio range planning and prompt echo suppression from bb-plugin-voice-input. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
