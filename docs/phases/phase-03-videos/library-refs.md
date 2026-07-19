---
libs:
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "pending — context7 MCP not loaded this session (added to .mcp.json, requires a Claude Code restart); verified instead via npm registry (https://registry.npmjs.org/@nestjs/bullmq) and https://docs.bullmq.io/guide/nestjs"
    fetched_at: "2026-07-19T13:19:11-03:00"
  "bullmq":
    version: "^5.80.9"
    context7_id: "pending — same substitution as above; verified via npm registry (https://registry.npmjs.org/bullmq) and https://docs.bullmq.io"
    fetched_at: "2026-07-19T13:19:11-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1090.0"
    context7_id: "pending — same substitution as above; verified via npm registry (https://registry.npmjs.org/@aws-sdk/client-s3) and https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-upload-object.html"
    fetched_at: "2026-07-19T13:19:11-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1090.0"
    context7_id: "pending — same substitution as above; verified via npm registry (https://registry.npmjs.org/@aws-sdk/s3-request-presigner) and https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/"
    fetched_at: "2026-07-19T13:19:11-03:00"
  "mediaforge":
    version: "^0.3.0"
    context7_id: "pending — same substitution as above; verified via npm registry (https://registry.npmjs.org/mediaforge) and https://github.com/GlobalTechInfo/mediaforge"
    fetched_at: "2026-07-19T13:19:11-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T13:19:11-03:00"
---

# Library References — phase-03-videos

Cached documentation excerpts for libraries decided in this phase. **Note on sourcing:** the `context7` MCP server was added to `.mcp.json` during this phase's setup but requires a Claude Code session restart to load — it was not available in this working session. Every entry below was instead verified directly against the npm registry (version, deprecation status) and official docs/READMEs via WebSearch/WebFetch. Re-run `/plan-resolve phase-03-videos` after a restart (with context7 available) to refresh these entries through the canonical path if a stricter audit trail is required.

