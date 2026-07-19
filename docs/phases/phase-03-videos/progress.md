# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 8/10 completed

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - `video-worker` service shares `Dockerfile.dev`'s content via a new sibling `Dockerfile.worker.dev` (not the same file) so FFmpeg (added in SI-03.8) never bloats the API image — the two files are identical until SI-03.8 diverges them.
  - `redis-cli` isn't installed in the `nestjs-api`/`video-worker` images (only `procps`+`curl` per `Dockerfile.dev`); Redis reachability was verified via the `redis` service's own compose healthcheck instead of exec'ing into another container.
  - Extended the pre-existing `env.validation.integration-spec.ts`'s `requiredEnv` baseline with the new required storage vars — those tests validate unrelated defaults (`SWAGGER_ENABLED`) against a baseline object, which broke once `STORAGE_ENDPOINT`/`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` became required.
  - `video-worker`'s compose command (`npm run start:worker:dev`) references a worker entry file that doesn't exist until SI-03.7 — expected per the plan; the container will fail to start in the interim.

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** 8 passing (video.entity.integration-spec.ts: 6, migrations.integration-spec.ts: 2)
- **Observations:**
  - `size_bytes` is a `bigint` column, mapped by TypeORM to a TypeScript `string` (not `number`) to avoid precision loss above 2^53 — declared as `string | null` on the entity.
  - Found and fixed a real (not test-order) bug in `migrations.integration-spec.ts`'s `beforeAll`: dropping the 5 managed tables via `Promise.all` occasionally deadlocks in Postgres once an FK-related table (`videos` → `channels`) is in the mix — serialized the drops into a sequential loop instead.
  - Updated `cleanAllTables` in `create-test-data-source.ts` to also truncate `videos` (before `channels`, respecting the FK).

### SI-03.3 — Storage Module (S3/MinIO Client Wrapper)
- **Status:** completed
- **Tests:** 5 passing (storage.service.integration-spec.ts) — real MinIO, no mocks
- **Observations:**
  - Verified the 206 Partial Content / Range claim directly: a real `fetch` with `Range: bytes=0-2` against a presigned GET URL returns 206 with the exact byte slice — no custom code needed, confirming TD-06's premise before building on it in SI-03.9.
  - `StorageModule` is `@Global()` so `VideosModule`, the upload endpoints, and the worker (SI-03.7/08) can all inject `StorageService` without each importing `StorageModule` explicitly.

