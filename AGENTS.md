# Dictation

This bb plugin provides server-side voice services (`server.ts`) and a lightweight frontend content script (`app.ts`) that auto-retries transient failed recordings in the composer. Check the `@get-bb/plugin-sdk` types before using an API, and refresh the pin with `bb plugin types` when bb ships a newer SDK.

Both services share one Engine table and one transcription pipeline. OpenRouter runs ten parts at a time and ChatGPT three, because more parallel ChatGPT requests trigger Cloudflare challenges. The whole call stays inside a 64-second budget so bb, which waits 70 seconds, still gets a clear error. Keep cancellation and temporary-file cleanup intact when you change the pipeline.

Before committing, run `npm run typecheck`, `npm test` and `npm run build`. Audio tests use the real ffmpeg, which must have libopus. `scripts/verify-long.sh` changes the bb voice selection while it runs, so run one instance at a time; it restores the previous selection on exit.

Git installs build without devDependencies, so runtime code may import only packages listed in `dependencies`. Before merging, install the branch head with `bb plugin install git:<repo>@<sha>` and confirm both services report ready.

Never log credentials, and never commit recordings or transcripts. Keep the upstream MIT notices in LICENSE and NOTICE.
