# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/10 completed

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
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.4 — Queue Module (BullMQ Producer)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — Video Draft Creation and Upload Session Endpoints
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.6 — Upload Completion and Processing Enqueue
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.7 — Video Worker Bootstrap
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — Metadata Extraction, Thumbnail Generation, and Status Lifecycle
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Video Detail and Playback URL Endpoints
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Full-Flow E2E Test
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
