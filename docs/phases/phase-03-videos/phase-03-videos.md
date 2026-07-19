---
kind: phase
name: phase-03-videos
test_specs_aware: false
sources_mtime:
  docs/project-plan.md: "2026-07-19T12:07:30-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T13:19:11-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-19T12:07:30-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-07-19T12:07:30-03:00"
  docs/phases/phase-03-videos/context.md: "2026-07-19T13:23:50-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-19T13:23:42-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload and background processing for StreamTube: 10GB-capable multipart upload directly to object storage without tying up the API, automatic draft pre-registration, a BullMQ-driven video worker that extracts metadata and generates a thumbnail via FFmpeg (`mediaforge`), a unique per-video presigned playback URL supporting native Range/206 streaming and download, and a draft → processing → ready|failed status lifecycle persisted on the video row.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure

**Description:** Install all Phase 03 production dependencies, create `storage` and `queue` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema, and add MinIO (object storage) and Redis (queue backend) services to Docker Compose, plus a new `video-worker` service sharing the API's image.

**Technical actions:**

- Install production dependencies in `nestjs-project`: `@nestjs/bullmq@^11.0.4`, `bullmq@^5.80.9`, `@aws-sdk/client-s3@^3.1090.0`, `@aws-sdk/s3-request-presigner@^3.1090.0`, `mediaforge@^0.3.0`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, required — e.g. `http://minio:9000`; unset/omitted for real AWS S3 in prod), `STORAGE_REGION` (string, default `'us-east-1'`), `STORAGE_ACCESS_KEY` (string, required), `STORAGE_SECRET_KEY` (string, required), `STORAGE_BUCKET` (string, default `'streamtube-videos'`), `STORAGE_FORCE_PATH_STYLE` (boolean, default `true`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`)
- Update `src/config/env.validation.ts` — add all new environment variables to the Joi schema (`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` required, others with defaults). Update `.env.example` with all new variables and Docker Compose-compatible defaults
- Add to `nestjs-project/compose.yaml`:
  - `minio` service — image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000` (S3 API) and `9001` (console), env `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` matching `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`, healthcheck via `curl -f http://localhost:9000/minio/health/live`
  - `redis` service — image `redis:7-alpine`, port `6379`, healthcheck via `redis-cli ping`
  - `video-worker` service — `build: { context: ., dockerfile: Dockerfile.dev }` (same image as `nestjs-api`), `command: npm run start:worker:dev` (new npm script, added this SI, running the worker bootstrap in watch mode), `depends_on` on `db`, `redis`, and `minio` (all `condition: service_healthy`), volumes mirroring `nestjs-api`'s bind mount
  - `nestjs-api`'s `depends_on` extended to also wait on `redis` and `minio` (`condition: service_healthy`)
- Add npm scripts to `package.json`: `"start:worker": "nest start --entryFile videos/worker/main-worker"`, `"start:worker:dev": "nest start --entryFile videos/worker/main-worker --watch"` (the worker entry file is created in SI-03.7; this SI only wires the scripts and Compose service ahead of it)

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `minio`, `redis`, and `video-worker` alongside the existing `db`, `mailpit`, `nestjs-api` — all report healthy/running
- `docker compose exec nestjs-api sh -c "curl -f http://minio:9000/minio/health/live"` succeeds from inside the Docker network
- `docker compose exec nestjs-api sh -c "redis-cli -h redis ping"` returns `PONG`
- Starting the application without `STORAGE_ACCESS_KEY` causes a Joi validation error at bootstrap — the app does not start
- Existing Phase 01/02 test suite still passes unmodified (no regression from the new config namespaces)

---

### SI-03.2 — Video Entity and Migration

**Description:** Define the `Video` entity — owned by a `Channel`, carrying the draft → processing → ready|failed status lifecycle (TD-07), storage keys for the original file and thumbnail (TD-02), the active multipart upload session fields (TD-03), and extracted metadata fields (TD-05) — and its migration.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `Video` entity per the Data Model below
- Create `src/database/migrations/<timestamp>-CreateVideos.ts` — creates the `videos` table, the `videos_status_enum` Postgres enum, FK to `channels.id`, and the unique index on `storage_key`
- Register `TypeOrmModule.forFeature([Video])` in a new `VideosModule` (scaffolded here; controllers/services added in later SIs)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Enum constraint on `status`, default `status = 'draft'`, FK to `channels`, unique constraint on `storage_key`, nullable metadata/thumbnail/error fields |
| `src/database/migrations.integration-spec.ts` | Integration | Extend the existing suite's `MANAGED_TABLES` + migrations list to include `videos` and `CreateVideos` — apply/revert both work; remember the enum-drop gap fixed in the pre-existing bugfix branch applies here too (drop `videos_status_enum` in `beforeAll`) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns from the Data Model
- Inserting a row with an invalid `status` value is rejected by Postgres (enum constraint)
- Inserting two videos with the same `storage_key` is rejected (unique constraint)
- Deleting a `Channel` that owns videos is rejected by the FK (no `ON DELETE CASCADE` — matches the conservative FK style already used for `users`→`channels` in Phase 02)

---

### SI-03.3 — Storage Module (S3/MinIO Client Wrapper)

**Description:** Wrap `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` in a `StorageModule`/`StorageService` providing bucket bootstrap, multipart-upload orchestration, and presigned GET URL generation — the single point of contact between the rest of the codebase and object storage (TD-02, TD-03, TD-06).

**Technical actions:**

- Create `src/storage/storage.module.ts` — global module (`@Global()`) providing `StorageService`, injecting `storageConfig` via `ConfigType<typeof storageConfig>`
- Create `src/storage/storage.service.ts` with methods:
  - `onModuleInit()` — idempotent bucket bootstrap: `HeadBucketCommand`, on 404 `CreateBucketCommand`, swallow `BucketAlreadyOwnedByYou`/`BucketAlreadyExists`
  - `createMultipartUpload(key: string, contentType?: string): Promise<{ uploadId: string }>`
  - `presignUploadPart(key: string, uploadId: string, partNumber: number, expiresIn = 3600): Promise<string>`
  - `completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; eTag: string }[]): Promise<void>`
  - `abortMultipartUpload(key: string, uploadId: string): Promise<void>`
  - `presignGetObject(key: string, expiresIn = 3600): Promise<string>`
  - `putObject(key: string, body: Buffer, contentType: string): Promise<void>` (used by the worker to upload the generated thumbnail)
  - `getObjectStream(key: string): Promise<Readable>` (used by the worker to read the original for FFmpeg processing)
- Register `StorageModule` in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Real MinIO (per Compose): bucket bootstrap is idempotent (calling `onModuleInit()` twice does not throw); `createMultipartUpload` + `presignUploadPart` produce a URL that a real HTTP `PUT` (via `fetch`/`axios` in the test) succeeds against; `completeMultipartUpload` with the resulting ETag assembles a retrievable object; `presignGetObject` produces a URL that a real HTTP `GET` retrieves the exact bytes uploaded; a `GET` with a `Range` header against that URL returns `206 Partial Content` with the correct byte slice (proves TD-06's native streaming claim directly against real MinIO) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- On `nestjs-api` startup, the `streamtube-videos` bucket exists in MinIO (verifiable via `docker compose exec minio mc ls local` or equivalent)
- A real small buffer, uploaded through the full `createMultipartUpload` → `presignUploadPart` → real `PUT` → `completeMultipartUpload` sequence against the real MinIO service, is byte-identical when retrieved via `presignGetObject` + real `GET`
- A `Range: bytes=0-9` request against a presigned GET URL returns HTTP 206 with exactly 10 bytes

---

### SI-03.4 — Queue Module (BullMQ Producer)

**Description:** Register the BullMQ `video-processing` queue against Redis and provide a small producer service used by the upload-completion flow to enqueue processing jobs with the retry/backoff policy from TD-07.

**Technical actions:**

- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (config) => ({ connection: { host: config.redisHost, port: config.redisPort } }) })` + `BullModule.registerQueue({ name: 'video-processing' })`
- Create `src/queue/video-queue.service.ts` — `VideoQueueService.enqueueProcessing(videoId: string): Promise<void>` calling `queue.add('process-video', { videoId }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false })` (per TD-01/TD-07)
- Register `QueueModule` in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/video-queue.service.integration-spec.ts` | Integration | Real Redis (per Compose): `enqueueProcessing` actually adds a job to the `video-processing` queue, retrievable via `Queue.getJob()`, with the configured `attempts`/`backoff`/`removeOnFail` options and the correct `{ videoId }` payload |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Calling `enqueueProcessing('some-uuid')` results in a job visible in Redis under the `video-processing` queue with `data.videoId === 'some-uuid'` and `opts.attempts === 3`

