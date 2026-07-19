---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-19
scope_description: "Video upload and processing pipeline: background job queue, object storage SDK/key layout, large-file (10GB) upload strategy, video worker execution model, metadata/thumbnail extraction via FFmpeg, unique playback URL + streaming strategy, and processing status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module, the migration for the videos table, the queue/worker infrastructure in `compose.yaml`, and all TDs below.
- `next-frontend/` — out of scope for this phase per the phase brief ("Há um frontend no repositório, mas a interface de vídeo não faz parte do escopo desta fase"). No TD in this document.

**Fixed by prior architecture (not open decisions):** the C4 diagram (`docs/diagrams/software-arch.mermaid`) already commits to `Rel(frontend, storage, "Streams", "HTTPS")` — playback streams directly from Object Storage, not proxied through the API — and to Object Storage being S3-compatible (S3/MinIO). These constraints shape TD-06 below but are not re-litigated.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` leaves the queue technology explicitly "TBD" in the architecture diagram. The API must enqueue a video-processing job after upload completion; a worker consumes it asynchronously. The choice affects new infrastructure in `compose.yaml`, the NestJS producer/consumer library, and delivery/retry guarantees.

**Options:**

### Option A: BullMQ + Redis
- Redis-backed job queue with an official first-class NestJS integration (`@nestjs/bullmq`). Supports retries with backoff, delayed jobs, job progress, concurrency control, and a built-in dashboard (Bull Board) for observability.
- **Pros:** Official NestJS docs recommend it for exactly this use case ("Queues" chapter uses a video-transcoding example). Node-only stack — no second protocol/client library to learn. Redis is trivial to add to `compose.yaml` (single official image, no cluster setup needed at this scale). Retry/backoff and dead-letter handling are built in.
- **Cons:** Redis is in-memory — job durability depends on AUOF/RDB persistence config. Yet another datastore in `compose.yaml` (with Postgres already present). No cross-language interoperability if a future worker were written in another stack.

### Option B: RabbitMQ (amqplib / `@nestjs/microservices` RMQ transport)
- AMQP 0-9-1 broker with official NestJS microservices transport (`@nestjs/microservices`). Exchanges/queues/routing keys give full control over topology; message acknowledgment is protocol-level.
- **Pros:** Protocol-based — any language can produce/consume, useful if the worker or future services move to a different stack. Mature broker with strong delivery guarantees and management UI. Decouples producer/consumer more strictly than a library-level queue.
- **Cons:** Heavier operational surface (routing keys, exchanges, bindings) for a single job type (video processing) with no current multi-language requirement. NestJS's RMQ transport is designed around request/response microservices, not job queues with retry/backoff/progress — those need to be hand-rolled. More Docker/compose complexity for no current benefit.

### Option C: Managed cloud queue (SQS-compatible)
- Use a managed queue service (AWS SQS or a local SQS-compatible emulator like ElasticMQ) so the same code targets a managed service in production.
- **Pros:** No broker to operate; production scaling is someone else's problem. Consistent with the "S3-compatible" pattern already chosen for storage (local emulator, real service in prod).
- **Cons:** Requires an extra emulator container for local dev with imperfect fidelity to the real service (unlike MinIO, which is the *actual* S3-compatible implementation, not an emulator). No official NestJS integration — more custom polling/ack code. Weaker DX for retries/backoff/observability compared to BullMQ.

**Recommendation:** **Option A (BullMQ + Redis)** — the project is Node-only end to end, NestJS's own documentation uses a video-processing job as its canonical BullMQ example, and Redis is a one-line addition to `compose.yaml` with an official maintained image. Retry/backoff/dead-letter and progress tracking are needed for TD-07's failure handling and come built in, avoiding hand-rolled protocol code that RabbitMQ or an SQS emulator would require for the same guarantees.

**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Object Storage SDK & Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The object storage service itself is fixed (S3-compatible, MinIO locally). What remains open is the client library used to talk to it, and how buckets/keys are organized so that production can swap MinIO for real S3 by changing only configuration (per the phase brief).

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- Official AWS SDK v3, modular per-service packages. Points at MinIO by setting a custom `endpoint` + `forcePathStyle: true`; the exact same client code targets real AWS S3 in production by removing those two options.
- **Pros:** The industry-standard client for anything S3-compatible — MinIO's own docs recommend it for app code (vs. `minio-js`, which is MinIO's own admin/bucket-management SDK). Zero code change to go from MinIO to real S3 in production — only the config namespace (`storage.config.ts`, already anticipated in Phase 01's decisions) changes. Presigned URLs (GET/PUT, single and multipart) are first-class via `s3-request-presigner`.
- **Cons:** Modular v3 packages mean pulling in a few separate npm packages (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) instead of one.

### Option B: `minio` (official MinIO JS SDK)
- MinIO's own client library, with convenience methods (`presignedPutObject`, `presignedGetObject`, bucket policies) tailored to MinIO's API surface.
- **Pros:** Simple, purpose-built API for MinIO; slightly less boilerplate for basic presigned URL generation.
- **Cons:** Framed by MinIO as the SDK for *managing* MinIO (buckets, policies, admin), not the general-purpose app SDK — MinIO's own docs point app developers to AWS SDK v3 for S3-compatible object operations. Switching to real AWS S3 in production would mean swapping the client library, not just the endpoint config — directly against the phase brief's "trocaria por S3 em produção" requirement.

**Recommendation:** **Option A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)** — it is the only option that lets production swap MinIO for real S3 by changing configuration alone (a new `storage.config.ts` namespace following Phase 01's `registerAs` convention), with no code change. Bucket/key layout: a single bucket (e.g. `streamtube-videos`) with per-video prefixes `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg` — the video's own UUID primary key guarantees key uniqueness (feeds TD-06) without a second identifier scheme.

**Decision:** A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Large File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Passing a 10GB file through the NestJS API (buffering or even streaming it through a single Express request) ties up an API connection/worker for the full upload duration and risks memory/timeout issues — explicitly called out as the wrong approach in the phase brief. A single S3-compatible presigned PUT URL is also capped at 5GB, below the 10GB requirement, so any single-request presigned upload is disqualified outright.

**Options:**

### Option A: S3 Multipart Upload with per-part presigned URLs
- API creates the video as a draft and calls `CreateMultipartUpload`, then issues a presigned URL per part (client requests one part at a time or a batch of presigned URLs up front). Client PUTs each part (5MB–5GB each, up to 10,000 parts) directly to storage; API finalizes with `CompleteMultipartUpload` once all parts + ETags are reported back.
- **Pros:** The only presigned-URL approach that supports files above 5GB (parts up to 5GB, total up to 5TB) — meets the 10GB requirement directly. Bytes never transit the API process — no memory/timeout impact regardless of file size. Native to S3/MinIO, no extra protocol or server component. Resumable in principle (failed parts can be retried/re-uploaded individually).
- **Cons:** More moving parts than a single PUT — API must track upload ID + part ETags, client must upload parts in order and report them back. No built-in pause/resume UI logic (that's a frontend concern, out of scope this phase).

### Option B: Streamed proxy upload through the API (busboy/multer streaming to storage)
- Client sends the file as a multipart/form-data POST to the API; the API streams the incoming bytes directly to storage (never buffering to disk) using a streaming body in the `PutObject` call.
- **Pros:** Single endpoint, simpler client contract (one POST). No presigned URL orchestration.
- **Cons:** The upload still occupies one API request/connection for the entire 10GB transfer — exactly the "impact on API performance" the phase brief warns against, since API resources (connections, request timeout limits, worker threads under load) are tied up regardless of not buffering to memory. Doesn't compose with resumability if the connection drops mid-transfer for a 10GB file.

### Option C: tus resumable upload protocol
- Open protocol for resumable uploads (`tus-node-server` or similar), with the server storing upload offsets and allowing clients to resume after interruption.
- **Pros:** Purpose-built for resumability over unreliable networks — most robust UX for very large files.
- **Cons:** Adds a whole new protocol/server component and dependency the stack doesn't otherwise need; bytes would still transit a tus server process (self-hosted) unless paired with an S3 storage backend for tus (extra integration layer). No frontend in this phase to consume the resumable semantics, so the main benefit (client-side resume) can't be exercised or verified yet — resumability would sit unused until Phase 04+.

**Recommendation:** **Option A (S3 Multipart Upload with per-part presigned URLs)** — it is the only option that both satisfies the 10GB requirement (above the single-PUT 5GB ceiling) and keeps bytes off the API process entirely. Flow: `POST /videos` pre-registers the video as `draft` and returns a video ID + multipart upload ID + presigned part URLs; the caller PUTs parts directly to storage; `POST /videos/:id/complete-upload` reports part ETags, calls `CompleteMultipartUpload`, flips status to `processing`, and enqueues the TD-01 job.

**Decision:** A (S3 Multipart Upload with per-part presigned URLs)

---

## TD-04: Video Worker Execution Model

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The architecture diagram models the Video Worker as its own container, separate from the API. The queue library (TD-01) runs in Node either way; what's open is whether the worker is a wholly separate application/package or the same NestJS codebase bootstrapped differently, and how it ships as its own container in `compose.yaml`.

**Options:**

### Option A: Same NestJS project, separate bootstrap + separate container
- The worker lives inside `nestjs-project/src/` (e.g. `src/videos/worker/main-worker.ts`), reusing the same `VideosModule`, TypeORM entities, and `storage.config.ts`/`queue.config.ts` as the API, but is bootstrapped via `NestFactory.createApplicationContext()` (no HTTP listener) registering only the BullMQ processor. Ships as a second `compose.yaml` service built from the same image/Dockerfile with a different start command.
- **Pros:** Zero duplication of the `Video` entity, repositories, or config — the worker and API share a single source of truth for the data model. One `npm install`/build pipeline. Still a genuinely separate container/process per the architecture diagram (independent scaling, crash isolation from the API).
- **Cons:** A build/deploy change to the worker (e.g. a new dependency) rebuilds the whole shared image, even if the API itself didn't change.

### Option B: Fully separate application/package (own `package.json`)
- A new top-level directory (e.g. `video-worker/`) with its own `package.json`, own copy/duplicate of the `Video` entity (or a shared internal package), and its own Dockerfile.
- **Pros:** Maximum isolation — the worker's dependency tree (FFmpeg wrapper, BullMQ) never touches the API's `node_modules`.
- **Cons:** Duplicates the `Video` entity/DTOs (or forces a shared internal package, adding monorepo tooling complexity this project doesn't have yet). Two `package.json`/lockfiles to keep in sync for the same domain model. Disproportionate for a single background job type at this project's current size.

**Recommendation:** **Option A (same NestJS project, separate bootstrap + separate container)** — the worker and API must agree on the exact same `Video` entity/status enum (TD-07) and storage key layout (TD-02); duplicating that across a second package is a consistency risk for no isolation benefit this project needs yet. `compose.yaml` gets a `video-worker` service built from the same `Dockerfile.dev`, running `node dist/videos/worker/main-worker.js` (or the dev equivalent) instead of `nest start`.

**Decision:** A (Same NestJS project, separate bootstrap + separate container)

---

## TD-05: Video Metadata Extraction & Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture diagram names FFmpeg explicitly as the Video Worker's processing engine. Open questions: which Node wrapper drives FFmpeg, and how the `ffmpeg`/`ffprobe` binaries themselves get into the worker container.

**Options:**

### Option A: `fluent-ffmpeg` + system-installed FFmpeg (apt, in the worker's Dockerfile)
- `fluent-ffmpeg` wraps `ffmpeg`/`ffprobe` child-process invocation with a fluent JS API (`.ffprobe()` for metadata, `.screenshots()` for thumbnails). The binaries are installed via `apt-get install ffmpeg` in the worker's Dockerfile (Debian slim base, same family as the existing `Dockerfile.dev`).
- **Pros:** `apt`'s `ffmpeg` package works identically across architectures (arm64/amd64) with no separate binary-download step — relevant since local dev may run on Apple Silicon while CI/prod may run amd64. `fluent-ffmpeg` gives duration/codec/resolution via `ffprobe()` and frame-accurate thumbnails via `.screenshots({ timestamps: [...] })` in a few lines, avoiding hand-rolled `child_process` argument building.
- **Cons:** Couples the worker's Docker image to an OS package (must remember to install it in the worker's Dockerfile specifically, not the API's).

### Option B: `fluent-ffmpeg` + `ffmpeg-static`/`ffprobe-static` (bundled npm binaries)
- Same `fluent-ffmpeg` wrapper, but the `ffmpeg`/`ffprobe` binaries come from npm packages that bundle prebuilt binaries per platform, set via `ffmpeg.setFfmpegPath()`.
- **Pros:** No Dockerfile `apt-get` step — the binary travels with `npm install`.
- **Cons:** Prebuilt binary packages have historically lagged or gapped on some architectures (arm64 support has been inconsistent across releases), which is a real risk given local dev on Apple Silicon vs. linux/amd64 in CI — trading a one-line Dockerfile step for a dependency on third-party binary packaging staying current.

### Option C: Raw `child_process` calls to `ffmpeg`/`ffprobe` (no wrapper)
- Hand-build the `ffmpeg`/`ffprobe` command-line arguments and invoke via `child_process.execFile`.
- **Pros:** Zero extra npm dependency beyond the OS-installed binaries.
- **Cons:** Re-implements what `fluent-ffmpeg` already provides (argument building, stdout/stderr parsing for `ffprobe`'s JSON output, progress events) — meaningful boilerplate and a maintenance burden for structured metadata extraction with no offsetting benefit over Option A.

**Recommendation:** **Option A (`fluent-ffmpeg` + apt-installed FFmpeg in the worker's Dockerfile)** — avoids the cross-architecture binary-packaging risk of static npm binaries while still getting `fluent-ffmpeg`'s structured `ffprobe`/`screenshots` API instead of hand-rolled `child_process` code. The worker Dockerfile is the only place FFmpeg needs to be installed — the API image is untouched.

**Decision:** A (`fluent-ffmpeg` + apt-installed FFmpeg)
**Libraries:** mediaforge
**Revisions:**
- 2026-07-19 — Wrapper library swapped from `fluent-ffmpeg` to `mediaforge` (fully-typed TypeScript FFmpeg wrapper, fluent builder API, zero native bindings, compatible with FFmpeg v6/v7/v8). Rationale: library documentation lookup (mandatory per CLAUDE.md before implementing) found `fluent-ffmpeg` marked deprecated on npm ("Package no longer supported"), last published 2024-05-19. `mediaforge` is the direct spiritual successor (same fluent-API approach Option A's reasoning was built on) and is actively published (latest 2026-04-24); apt-installed FFmpeg binaries in the worker's Dockerfile are unaffected by this swap — the Option A `Context`/`Pros`/`Cons` about binary installation strategy still hold verbatim. Known trade-off accepted: `mediaforge` is pre-1.0 (v0.3.0), so its API surface may still shift before a 1.0 release.

---

## TD-06: Video Playback URL & Streaming Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "URL única por vídeo, sem conflito com outros vídeos", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The architecture already commits to the frontend/client streaming directly from Object Storage over HTTPS, not through the API (`Rel(frontend, storage, "Streams", "HTTPS")`). S3-compatible `GetObject` natively supports `Range` requests and `206 Partial Content` responses — this needs no custom implementation once a client has a URL to the object. What remains open is how the API exposes that per-video URL: permanently public, or issued on demand.

**Options:**

### Option A: On-demand presigned GET URL per request
- The API exposes an endpoint (e.g. `GET /videos/:id/playback-url`) that returns a fresh presigned `GetObject` URL (time-limited, e.g. 1 hour) each time it's called. The client (or, later, the frontend video player) uses that URL directly against storage for both streaming (Range requests work unmodified against a presigned URL) and download.
- **Pros:** No public-read bucket policy needed — access control stays entirely in the API's hands (only an authorized request produces a URL), which fits a platform where video visibility (public/unlisted/private) is explicitly a *future* phase's concern (Phase 04) rather than something to lock in prematurely now. The video's UUID primary key is already the uniqueness guarantee for the underlying object key (TD-02) — no second "unique URL" scheme to invent. `Range`/`206` streaming and download both work against the same presigned URL with zero extra API code, since that's native S3/MinIO `GetObject` behavior.
- **Cons:** A long-running playback session needs the client to refresh the URL if it outlives the expiry window — acceptable in this phase since there is no video player client yet to exercise that edge case; a future frontend phase would handle refresh.

### Option B: Public-read bucket policy on the video prefix
- Objects under `videos/{videoId}/*` are world-readable via a static bucket policy; the "unique URL" is just the permanent public object URL, cacheable indefinitely.
- **Pros:** Simplest possible client experience — one stable URL, no refresh logic, trivially cacheable/CDN-friendly later.
- **Cons:** Every uploaded video becomes world-readable the moment it exists, with no way to gate access — pre-empting Phase 04's public/unlisted/private visibility model before it's designed. Reversing this later (moving to per-request authorization) means changing the bucket policy and every previously-issued "permanent" URL, a breaking migration this phase shouldn't force onto Phase 04.

**Recommendation:** **Option A (on-demand presigned GET URL per request)** — it satisfies "unique URL" and "streaming without full download" with zero custom code (native S3 Range/206 support), while keeping every access decision in the API's hands — necessary because this phase has no visibility model yet, and irreversible public exposure now would conflict with Phase 04's planned public/unlisted/private capability.

**Decision:** A (On-demand presigned GET URL per request)

---

## TD-07: Video Processing Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row must reflect its place in the upload→process pipeline (`rascunho → processando → pronto/erro` per the phase brief), and the worker needs a defined behavior when FFmpeg processing fails (corrupt file, unsupported codec, timeout).

**Options:**

### Option A: Four-state enum (`draft` → `processing` → `ready` | `failed`) + BullMQ built-in retry/backoff, terminal failure recorded on the row
- `status` column: `draft` (video row created, multipart upload in progress), `processing` (upload complete, job enqueued/running), `ready` (metadata + thumbnail persisted), `failed` (terminal, after retries exhausted). BullMQ's per-job `attempts` + exponential `backoff` handles transient failures (e.g. storage hiccup); a final failure writes `status = failed` plus an error message column on the video row for diagnosis.
- **Pros:** Matches the phase brief's stated lifecycle exactly. BullMQ's retry/backoff (from TD-01) is configuration, not new code, so transient failures self-heal without a bespoke retry loop. A `failed` terminal state with a stored error message gives Phase 04's management UI something concrete to show ("processing failed: unsupported codec") without inventing new columns later.
- **Cons:** No automatic re-processing trigger for a `failed` video beyond BullMQ's own attempt count — a manual "retry processing" action (re-enqueue) is left for a later phase to expose, since this phase has no video-management UI to trigger it from.

### Option B: Two-state enum (`draft` → `ready`), errors only in job logs
- Only `draft` and `ready`; a failed job is visible in the queue's dashboard/logs but the video row itself never reflects failure.
- **Pros:** Smaller enum, less schema surface.
- **Cons:** Directly contradicts the phase brief's explicit `rascunho → processando → pronto/erro` lifecycle requirement — a stuck `draft` row looks identical whether processing is still running or has permanently failed, with no way to distinguish without cross-referencing queue logs. Fails the acceptance criterion that the status cycle be "reflected in the database."

**Recommendation:** **Option A (four-state enum + BullMQ retry/backoff + stored error message)** — it is the only option that satisfies the phase brief's explicit status cycle and gives the database (not just queue logs) a durable, queryable record of failure, which Phase 04's video-management panel will need.

**Decision:** A (Four-state enum + BullMQ retry/backoff + stored error message)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | A (BullMQ + Redis) | _[pending]_ |
| TD-02 | Backend | Object Storage SDK & Bucket/Key Organization | A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) | _[pending]_ |
| TD-03 | Backend | Large File Upload Strategy (up to 10GB) | A (S3 Multipart Upload with per-part presigned URLs) | _[pending]_ |
| TD-04 | Backend | Video Worker Execution Model | A (Same NestJS project, separate bootstrap + separate container) | _[pending]_ |
| TD-05 | Backend | Video Metadata Extraction & Thumbnail Generation | A (`fluent-ffmpeg` + apt-installed FFmpeg) | _[pending]_ |
| TD-06 | Backend | Video Playback URL & Streaming Strategy | A (On-demand presigned GET URL per request) | _[pending]_ |
| TD-07 | Backend | Video Processing Status Lifecycle & Failure Handling | A (Four-state enum + BullMQ retry/backoff) | _[pending]_ |
