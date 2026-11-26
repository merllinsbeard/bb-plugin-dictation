# Dictation

This bb plugin provides server-side voice services (`server.ts`) and a lightweight frontend content script (`app.ts`) that auto-retries transient failed recordings in the composer. Check the `@get-bb/plugin-sdk` types before using an API, and refresh the pin with `bb plugin types` when bb ships a newer SDK.

All four services share one Engine table and one transcription pipeline. OpenRouter runs ten parts at a time, Gemini four, ChatGPT three (more parallel ChatGPT requests trigger Cloudflare challenges) and local Whisper one. Whisper and Gemini run as child processes (`src/process.ts`) in their own process group, so cancellation kills uv's or the CLI's children too. bb's Automatic tries services in plugin-id, then service-id order, which is why the Gemini id is `v-gemini`: it must sort after `openrouter` and before `whisper`, so Gemini runs first and local Whisper stays the fallback. The whole call stays inside a 64-second budget so bb, which waits 70 seconds, still gets a clear error. Keep cancellation and temporary-file cleanup intact when you change the pipeline.

Before committing, run `npm run typecheck`, `npm test` and `npm run build`. Audio tests use the real ffmpeg, which must have libopus. `scripts/verify-long.sh` changes the bb voice selection while it runs, so run one instance at a time; it restores the previous selection on exit.

Git installs build without devDependencies, so runtime code may import only packages listed in `dependencies`. Before merging, confirm every service reports ready on the branch head. `bb plugin install` refuses an id that is already installed and `bb plugin remove` deletes the key and history, so install a copy under another id from a local path (change `name` in package.json and the CLI name in server.ts), check it with `bb voice transcribe`, then remove the copy.

Never log credentials, and never commit recordings or transcripts. Keep the upstream MIT notices in LICENSE and NOTICE.
