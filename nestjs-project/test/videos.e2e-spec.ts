import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface ErrorResponseBody {
  error: string;
}

interface VideoResponseBody {
  id: string;
  status: string;
}

interface PlaybackUrlResponseBody {
  url: string;
}

interface UploadSessionResponseBody {
  uploadId: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
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

    dataSource = moduleFixture.get(DataSource);
    storageService = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let userCounter = 0;
  async function registerConfirmAndLogin(): Promise<string> {
    userCounter += 1;
    const email = `video_e2e_${userCounter}@example.com`;
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

  describe('POST /videos', () => {
    it('returns 201 with a draft video on valid body', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'My first video' })
        .expect(201);

      expect((res.body as VideoResponseBody).id).toBeDefined();
      expect((res.body as VideoResponseBody).status).toBe('draft');
    });

    it('returns 400 when title is missing', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);

      expect((res.body as ErrorResponseBody).error).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without a valid access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ title: 'No auth' })
        .expect(401);
    });
  });

  describe('POST /videos/:id/upload-session', () => {
    it('returns 201 with an uploadId on a valid session request', async () => {
      const token = await registerConfirmAndLogin();
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Upload target' });
      const videoId = (createRes.body as VideoResponseBody).id;

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session`)
        .set('Authorization', `Bearer ${token}`)
        .send({ sizeBytes: 1000, contentType: 'video/mp4' })
        .expect(201);

      expect((res.body as UploadSessionResponseBody).uploadId).toBeDefined();
    });

    it('returns 413 when sizeBytes exceeds 10GB', async () => {
      const token = await registerConfirmAndLogin();
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Too big' });
      const videoId = (createRes.body as VideoResponseBody).id;

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          sizeBytes: 10 * 1024 * 1024 * 1024 + 1,
          contentType: 'video/mp4',
        })
        .expect(413);

      expect((res.body as ErrorResponseBody).error).toBe('FILE_TOO_LARGE');
    });

    it('returns 404 for a video owned by a different user', async () => {
      const ownerToken = await registerConfirmAndLogin();
      const otherToken = await registerConfirmAndLogin();
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: 'Not yours' });
      const videoId = (createRes.body as VideoResponseBody).id;

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ sizeBytes: 1000, contentType: 'video/mp4' })
        .expect(404);

      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('POST /videos/:id/upload-session/complete', () => {
    it('completes a real upload and returns status: processing', async () => {
      const token = await registerConfirmAndLogin();
      const content = Buffer.from('e2e complete upload payload');
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Complete me' });
      const videoId = (createRes.body as VideoResponseBody).id;
      await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session`)
        .set('Authorization', `Bearer ${token}`)
        .send({ sizeBytes: content.length, contentType: 'video/mp4' });

      const partRes = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session/parts/1`)
        .set('Authorization', `Bearer ${token}`);
      const partUrl = (partRes.body as { url: string }).url;
      const putResponse = await fetch(partUrl, {
        method: 'PUT',
        body: content,
      });
      const eTag = putResponse.headers.get('etag') as string;

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      expect((res.body as VideoResponseBody).status).toBe('processing');
    });

    it('returns 404 when there is no active upload session', async () => {
      const token = await registerConfirmAndLogin();
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'No session' });
      const videoId = (createRes.body as VideoResponseBody).id;

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag: '"x"' }] })
        .expect(404);

      expect((res.body as ErrorResponseBody).error).toBe(
        'UPLOAD_SESSION_NOT_FOUND',
      );
    });
  });

  describe('POST /videos/:id/upload-session/abort', () => {
    it('returns 204 and allows a fresh session afterwards', async () => {
      const token = await registerConfirmAndLogin();
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Abort me' });
      const videoId = (createRes.body as VideoResponseBody).id;
      await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session`)
        .set('Authorization', `Bearer ${token}`)
        .send({ sizeBytes: 1000, contentType: 'video/mp4' });

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session/abort`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-session`)
        .set('Authorization', `Bearer ${token}`)
        .send({ sizeBytes: 2000, contentType: 'video/mp4' })
        .expect(201);
    });
  });

  // Marks a video `ready` with a real object in storage — bypasses the
  // worker (already exercised end-to-end by video.processor.integration-spec.ts)
  // so these endpoint-contract tests aren't coupled to worker timing.
  async function createReadyVideo(
    token: string,
    content: Buffer,
  ): Promise<string> {
    const createRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Ready video' });
    const videoId = (createRes.body as VideoResponseBody).id;
    const storageKey = `videos/${videoId}/original.mp4`;
    await storageService.putObject(storageKey, content, 'video/mp4');
    await dataSource
      .getRepository(Video)
      .update(videoId, { status: VideoStatus.READY, storage_key: storageKey });
    return videoId;
  }

  describe('GET /videos/:id', () => {
    it('returns 200 with full metadata for a ready video', async () => {
      const token = await registerConfirmAndLogin();
      const videoId = await createReadyVideo(token, Buffer.from('content'));

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((res.body as VideoResponseBody).status).toBe('ready');
    });

    it('returns 404 for a video owned by a different user', async () => {
      const ownerToken = await registerConfirmAndLogin();
      const otherToken = await registerConfirmAndLogin();
      const videoId = await createReadyVideo(
        ownerToken,
        Buffer.from('content'),
      );

      await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
    });
  });

  describe('GET /videos/:id/playback-url', () => {
    it('returns 409 for a video that is not ready yet', async () => {
      const token = await registerConfirmAndLogin();
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Not ready' });
      const videoId = (createRes.body as VideoResponseBody).id;

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/playback-url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      expect((res.body as ErrorResponseBody).error).toBe(
        'INVALID_UPLOAD_STATE',
      );
    });

    it('returns a URL that supports full download and Range streaming (206)', async () => {
      const token = await registerConfirmAndLogin();
      const content = Buffer.from('0123456789');
      const videoId = await createReadyVideo(token, content);

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/playback-url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const url = (res.body as PlaybackUrlResponseBody).url;

      const fullResponse = await fetch(url);
      expect(fullResponse.status).toBe(200);
      const full = Buffer.from(await fullResponse.arrayBuffer());
      expect(full.equals(content)).toBe(true);

      const rangeResponse = await fetch(url, {
        headers: { Range: 'bytes=0-2' },
      });
      expect(rangeResponse.status).toBe(206);
      const partial = Buffer.from(await rangeResponse.arrayBuffer());
      expect(partial.toString()).toBe('012');
    });
  });
});