---

### SI-03.5 — Video Draft Creation and Upload Session Endpoints

**Description:** Expose the endpoints that pre-register a video as a draft and drive the multipart upload handshake (TD-03): initiate a session, presign a URL per part, and abort. Ownership is enforced — only the authenticated user's own channel may create/manage its videos (TD-06's "no visibility model yet" reasoning applied uniformly).

**Technical actions:**

- Create `src/videos/dto/create-video.dto.ts` — `title: string` (required, 1-255 chars)
- Create `src/videos/dto/create-upload-session.dto.ts` — `sizeBytes: number` (required, positive, max `10 * 1024 * 1024 * 1024`), `contentType: string` (required)
- Create `src/videos/dto/video-response.dto.ts` — `id`, `channelId`, `title`, `status`, `createdAt`, `updatedAt`
- Create `src/videos/dto/upload-session-response.dto.ts` — `uploadId`, `partSize`, `partCount`
- Create domain exceptions in `src/videos/exceptions/`: `VideoNotFoundException` (404), `VideoNotOwnedException` (403), `InvalidUploadStateException` (409), `FileTooLargeException` (413), `UploadSessionNotFoundException` (404) — extend the `DomainException` base from `phase-02-auth/TD-07`
- Create `src/videos/videos.service.ts`:
  - `createDraft(channelId: string, dto: CreateVideoDto): Promise<Video>` — inserts with `status: 'draft'`, `storageKey: videos/{id}/original` (extension appended once `contentType` is known, in the next method)
  - `createUploadSession(videoId: string, channelId: string, dto: CreateUploadSessionDto)` — asserts ownership + `status === 'draft'` (else `InvalidUploadStateException`), asserts `sizeBytes <= 10GB` (else `FileTooLargeException`), computes `partSize = 100 * 1024 * 1024` (100MB) and `partCount = Math.ceil(sizeBytes / partSize)`, calls `StorageService.createMultipartUpload`, persists `uploadId`, final `storageKey` (with extension derived from `contentType`), `sizeBytes` on the video row
  - `presignUploadPart(videoId: string, channelId: string, partNumber: number): Promise<string>` — asserts ownership + an active upload session exists (else `UploadSessionNotFoundException`), delegates to `StorageService.presignUploadPart`
  - `abortUploadSession(videoId: string, channelId: string): Promise<void>` — asserts ownership, calls `StorageService.abortMultipartUpload`, clears `uploadId`/`sizeBytes` on the row, leaves `status: 'draft'` for retry
