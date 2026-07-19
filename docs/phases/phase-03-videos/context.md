---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-19T12:07:30-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T13:19:11-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-19T12:07:30-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-07-19T12:07:30-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-19T12:07:30-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-19T12:07:30-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-19T12:07:30-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-19T12:07:30-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-19T13:23:42-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Interface de vídeo no `next-frontend/` (telas de upload/player) — este é um desafio de backend; edição de metadados de vídeo, categorias, visibilidade pública/unlisted e painel de canal (Fase 04); comentários, likes, inscrições e sugestões (fases posteriores).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (novo módulo de vídeos, migration, infraestrutura de storage/fila/worker em `compose.yaml`).

**Deferred subprojects:** `next-frontend/` — interface de vídeo (upload UI, player) explicitamente fora do escopo desta fase; será endereçada em fase futura.

**Sequencing notes:** Depende de Fase 01 (Configuração Base) e Fase 02 (Cadastro, Login e Gerenciamento de Conta) — em particular, cada vídeo pertence a um canal, e canal é criado 1:1 com o usuário na Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 2:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 4:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-02 | phase | Backend | Object Storage SDK & Bucket/Key Organization | decided | A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Large File Upload Strategy (up to 10GB) | decided | A (S3 Multipart Upload with per-part presigned URLs) | — |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Execution Model | decided | A (Same NestJS project, separate bootstrap + separate container) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Metadata Extraction & Thumbnail Generation | decided | A (`fluent-ffmpeg` + apt-installed FFmpeg) _(revised: mediaforge)_ | mediaforge |
| phase-03-videos/TD-06 | phase | Backend | Video Playback URL & Streaming Strategy | decided | A (On-demand presigned GET URL per request) | — |
| phase-03-videos/TD-07 | phase | Backend | Video Processing Status Lifecycle & Failure Handling | decided | A (Four-state enum + BullMQ retry/backoff + stored error message) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** the project is Node-only end to end, NestJS's own documentation uses a video-processing job as its canonical BullMQ example, and Redis is a one-line addition to `compose.yaml` with an official maintained image. Retry/backoff and dead-letter and progress tracking are needed for TD-07's failure handling and come built in, avoiding hand-rolled protocol code that RabbitMQ or an SQS emulator would require for the same guarantees.

**Libraries:** @nestjs/bullmq, bullmq

### phase-03-videos/TD-02