### SI-03.4 — Queue Module (BullMQ Producer)
- **Status:** completed
- **Tests:** 1 passing (video-queue.service.integration-spec.ts) — real Redis
- **Observations:**
  - Hit a real circular-import bug: the queue-name constant was originally declared and exported from `queue.module.ts`, which imports `VideoQueueService`, which imported the constant back from `queue.module.ts`. The circular reference left `@InjectQueue(VIDEO_PROCESSING_QUEUE)` evaluating against `undefined` at class-decoration time, producing a "can't resolve dependency BullQueue_default" error with no compile-time signal. Fixed by extracting the constant into its own `queue.constants.ts` (matches the project's established `<module>.constants.ts` convention).
  - Added `module.close()` in the test's `afterAll` (was missing) — without it, BullMQ's Redis connections linger past the test run and Jest warns about open handles.

### SI-03.5 — Video Draft Creation and Upload Session Endpoints
- **Status:** completed
- **Tests:** 23 passing (videos.service.spec.ts: 10 unit, videos.service.integration-spec.ts: 6 integration real DB+MinIO, videos.e2e-spec.ts: 7 e2e)
- **Observations:**
  - Added `ChannelsService.findByUserId(userId)` — no such lookup existed; needed to resolve the caller's `channelId` from the JWT payload (`{ sub, email }` only, no `channelId`).
  - Non-owned video access returns 404 (not 403) uniformly, matching `INVALID_CREDENTIALS`'s existing non-leaking precedent from Phase 02 — the video's existence is never revealed to a non-owner.
  - `sizeBytes` upper-bound (10GB) is enforced in the service, not via a DTO `@Max` decorator — a DTO-level max would trigger the generic 400 `VALIDATION_ERROR` instead of the plan's distinct 413 `FILE_TOO_LARGE`.
  - Real regression caught by the new e2e file: `npm run test:e2e` doesn't pass `--runInBand` in the npm script itself (only documented as a manual flag), and with `videos.e2e-spec.ts` now sharing `users`/`channels` tables with `auth.e2e-spec.ts`, the two files' processes raced on `cleanAllTables`, causing a real FK violation. Fixed by baking `--runInBand` into the `test:e2e` script so `npm run test:e2e` is correct standalone, per the project's own documented e2e/integration constraint.

### SI-03.6 — Upload Completion and Processing Enqueue
- **Status:** completed
- **Tests:** 10 passing (videos.service.integration-spec.ts: +2, videos.e2e-spec.ts: +2, plus the 6 already-existing videos.service.spec.ts unit tests continued passing after adding the VideoQueueService mock)
- **Observations:**
  - Plan specified `200` (not the `201` used by the other POST endpoints) for this response — matched via explicit `@HttpCode(HttpStatus.OK)`.
  - `QueueModule` had to be explicitly imported into `VideosModule` even though both already sit under `AppModule` — NestJS doesn't share providers between sibling modules without an explicit import (unless `@Global()`), and `QueueModule` is deliberately not global.
  - Integration test proves the full real chain end-to-end: real MinIO multipart completion, real DB status flip, real BullMQ job enqueued, and the assembled object retrievable byte-for-byte from storage — all in one test, no mocks.

### SI-03.7 — Video Worker Bootstrap
- **Status:** completed
- **Tests:** 2 passing (worker.module.spec.ts: compilation, video.processor.integration-spec.ts: real Redis job pickup)
- **Observations:**
  - `Video`'s relation graph requires `Channel` AND `User` both registered via `TypeOrmModule.forFeature` in `WorkerModule` (not just `Video`) — TypeORM builds full entity metadata eagerly at `DataSource.initialize()`, including inverse relations, regardless of whether the worker's code ever traverses them.
  - Real debugging finding: `Test.createTestingModule({...}).compile()` alone does **not** run `onModuleInit`/`onApplicationBootstrap` lifecycle hooks — `@nestjs/bullmq`'s `WorkerHost` only starts its internal BullMQ `Worker` in `onModuleInit` (via an internal `BullRegistrar`), so tests booting a module in isolation (not via `app.init()`/`createNestApplication()`) must call `await module.init()` explicitly or the worker never starts.
  - `jest.spyOn(processor, 'process')` cannot observe job execution: `@nestjs/bullmq`'s explorer does `instance.process.bind(instance)` once at Worker-registration time, capturing the original method — a later `spyOn` reassignment on the instance is invisible to that captured reference. Verified via a raw BullMQ script that the job really was completing while the spy-based test still timed out.
  - `removeOnComplete: true` (TD-07) deletes the job from Redis the instant it completes — polling `queue.getJobs()`/`job.getState()` afterward finds nothing even on success. The correct test observes completion via the worker's own `'completed'` event, not by re-querying job state.
  - Verified the real `video-worker` Compose service end-to-end (not just in Jest): built, started, connected to the real `db`/`redis`/`minio` services, and picked up a job left over from testing — confirmed via `docker compose logs video-worker`.

### SI-03.8 — Metadata Extraction, Thumbnail Generation, and Status Lifecycle
- **Status:** completed
- **Tests:** 2 passing (video.processor.integration-spec.ts) — real FFmpeg, real MinIO, a committed ~17KB 1s H.264 fixture (`fixtures/sample.mp4`, generated via `ffmpeg -f lavfi testsrc`) plus a corrupt-file fixture (`fixtures/corrupt.mp4`) for the failure path
- **Observations:**
  - `mediaforge`'s actual exports differ from what `library-refs.md` assumed: `frameToBuffer` takes a single options object `{ input, timestamp, format, size }` (not positional args), and `format` only accepts `'png' | 'mjpeg' | 'bmp'` — no `'jpeg'`. Switched the thumbnail to PNG (`thumbnail.png`, not `.jpg`) and updated `library-refs.md` accordingly. `getMediaDuration`/`getDefaultVideoStream`/`summarizeVideoStream` do exist as documented, re-exported from `mediaforge`'s top-level `index.d.ts`.
  - Real bug caught by the fixture test: seeking a frame at exactly `timestamp = duration` (e.g. `t=1` on a 1-second video) returns an **empty buffer with no thrown error** — ffmpeg silently produces nothing past the last valid frame. Fixed by clamping the thumbnail timestamp strictly inside `[0, duration)` (`min(1, duration - 0.1)`, floored at 0) instead of a naive `duration < 1 ? 0 : 1` check.
  - `removeOnComplete: true` means a job vanishes from Redis the instant it succeeds — the success-path test observes completion via the worker's `'completed'` event; the failure-path test (which sets `removeOnFail: false`) can safely poll `videoRepository` for `status: 'failed'` instead, since `@OnWorkerEvent('failed')`'s async DB update isn't awaited by BullMQ's own event emission.
  - Root-caused a confusing intermittent timeout: multiple **leftover `jest` processes from earlier debugging sessions** (never cleanly terminated) were still connected to the real Redis queue as competing consumers, silently stealing jobs from the test's own worker instance before it could observe its `'completed'` event. Diagnosed by comparing "direct `processor.process()` call → instant success" against "same job through the real queue → timeout with no error," which only made sense once multiple live consumers were confirmed via `ps aux` across containers. Not a product bug — an artifact of a long debugging session; resolved by killing the zombies and obliterating the queue before re-testing. Tests themselves need no special handling for this (a fresh environment doesn't have zombie processes).
  - FFmpeg/ffprobe binaries verified present and working inside the rebuilt `video-worker` image (`Dockerfile.worker.dev`); the real Compose service was built, started, and confirmed processing jobs end-to-end via `docker compose logs`.

### SI-03.9 — Video Detail and Playback URL Endpoints
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Full-Flow E2E Test
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