- Create `src/videos/videos.controller.ts`:
  - `POST /videos` → `createDraft`
  - `POST /videos/:id/upload-session` → `createUploadSession`
  - `POST /videos/:id/upload-session/parts/:partNumber` → `presignUploadPart`
  - `POST /videos/:id/upload-session/abort` → `abortUploadSession`
  - Resolve the caller's `channelId` from `request.user` (JWT payload) — reuse the pattern already established by Phase 02's guard (no `@Public()` on any of these routes; the global JWT guard applies by default)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Branch logic: ownership checks, `FileTooLargeException` over 10GB, `InvalidUploadStateException` when session already active, `partCount` computation for boundary sizes (exact multiple of `partSize`, off-by-one) |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + real MinIO (via `StorageService`): `createDraft` persists a `draft` row; `createUploadSession` persists `uploadId`/`storageKey`/`sizeBytes` and the returned `uploadId` is a real active MinIO multipart upload; `abortUploadSession` really aborts it (a subsequent `presignUploadPart` for the same session fails) |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` 201 with valid body, 400 on missing title; `POST /videos/:id/upload-session` 201 with valid body, 413 over 10GB, 404 for another user's video (ownership — 403 vs 404 choice: return 404 to avoid leaking existence, consistent with not revealing information per Phase 02's `INVALID_CREDENTIALS` precedent) |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` with a valid JWT and `{ title }` returns 201 with `status: 'draft'`
