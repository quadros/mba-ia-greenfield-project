import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { MailService } from '../src/mail/mail.service';
import { WorkerModule } from '../src/videos/worker/worker.module';

interface ErrorResponseBody {
  error: string;
}

interface VideoResponseBody {
  id: string;
  status: string;
}

interface UploadSessionResponseBody {
  uploadId: string;
  partSize: number;
  partCount: number;
}

interface PresignedUrlResponseBody {
  url: string;
}

const FIXTURE_PATH = join(
  __dirname,
  '../src/videos/worker/fixtures/sample.mp4',
);

describe('Videos full flow (e2e)', () => {
  let app: INestApplication<App>;
  let workerApp: INestApplicationContext;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = app.get(DataSource);
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);

    // Boot the real worker application context alongside the API so the
    // full flow (upload -> processing -> ready) actually happens end-to-end,
    // with no mocks anywhere in the chain.
    workerApp = await NestFactory.createApplicationContext(WorkerModule);
  }, 30000);

  afterAll(async () => {
    await workerApp.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as { mailService: MailService }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as { access_token: string }).access_token;
  }

  async function pollUntilNotProcessing(
    token: string,
    videoId: string,
    timeoutMs: number,
  ): Promise<VideoResponseBody> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${token}`);
      const body = res.body as VideoResponseBody;
      if (body.status !== 'processing') return body;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for video to leave processing status');
  }

  it('uploads a real video, processes it for real, and serves it back via streaming and download', async () => {
    const token = await registerConfirmAndLogin('fullflow@example.com');
    const content = await readFile(FIXTURE_PATH);

    // 1. Pre-register the draft.
    const createRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Full flow video' })
      .expect(201);
    const videoId = (createRes.body as VideoResponseBody).id;
    expect((createRes.body as VideoResponseBody).status).toBe('draft');

    // 2. Initiate the multipart upload session for the real fixture's size.
    const sessionRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-session`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: content.length, contentType: 'video/mp4' })
      .expect(201);
    const session = sessionRes.body as UploadSessionResponseBody;
    expect(session.partCount).toBe(1);

    // 3. Presign and PUT the single part directly (real multipart upload).
    const partRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-session/parts/1`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const partUrl = (partRes.body as PresignedUrlResponseBody).url;
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: content,
    });
    expect(putResponse.status).toBe(200);
    const eTag = putResponse.headers.get('etag') as string;

    // 4. Complete the upload — flips to processing and enqueues the job.
    const completeRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-session/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, eTag }] })
      .expect(200);
    expect((completeRes.body as VideoResponseBody).status).toBe('processing');

    // 5. Wait for the real worker (booted above) to finish processing.
    const processed = await pollUntilNotProcessing(token, videoId, 15000);
    expect(processed.status).toBe('ready');

    // 6. Fetch full detail and confirm extracted metadata is present.
    const detailRes = await request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const detail = detailRes.body as VideoResponseBody & {
      durationSeconds: number;
      thumbnailKey: string;
    };
    expect(detail.durationSeconds).toBe(1);
    expect(detail.thumbnailKey).toBeTruthy();

    // 7. Fetch the playback URL and verify streaming + full download.
    const playbackRes = await request(app.getHttpServer())
      .get(`/videos/${videoId}/playback-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const playbackUrl = (playbackRes.body as PresignedUrlResponseBody).url;

    const fullDownload = await fetch(playbackUrl);
    expect(fullDownload.status).toBe(200);
    const downloaded = Buffer.from(await fullDownload.arrayBuffer());
    expect(downloaded.equals(content)).toBe(true);

    const rangeResponse = await fetch(playbackUrl, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(rangeResponse.status).toBe(206);
    const partial = Buffer.from(await rangeResponse.arrayBuffer());
    expect(partial.length).toBe(100);
    expect(partial.equals(content.subarray(0, 100))).toBe(true);
  }, 30000);

  it('rejects playback-url for a video that never finished processing', async () => {
    const token = await registerConfirmAndLogin(
      'fullflow-notready@example.com',
    );
    const createRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Not ready' });
    const videoId = (createRes.body as VideoResponseBody).id;

    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}/playback-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    expect((res.body as ErrorResponseBody).error).toBe('INVALID_UPLOAD_STATE');
  });
});
