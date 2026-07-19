import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let storageService: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
    await storageService.onModuleInit();
  });

  it('bootstraps the bucket idempotently', async () => {
    await expect(storageService.onModuleInit()).resolves.toBeUndefined();
  });

  it('uploads via multipart presigned URL and retrieves the exact bytes', async () => {
    const key = `test/${randomUUID()}/original.bin`;
    const content = Buffer.from('hello streamtube multipart upload');

    const { uploadId } = await storageService.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    const partUrl = await storageService.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: content,
    });
    expect(putResponse.status).toBe(200);
    const eTag = putResponse.headers.get('etag') as string;
    expect(eTag).toBeTruthy();

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag },
    ]);

    const getUrl = await storageService.presignGetObject(key);
    const getResponse = await fetch(getUrl);
    const retrieved = Buffer.from(await getResponse.arrayBuffer());
    expect(retrieved.equals(content)).toBe(true);
  });

  it('aborts a multipart upload so it can no longer be completed', async () => {
    const key = `test/${randomUUID()}/aborted.bin`;
    const { uploadId } = await storageService.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    await storageService.abortMultipartUpload(key, uploadId);

    await expect(
      storageService.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, eTag: '"deadbeef"' },
      ]),
    ).rejects.toThrow();
  });

  it('supports Range requests against the presigned GET URL (206 Partial Content)', async () => {
    const key = `test/${randomUUID()}/ranged.bin`;
    const content = Buffer.from('0123456789');

    const { uploadId } = await storageService.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const partUrl = await storageService.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(partUrl, { method: 'PUT', body: content });
    const eTag = putResponse.headers.get('etag') as string;
    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag },
    ]);

    const getUrl = await storageService.presignGetObject(key);
    const rangeResponse = await fetch(getUrl, {
      headers: { Range: 'bytes=0-2' },
    });

    expect(rangeResponse.status).toBe(206);
    const partial = Buffer.from(await rangeResponse.arrayBuffer());
    expect(partial.toString()).toBe('012');
  });

  it('putObject + getObjectStream round-trips a buffer', async () => {
    const key = `test/${randomUUID()}/direct.bin`;
    const content = Buffer.from('direct put/get roundtrip');

    await storageService.putObject(key, content, 'application/octet-stream');
    const stream = await storageService.getObjectStream(key);

    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).equals(content)).toBe(true);
  });
});