- `POST /videos/:id/upload-session` with `sizeBytes` at exactly 10GB succeeds; at `10GB + 1` byte returns 413
- Attempting any upload-session action on a video owned by a different channel returns 404 (never 200, never leaking the video's existence via a distinguishable 403)

---

### SI-03.6 — Upload Completion and Processing Enqueue

**Description:** Finalize the multipart upload (assembling parts via `CompleteMultipartUploadCommand`), flip the video to `processing`, and enqueue the background job — closing the loop between TD-03 (upload) and TD-01/TD-07 (queue + status).

**Technical actions:**

- Create `src/videos/dto/complete-upload-session.dto.ts` — `parts: { partNumber: number; eTag: string }[]` (required, non-empty array, each part validated via nested `class-validator` decorators)
- Extend `VideosService` with `completeUploadSession(videoId: string, channelId: string, dto: CompleteUploadSessionDto): Promise<Video>` — asserts ownership + active session, calls `StorageService.completeMultipartUpload`, sets `status: 'processing'`, saves, then calls `VideoQueueService.enqueueProcessing(videoId)` — wrap the storage-complete + DB-update + enqueue sequence so a failure after the storage call still leaves the video in a recoverable state (log + rethrow; the row stays `processing`-eligible for a manual retry, since actual thumbnail/metadata processing hasn't started)
- Add `POST /videos/:id/upload-session/complete` to `VideosController`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.integration-spec.ts` | Integration | Extend from SI-03.5: a full real multipart upload (init → presign parts → real HTTP `PUT` of a small fixture buffer to each presigned part URL → `completeUploadSession` with the real ETags) leaves the video row `status: 'processing'` AND enqueues a real job on the `video-processing` Redis queue (assert via `Queue.getJob`) |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:id/upload-session/complete` 200 with `status: 'processing'` given a real prior upload; 409 if called on a `draft` video with no active session |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- Completing a real multipart upload (small fixture) results in a retrievable object in MinIO at the video's `storage_key` AND a job on the `video-processing` queue with the matching `videoId`
- The video row's `status` is `processing` immediately after completion, before any worker has run

---

### SI-03.7 — Video Worker Bootstrap

**Description:** Stand up the separate worker process (TD-04) — a NestJS application context (no HTTP listener) that registers the `video-processing` BullMQ consumer, sharing the `Video` entity, `StorageModule`, and `QueueModule` with the API.

**Technical actions:**

- Create `src/videos/worker/worker.module.ts` — imports `ConfigModule` (global, per Phase 01 convention), `TypeOrmModule.forRootAsync` (same factory as `AppModule`), `TypeOrmModule.forFeature([Video])`, `StorageModule`, `BullModule.forRootAsync` + `BullModule.registerQueue({ name: 'video-processing' })` (consumer side — same queue name, same Redis connection as the producer), and `VideoProcessor` as a provider
- Create `src/videos/worker/video.processor.ts` — `@Processor('video-processing') export class VideoProcessor extends WorkerHost { async process(job: Job<{ videoId: string }>): Promise<void> { /* full logic added in SI-03.8 */ } }` (this SI: skeleton that logs receipt only, proving wiring)
- Create `src/videos/worker/main-worker.ts` — `NestFactory.createApplicationContext(WorkerModule, { logger: [...] })`, no `app.listen()`
- Wire the `start:worker`/`start:worker:dev` npm scripts (declared in SI-03.1) to this entry file

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/worker/worker.module.spec.ts` | Unit | Module compiles successfully with `TypeOrmModule`, `BullModule`, `StorageModule`, and `VideoProcessor` wired (DI resolution) |
| `src/videos/worker/video.processor.integration-spec.ts` | Integration | Real Redis: enqueuing a job via `VideoQueueService` (from the API side) results in the worker's `VideoProcessor.process()` actually being invoked with the correct payload — boot the `WorkerModule` application context in the test, enqueue, and await a spy/event assertion (`@OnWorkerEvent('completed')`) |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `docker compose exec video-worker npm run start:worker` (or the container's own startup) connects to Redis and Postgres without error
- A job enqueued by the API is picked up and `process()` is invoked exactly once (no duplicate consumption)

---

### SI-03.8 — Metadata Extraction, Thumbnail Generation, and Status Lifecycle

**Description:** Implement the worker's actual job: extract duration/resolution/codec/bitrate via `mediaforge`'s FFmpeg wrapper, generate a thumbnail frame, persist both plus the terminal `ready` status — or, after retries are exhausted, persist `failed` with an error message (TD-05, TD-07).

**Technical actions:**

- Install FFmpeg in the worker's Dockerfile: extend `Dockerfile.dev` (or add a worker-specific stage) with `RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*` (TD-05 — apt-installed, not bundled)
- Implement `VideoProcessor.process(job)`:
  1. Load the `Video` row by `job.data.videoId`
  2. Stream the original object from storage (`StorageService.getObjectStream`) to a temp file under `/tmp/{videoId}-original{ext}`
  3. `probeAsync(tempFilePath)` → `getMediaDuration`, `getDefaultVideoStream` + `summarizeVideoStream` → `{ durationSeconds, width, height, codec, bitrate }`
  4. `frameToBuffer(tempFilePath, { timestamp: '00:00:01', format: 'jpeg', size: '640x360' })` → thumbnail buffer (fall back to `timestamp: '00:00:00'` when `durationSeconds < 1`)
  5. `StorageService.putObject(thumbnailKey, thumbnailBuffer, 'image/jpeg')` where `thumbnailKey = videos/{videoId}/thumbnail.jpg`
  6. Update the `Video` row: `status: 'ready'`, `durationSeconds`, `width`, `height`, `codec`, `bitrate`, `thumbnailKey`
  7. `finally`: delete the temp file
- Add `@OnWorkerEvent('failed')` handler on `VideoProcessor`: when `job.attemptsMade >= (job.opts.attempts ?? 1)` (i.e., this was the last attempt), update the `Video` row to `status: 'failed'`, `errorMessage: <the error's message, truncated to 1000 chars>`. Do not touch the row on intermediate (non-final) attempt failures — BullMQ's own backoff/retry handles those, and the row should stay `processing` while retries are in flight (avoids a client observing a spurious `failed` flash before a successful retry)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/worker/video.processor.integration-spec.ts` | Integration | Extend from SI-03.7 with the full pipeline: a committed tiny fixture video (`src/videos/worker/fixtures/sample.mp4`, ~1 second, ~50KB) run through a real enqueue → real worker processing (real FFmpeg, real MinIO) → asserts the `Video` row reaches `status: 'ready'` with correct `durationSeconds` (≈1) and a retrievable JPEG thumbnail object in MinIO at `thumbnailKey`. A second test uses a corrupt/non-video fixture (e.g., a `.txt` file renamed `.mp4`) with the job's `attempts` overridden to `1` in test config, asserting the row reaches `status: 'failed'` with a non-empty `errorMessage` after the single attempt exhausts |

**Dependencies:** SI-03.7, SI-03.6

**Acceptance criteria:**

- Processing the committed sample fixture end-to-end (real Redis, real MinIO, real FFmpeg) leaves the video `ready` with `durationSeconds`, `width`, `height`, `codec` populated and a retrievable thumbnail JPEG in storage
- Processing a corrupt/invalid file leaves the video `failed` with `errorMessage` populated after retries are exhausted, and `status` never flips to `ready`

---

### SI-03.9 — Video Detail and Playback URL Endpoints

**Description:** Expose read access to a video's current status/metadata and the on-demand presigned playback URL that serves both streaming (Range/206) and download (TD-06).

**Technical actions:**

- Extend `VideosService` with:
  - `findOwnedById(videoId: string, channelId: string): Promise<Video>` — asserts ownership (404 if not owner or not found, same non-leaking behavior as SI-03.5)
  - `getPlaybackUrl(videoId: string, channelId: string): Promise<string>` — asserts ownership + `status === 'ready'` (else `InvalidUploadStateException` — a draft/processing/failed video has nothing playable yet), delegates to `StorageService.presignGetObject(video.storageKey)`
- Add to `VideosController`:
  - `GET /videos/:id` → `findOwnedById`, mapped through `VideoResponseDto` (extended with `durationSeconds`, `width`, `height`, `thumbnailKey`, `errorMessage`)
  - `GET /videos/:id/playback-url` → `getPlaybackUrl`, response `{ url: string, expiresIn: number }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Extend from SI-03.5: `getPlaybackUrl` rejects when `status !== 'ready'` |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:id` 200 with full metadata for a `ready` video, 404 for another user's video; `GET /videos/:id/playback-url` 200 with a `url` for a `ready` video, 409 for a `draft`/`processing`/`failed` video; the returned `url`, fetched directly with a real HTTP `GET` (no `Range` header), returns the full file (download); fetched with `Range: bytes=0-99` returns 206 with exactly 100 bytes (streaming) |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- A `ready` video's playback URL, requested twice, returns two valid (possibly different) presigned URLs — each independently retrieves the full file
- A `Range` request against the playback URL returns 206 Partial Content with the correct byte slice — proves streaming without full download works end-to-end through the real API + real MinIO

---

### SI-03.10 — Full-Flow E2E Test

**Description:** A single end-to-end test exercising the entire Phase 03 deliverable in sequence against real infrastructure: register/login (reusing Phase 02 fixtures) → create draft → full multipart upload of the committed sample fixture → complete → worker processes it for real → fetch playback URL → verify streaming (206) and download (200 full body) → verify thumbnail exists.

**Technical actions:**

- Create `test/videos-full-flow.e2e-spec.ts`: boots both the API's `AppModule` (via `Test.createTestingModule` + `supertest`, per the project's existing E2E pattern) and the `WorkerModule` application context (per SI-03.7's pattern) in the same test process so the real worker actually consumes from the real Redis queue during the test
- Sequence: authenticate a test user (registration + confirmation fixtures from Phase 02) → `POST /videos` → `POST /videos/:id/upload-session` with the sample fixture's real size → real `PUT` of each part to the presigned URLs → `POST /videos/:id/upload-session/complete` → poll `GET /videos/:id` until `status` leaves `processing` (bounded retry loop, test timeout generous enough for real FFmpeg processing) → assert `status === 'ready'` → `GET /videos/:id/playback-url` → real `GET` (full download, byte-count assertion) and real `GET` with `Range` header (206 assertion)

**Dependencies:** SI-03.6, SI-03.8, SI-03.9

**Acceptance criteria:**

- The full test passes against real Docker Compose infrastructure (Postgres, Redis, MinIO, real FFmpeg) with zero mocks on the upload/processing/streaming path
- The test is deterministic (bounded polling with a generous but finite timeout — never an unbounded wait) so it fits in the standard `npm run test:e2e` run without flaking

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| channel_id | uuid | FK → channels.id, not null | Owning channel; no cascade delete (matches Phase 02's conservative FK style) |
| title | varchar(255) | not null | |
| status | enum | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | PostgreSQL enum type `videos_status_enum` (TD-07) |
| storage_key | varchar | unique, nullable | Set once the upload session determines the file extension (TD-02); `videos/{id}/original.{ext}` |
| thumbnail_key | varchar | nullable | Set by the worker on successful processing; `videos/{id}/thumbnail.jpg` |
| upload_id | varchar | nullable | Active S3/MinIO multipart `UploadId`; cleared on complete or abort (TD-03) |
| size_bytes | bigint | nullable | Declared at upload-session creation; ≤ 10GB enforced at the service layer |
| duration_seconds | integer | nullable | Populated by the worker via `mediaforge` probe (TD-05) |
| width | integer | nullable | |
| height | integer | nullable | |
| codec | varchar | nullable | |
| bitrate | integer | nullable | |
| error_message | text | nullable | Populated only when `status = 'failed'` (TD-07) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one)
**Indexes:** `(storage_key)` — unique, `(channel_id)` — FK

---

### API Contracts

#### POST /videos (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- title: string, required — 1-255 characters

**Response 201:**
- id: string (uuid)
- channelId: string (uuid)
- title: string
- status: string (`"draft"`)
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**Error responses:**
- 400 validation error: when `title` is missing or out of length bounds
- 401: when the access token is missing or invalid

---

#### POST /videos/:id/upload-session (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- sizeBytes: number, required — positive, max `10737418240` (10GB)
- contentType: string, required

**Response 201:**
- uploadId: string
- partSize: number (bytes; server-computed, currently `104857600` = 100MB)
- partCount: number

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or is not owned by the caller
- 409 INVALID_UPLOAD_STATE: video is not in `draft` status
- 413 FILE_TOO_LARGE: `sizeBytes` exceeds 10GB
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:id/upload-session/parts/:partNumber (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned `PUT` URL for this part
- expiresIn: number (seconds)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 404 UPLOAD_SESSION_NOT_FOUND: no active upload session for this video

---

#### POST /videos/:id/upload-session/abort (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 404 UPLOAD_SESSION_NOT_FOUND

---

#### POST /videos/:id/upload-session/complete (SI-03.6)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required, non-empty — each item: `{ partNumber: number, eTag: string }`

**Response 200:**
- id: string (uuid)
- status: string (`"processing"`)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 404 UPLOAD_SESSION_NOT_FOUND
- 409 INVALID_UPLOAD_STATE: no active session, or video not in `draft`/an already-completed session
- 400 validation error: when `parts` is missing, empty, or malformed

---

#### GET /videos/:id (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id, channelId, title, status: as above
- durationSeconds: number | null
- width: number | null
- height: number | null
- thumbnailKey: string | null
- errorMessage: string | null
- createdAt, updatedAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: not found or not owned by the caller

---

#### GET /videos/:id/playback-url (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned `GET` URL (supports `Range` requests natively for streaming; a plain `GET` with no `Range` header downloads the full file)
- expiresIn: number (seconds)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 INVALID_UPLOAD_STATE: video is not `ready` yet

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|---------------|-------|
| POST /videos | | ✓ | Channel resolved from JWT; caller always creates for their own channel |
| POST /videos/:id/upload-session | | ✓ | Ownership enforced — 404 (not 403) for non-owned videos |
| POST /videos/:id/upload-session/parts/:partNumber | | ✓ | Ownership enforced |
| POST /videos/:id/upload-session/abort | | ✓ | Ownership enforced |
| POST /videos/:id/upload-session/complete | | ✓ | Ownership enforced |
| GET /videos/:id | | ✓ | Ownership enforced — no public/unlisted visibility model exists yet (deferred to Fase 04 per TD-06) |
| GET /videos/:id/playback-url | | ✓ | Ownership enforced — same rationale as above |

---

### Error Catalog

**Error response format:** inherited from `phase-02-auth/TD-07` — unchanged: `{ statusCode: number, error: string, message: string }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any video endpoint referencing a video ID that doesn't exist or isn't owned by the caller |
| INVALID_UPLOAD_STATE | 409 | Invalid upload state for this operation | Upload-session actions attempted out of order (e.g., completing with no active session, initiating a session on a non-draft video) or playback-url requested before `status: ready` |
| FILE_TOO_LARGE | 413 | File exceeds the 10GB upload limit | `POST /videos/:id/upload-session` with `sizeBytes` over `10737418240` |
| UPLOAD_SESSION_NOT_FOUND | 404 | No active upload session for this video | Part-presign or complete/abort actions when `upload_id` is null |

---

### Events/Messages

**Queue:** `video-processing` (BullMQ, Redis-backed — TD-01)

**Job:** `process-video`

**Payload:**
```json
{ "videoId": "string (uuid)" }
```

**Producer:** `VideoQueueService.enqueueProcessing(videoId)`, called by `VideosService.completeUploadSession` immediately after a successful `CompleteMultipartUploadCommand` (SI-03.6).

**Job options:** `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: false` (TD-07 — failed jobs are kept for inspection; the terminal DB status carries the user-facing signal, not the queue itself).

**Consumer:** `VideoProcessor` (`@Processor('video-processing')`, extends `WorkerHost`) in the separate `video-worker` container (TD-04). On success: updates the `Video` row to `status: 'ready'` with extracted metadata + thumbnail key (SI-03.8). On final failure (`@OnWorkerEvent('failed')`, `job.attemptsMade >= attempts`): updates the `Video` row to `status: 'failed'` with `errorMessage` (SI-03.8, TD-07).

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.3
└── SI-03.4

SI-03.2 + SI-03.3
└── SI-03.5
    └── SI-03.6 (also needs SI-03.4)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.7
    └── SI-03.8 (also needs SI-03.6)

SI-03.2 + SI-03.3
└── SI-03.9

SI-03.6 + SI-03.8 + SI-03.9
└── SI-03.10
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5, SI-03.7, SI-03.9 (parallel, each only needs its own listed deps) → SI-03.6 → SI-03.8 → SI-03.10

## Deliverables

- [ ] Video pre-registered as `draft` automatically when upload starts (`POST /videos`)
- [ ] Upload of files up to 10GB via S3/MinIO multipart + presigned URLs — bytes never transit the API process
- [ ] Automatic processing after upload completion: duration, resolution, codec, bitrate extraction via `mediaforge`/FFmpeg
- [ ] Automatic thumbnail generation from a video frame
- [ ] Unique per-video storage key and on-demand presigned playback URL, no collisions
- [ ] Streaming via native S3/MinIO Range/206 support — no custom proxy code in the API
- [ ] Download via the same playback URL (full `GET`, no `Range` header)
- [ ] Status lifecycle `draft → processing → ready|failed` persisted on the `videos` table, with BullMQ retry/backoff and a stored error message on terminal failure
- [ ] MinIO, Redis, and a separate `video-worker` container all running via `docker compose up -d`
- [ ] `videos` table migration applies and reverts cleanly
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`), including the real multipart-upload-to-processing-to-streaming full-flow test
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