**Recommendation:** it is the only option that lets production swap MinIO for real S3 by changing configuration alone (a new `storage.config.ts` namespace following Phase 01's `registerAs` convention), with no code change. Bucket/key layout: a single bucket (e.g. `streamtube-videos`) with per-video prefixes `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg` — the video's own UUID primary key guarantees key uniqueness (feeds TD-06) without a second identifier scheme.

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** it is the only option that both satisfies the 10GB requirement (above the single-PUT 5GB ceiling) and keeps bytes off the API process entirely. Flow: `POST /videos` pre-registers the video as `draft` and returns a video ID + multipart upload ID + presigned part URLs; the caller PUTs parts directly to storage; `POST /videos/:id/complete-upload` reports part ETags, calls `CompleteMultipartUpload`, flips status to `processing`, and enqueues the TD-01 job.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** the worker and API must agree on the exact same `Video` entity/status enum (TD-07) and storage key layout (TD-02); duplicating that across a second package is a consistency risk for no isolation benefit this project needs yet. `compose.yaml` gets a `video-worker` service built from the same `Dockerfile.dev`, running the worker bootstrap instead of `nest start`.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** avoids the cross-architecture binary-packaging risk of static npm binaries while still getting a structured `ffprobe`/screenshot API instead of hand-rolled `child_process` code. The worker Dockerfile is the only place FFmpeg needs to be installed — the API image is untouched.

**Revisions:** 2026-07-19 — Wrapper library swapped from `fluent-ffmpeg` (confirmed deprecated on npm) to `mediaforge` (actively published TypeScript-first successor); apt-installed FFmpeg binary strategy unchanged.

**Libraries:** mediaforge

### phase-03-videos/TD-06

**Recommendation:** it satisfies "unique URL" and "streaming without full download" with zero custom code (native S3 Range/206 support), while keeping every access decision in the API's hands — necessary because this phase has no visibility model yet, and irreversible public exposure now would conflict with Phase 04's planned public/unlisted/private capability.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** it is the only option that satisfies the phase brief's explicit status cycle and gives the database (not just queue logs) a durable, queryable record of failure, which Phase 04's video-management panel will need.

**Libraries:** —

## Inherited Decisions Detail

_(user-confirmed correlated docs: openapi-docs-nestjs, next-frontend-openapi-typing — the 2 "high" ranked candidates)_

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. **Revision (2026-05-12):** o CLI plugin cobre apenas inferência de schema a partir de `class-validator` — documentação de operações, respostas tipadas por status code, contratos de erro e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). Novos endpoints de vídeo devem seguir esse mesmo padrão de decoração explícita.

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + `openapi.json` exportado) — o custo marginal sobre runtime-only é apenas um npm script e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa. Novos endpoints de vídeo entram automaticamente em ambas as superfícies (Swagger UI + `openapi.json`) sem trabalho adicional.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging via env flag) — alinha com a postura defensiva já estabelecida na Fase 02; o `openapi.json` commitado cumpre o papel de spec consultável fora da UI em produção. Endpoints de vídeo (incluindo os de upload/presigned URL) seguem a mesma política — não ficam expostos via Swagger UI em produção.

**Libraries:** —

### next-frontend-openapi-typing/TD-01

**Recommendation:** Option A (`openapi-typescript` + `openapi-fetch`) — o modelo de BFF estrito torna a superfície de SDK gerado sem valor no cliente; `paths` é a extensão natural de um projeto types-first. Quando o frontend eventualmente consumir os endpoints de vídeo desta fase, o mesmo pipeline de tipos (`paths["/videos/..."]`) se aplica sem trabalho adicional de tooling.

**Libraries:** `openapi-typescript`, `openapi-fetch`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/` (e.g. `database.config.ts`, `app.config.ts`, `auth.config.ts`, `mail.config.ts`) — a new `storage.config.ts` (and `queue.config.ts`) for Phase 03 follows this same pattern. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... })` — new Phase 03 env vars (S3/MinIO endpoint+credentials, Redis host/port) must be added here. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function outside NestJS DI. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function — this pattern does not need to extend to storage/queue config (TypeORM CLI only needs DB config). _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning the connection options. _(from phase 01)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities relevant to backend video processing._ _(Phase 01/02's deferred entries are all frontend UI screens — `next-frontend/` telas de cadastro/login/confirmação/recuperação — unrelated to this backend-only phase's scope.)_

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

_(from `testing-guide-nestjs-project` Skill — Feature Implementation Checklist)_

### nestjs-project

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (BullMQ, S3 client) | Unit: real lib with test config |
| Service with side-effect dep (storage, queue, FFmpeg) | Integration: real capture service (MinIO, Redis containers) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |

Applicable notes for this phase's artifact set: video upload/processing/streaming endpoints are new controllers (E2E only); the multipart-upload orchestration service, storage-key service, and queue-producer service are services with side-effect deps (storage/queue) → integration tests against real MinIO + Redis containers per Compose, not mocks (`testing-guide-nestjs-project` §5 anti-pattern: "Skip integration tests for services with DB access" extends here to storage/queue side-effect services per §2 "Worth testing — Service-to-external-system contracts"). The video worker's FFmpeg-driven processing service is likewise a side-effect service — integration-test it against a real small sample video file and real MinIO, not a mocked FFmpeg wrapper.

### next-frontend

_Deferred subproject — no video UI this phase; testing requirements not applicable._