**Deprecation check performed for every library below** (per CLAUDE.md's mandatory library-doc-lookup rule) — see the `fluent-ffmpeg` → `mediaforge` revision in `technical-decisions-phase-03-videos.md`/TD-05 for the one case where this check changed the decision.

---

## @nestjs/bullmq + bullmq

**Version line:** `@nestjs/bullmq@^11.0.4` (peer-compatible with `@nestjs/common`/`@nestjs/core ^10.0.0 || ^11.0.0` — matches the installed `^11.0.1`), `bullmq@^5.80.9` (satisfies `@nestjs/bullmq`'s accepted range `^3.0.0 || ^4.0.0 || ^5.0.0`).
**Decided in:** `phase-03-videos/TD-01` (Option A — BullMQ + Redis).
**Not deprecated** — both actively published (bullmq last published 2026-07-18, @nestjs/bullmq 2025-10-10).

### 1. Redis connection + queue registration (`videos.module.ts` or a dedicated `queue.module.ts`)

```typescript
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import type { ConfigType } from '@nestjs/config';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.redisHost, port: config.redisPort },
      }),
    }),
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
})
export class VideosModule {}
```

### 2. Producer side — adding a job (in the upload-completion service)

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

async enqueueProcessing(videoId: string): Promise<void> {
  await this.queue.add(
    'process-video',
    { videoId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false, // keep failed jobs for TD-07's failure inspection
    },
  );
}
```

### 3. Worker side — processor (in the separate worker bootstrap, per TD-04)

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // extract metadata + thumbnail (TD-05), update status (TD-07)
  }
}
```

Register `VideoProcessor` as a provider in the worker's module graph, and register `BullModule.registerQueue({ name: 'video-processing' })` there too (both the API's producer module and the worker's consumer module register the same queue name against the same Redis connection — they do not share a Nest module instance, only the Redis-backed queue).

### 4. Retry/backoff options (per TD-07)

`attempts` (total tries including the first) + `backoff` (`{ type: 'fixed' | 'exponential', delay: ms }`) are set per-job at `.add()` time (shown above), not globally on the queue. Exhausted-retry jobs move to BullMQ's `failed` state; listen via `@OnWorkerEvent('failed')` in the processor to persist the terminal `failed` status + error message on the `Video` row (TD-07).

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Version line:** `@aws-sdk/client-s3@^3.1090.0`, `@aws-sdk/s3-request-presigner@^3.1090.0` (same major/minor line — AWS SDK v3 packages are released in lockstep; pin both to the same version).
**Decided in:** `phase-03-videos/TD-02` (Option A) and `phase-03-videos/TD-03` (Option A — multipart presigned).
**Not deprecated** — both actively published (2026-07-17).

### 1. Client configured for MinIO locally / S3 in production (`storage.config.ts`, per Phase 01's `registerAs` convention)

```typescript
import { registerAs } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT,       // e.g. http://minio:9000 locally; unset in prod for real AWS S3
  region: process.env.STORAGE_REGION ?? 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY,
  secretAccessKey: process.env.STORAGE_SECRET_KEY,
  forcePathStyle: process.env.STORAGE_ENDPOINT ? true : false, // required for MinIO; must be unset/false for real AWS S3
  bucket: process.env.STORAGE_BUCKET ?? 'streamtube-videos',
}));

// client construction (in a StorageService provider):
new S3Client({
  endpoint: config.endpoint,
  region: config.region,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  forcePathStyle: config.forcePathStyle,
});
```

### 2. Multipart upload handshake (TD-03's flow)

```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// 1. Initiate — returns an UploadId
const { UploadId } = await s3.send(
  new CreateMultipartUploadCommand({ Bucket: bucket, Key: `videos/${videoId}/original.mp4` }),
);

// 2. Presign one URL per part (client PUTs directly to each)
const partUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: partNumber }),
  { expiresIn: 3600 },
);

// 3. Client reports back { PartNumber, ETag } per part it uploaded; finalize:
await s3.send(
  new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId,
    MultipartUpload: { Parts: parts.map(({ partNumber, eTag }) => ({ PartNumber: partNumber, ETag: eTag })) },
  }),
);

// On failure/cancellation, always abort to release storage:
await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId }));
```

**Note:** `ETag` values are returned in the response of each part's actual `PUT` request (an HTTP response header the client reads after uploading to the presigned URL) — the API never issues `UploadPartCommand` itself server-side; it only presigns the URL. The client (or, in this backend-only phase, the e2e test acting as the client) performs the real `PUT` and must capture the `ETag` response header to report back for `CompleteMultipartUploadCommand`.

### 3. Presigned GET URL for playback/download (TD-06)

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const playbackUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: bucket, Key: `videos/${videoId}/original.mp4` }),
  { expiresIn: 3600 },
);
// Range/206 Partial Content streaming works automatically against this URL — native GetObject behavior,
// no extra code. The same URL also serves full-file download (no Range header = full body).
```

---

## mediaforge

**Version line:** `mediaforge@^0.3.0` (pre-1.0 — pin exact minor, do not use `^` carelessly across a minor bump without re-verifying the API; the project's own dependency should still use caret per `package.json` convention, but a `package-lock.json` commit pins the exact resolved version).
**Decided in:** `phase-03-videos/TD-05`, **superseding `fluent-ffmpeg`** per the Revision recorded in the same TD (fluent-ffmpeg is deprecated on npm — "Package no longer supported", last published 2024-05-19).
**Requires:** Node.js 20+ (satisfied — project's `Dockerfile.dev` uses `node:25.6.0-slim`). Zero native bindings, zero peer dependencies. Requires `ffmpeg`/`ffprobe` on `PATH` (installed via `apt-get install ffmpeg` in the worker's Dockerfile per TD-05) or `FFMPEG_PATH`/`FFPROBE_PATH` env vars.

### 1. Probe metadata (duration, resolution, codec) — TD-05 / TD-07

```typescript
import { probeAsync, getMediaDuration, getDefaultVideoStream, summarizeVideoStream } from 'mediaforge';

const info = await probeAsync(localFilePath); // or a readable stream, per the library's supported inputs
const durationSeconds = getMediaDuration(info);
const videoStream = getDefaultVideoStream(info);
const { codec, width, height, fps, bitrate } = summarizeVideoStream(videoStream);
```

### 2. Generate a thumbnail from a frame (TD-05)

```typescript
import { frameToBuffer } from 'mediaforge';

const thumbnailBuffer = await frameToBuffer(localFilePath, {
  timestamp: '00:00:01', // or a computed early-timestamp default per TD-05's implementation note
  format: 'jpeg',
  size: '640x360',
});
// thumbnailBuffer is returned in-memory (no temp file on disk) — upload directly via PutObjectCommand
// to `videos/{videoId}/thumbnail.jpg` using the TD-02 storage client.
```

### 3. Binary path configuration (apt-installed, per TD-05 Option A)

No explicit configuration call needed when `ffmpeg`/`ffprobe` are on `PATH` (the default after `apt-get install ffmpeg` in the worker's Dockerfile). Only set `FFMPEG_PATH`/`FFPROBE_PATH` env vars if a non-standard binary location is ever needed.

**Known risk (accepted in TD-05's Revision):** `mediaforge` is pre-1.0 (`v0.3.0`) — its API surface may still change before a 1.0 release. Pin the exact version in `package-lock.json` and re-verify this file's code samples against the installed version before upgrading.
