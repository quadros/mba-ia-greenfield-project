# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — background video processing worker (BullMQ consumer), no exposed port. Built from `Dockerfile.worker.dev` (a separate image from `nestjs-api`'s `Dockerfile.dev`) — it's the only image with `ffmpeg`/`ffprobe` installed. See § Videos Module below.
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 7, port `6379` — BullMQ's backing store
- `minio` — MinIO (S3-compatible object storage), API port `9000`, console port `9001`, bucket `streamtube-videos`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (already runs --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting

npm run start:worker                     # Worker entry point (run inside video-worker instead — see below)
npm run start:worker:dev                 # Worker with hot-reload (video-worker's default command)
```

### Which container to run tests in — `nestjs-api` vs `video-worker`

`nestjs-api`'s image (`Dockerfile.dev`) does **not** have `ffmpeg`/`ffprobe` installed — only `video-worker`'s image (`Dockerfile.worker.dev`) does (TD-05: keep the API image lean, since only the worker needs FFmpeg). Both images otherwise share the same codebase via the same bind mount, so:

- Any test that does **not** touch `src/videos/worker/**` (i.e. anything that doesn't import `mediaforge` or boot `WorkerModule`) can run from either container — `nestjs-api` is the default.
- Tests under `src/videos/worker/` (`worker.module.spec.ts`, `video.processor.integration-spec.ts`) and `test/videos-full-flow.e2e-spec.ts` (which boots the real `WorkerModule` alongside the API) **require** `ffmpeg` — run these from `video-worker`, not `nestjs-api`.
- The full suite (`npm test`, `npm run test:e2e`) must therefore run from `video-worker` to cover everything — `nestjs-api` alone will fail the worker-specific files.

Because the long-running `video-worker` service is itself a live BullMQ consumer, running the test suite via `docker compose exec video-worker ...` while the service is also up creates **two competing consumers on the same Redis queue**, and jobs can silently go to the wrong one. Stop the service first, then use a throwaway container from the same image for testing:

```bash
docker compose stop video-worker
docker compose run -d --rm --name video-worker-test --entrypoint sh video-worker -c "sleep infinity"

docker exec video-worker-test npm test -- --runInBand
docker exec video-worker-test npm run test:e2e
docker exec video-worker-test npx tsc --noEmit
docker exec video-worker-test npm run lint

docker stop video-worker-test
docker compose up -d video-worker   # restart the real service afterward
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos Module

Upload, background processing, and streaming/download for videos (Phase 03). Decisions are recorded in `docs/decisions/technical-decisions-phase-03-videos.md`; the plan is `docs/phases/phase-03-videos/phase-03-videos.md`.

### Entity (`src/videos/entities/video.entity.ts`)

`Video`, table `videos`, owned many-to-one by `Channel` (`channel_id`). Status lifecycle: `draft → processing → ready | failed` (`VideoStatus` enum). Key columns: `storage_key`/`thumbnail_key` (object storage keys, unique on `storage_key`), `upload_id` (active S3/MinIO multipart upload, cleared on complete/abort), `size_bytes` (`bigint`, mapped to a `string` in TS), `duration_seconds`/`width`/`height`/`codec`/`bitrate` (populated by the worker), `error_message` (populated only when `status: failed`). Migration: `src/database/migrations/1784491179100-CreateVideos.ts`.

### Endpoints (`src/videos/videos.controller.ts`, all authenticated — no `@Public()`)

| Method & path | Purpose |
|---|---|
| `POST /videos` | Pre-registers a draft video for the caller's channel |
| `POST /videos/:id/upload-session` | Initiates a real S3/MinIO multipart upload (≤10GB, enforced in the service — not a DTO validator, since it must surface as `413 FILE_TOO_LARGE`, not a generic `400`) |
| `POST /videos/:id/upload-session/parts/:partNumber` | Presigns a `PUT` URL for one multipart upload part |
| `POST /videos/:id/upload-session/complete` | Finalizes the multipart upload, flips the video to `processing`, enqueues the background job |
| `POST /videos/:id/upload-session/abort` | Aborts the active session, resets the video back to a retryable `draft` |
| `GET /videos/:id` | Video detail: status + extracted metadata |
| `GET /videos/:id/playback-url` | Presigned `GET` URL (only when `status: ready`) — the same URL serves both streaming (`Range` → native `206 Partial Content`, no custom code) and full download |

Ownership is enforced as `404 VIDEO_NOT_FOUND` (never a distinguishable `403`) for videos belonging to another user's channel, matching the non-leaking precedent already used for `INVALID_CREDENTIALS` in the auth module. `ChannelsService.findByUserId(userId)` resolves the caller's channel — the JWT payload only carries `{ sub, email }`, no `channelId`.

### Storage (`src/storage/`) — global module

`StorageService` wraps `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` against MinIO locally (`STORAGE_ENDPOINT`, `STORAGE_FORCE_PATH_STYLE=true`) — swapping to real AWS S3 in production means removing those two env vars only, no code change. Bucket: `STORAGE_BUCKET` (default `streamtube-videos`). Key layout: `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.png`. `StorageModule` is `@Global()` so any module can inject `StorageService` without importing it explicitly.

### Queue (`src/queue/`)

`QueueModule` registers the `video-processing` BullMQ queue against Redis (`REDIS_HOST`/`REDIS_PORT`). `VideoQueueService.enqueueProcessing(videoId)` adds a `process-video` job with `attempts: 3`, exponential `backoff` (5s base), `removeOnComplete: true`, `removeOnFail: false` (failed jobs are kept for inspection; the terminal signal is the DB row, not the queue). The queue name constant lives in its own `queue.constants.ts` file — do not move it into `queue.module.ts`, that reintroduces a circular import with `video-queue.service.ts`.

### Worker (`src/videos/worker/`) — separate process/container

`WorkerModule` + `main-worker.ts` boot a second NestJS application (`NestFactory.createApplicationContext`, no HTTP listener) — the `video-worker` Compose service, built from its own `Dockerfile.worker.dev` (the only image with `ffmpeg`/`ffprobe`; `nestjs-api`'s image is untouched). `VideoProcessor` (`@Processor('video-processing')`, extends `WorkerHost`) downloads the original from storage to a temp file, probes it via `mediaforge` (`probeAsync`/`getMediaDuration`/`getDefaultVideoStream`/`summarizeVideoStream`), extracts a PNG thumbnail (`frameToBuffer` — only `png`/`mjpeg`/`bmp` are supported, not `jpeg`; the timestamp is clamped strictly inside `[0, duration)` since seeking to exactly `duration` silently returns an empty buffer), uploads the thumbnail, and updates the row to `ready` with the extracted metadata. On the **final** failed attempt (`@OnWorkerEvent('failed')`, `job.attemptsMade >= attempts`), the row flips to `failed` with `error_message`; intermediate retry failures leave the row untouched so BullMQ's own backoff can recover silently.

### Testing notes specific to this module

- `src/videos/worker/fixtures/` holds a real ~17KB 1-second H.264 fixture (`sample.mp4`, generated via `ffmpeg -f lavfi testsrc`) and a corrupt file (`corrupt.mp4`) for the failure-path test — regenerate `sample.mp4` with `ffmpeg -f lavfi -i "testsrc=duration=1:size=320x240:rate=10" -f lavfi -i "sine=frequency=1000:duration=1" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -y sample.mp4` if it ever needs to change.
- Worker/queue integration tests that observe a **completed** job must listen for the BullMQ worker's own `'completed'` event (`removeOnComplete: true` deletes the job from Redis the instant it succeeds, so polling `queue.getJobs()`/`job.getState()` afterward finds nothing). Tests observing a **failed** job can poll the DB row instead (`removeOnFail: false` keeps the job, and the DB update is the more reliable signal since `@OnWorkerEvent` handlers aren't awaited by BullMQ's own event emission).
- `Test.createTestingModule({...}).compile()` alone does **not** run `onModuleInit`/`onApplicationBootstrap` — `@nestjs/bullmq`'s `WorkerHost` only starts its internal `Worker` in `onModuleInit`. Call `await module.init()` explicitly when testing a `WorkerModule` in isolation.
- See § "Which container to run tests in" above — worker/mediaforge tests need the `video-worker` image.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
