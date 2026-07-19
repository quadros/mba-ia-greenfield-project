import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import type { Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { StorageService } from '../../storage/storage.service';
import { cleanAllTables } from '../../test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { VideoQueueService } from '../../queue/video-queue.service';
import type { ProcessVideoJobData } from '../../queue/video-queue.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { WorkerModule } from './worker.module';
import { VideoProcessor } from './video.processor';

const FIXTURES_DIR = join(__dirname, 'fixtures');

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let queue: Queue<ProcessVideoJobData>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let storageService: StorageService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    // .compile() alone does not run lifecycle hooks — WorkerHost starts its
    // internal BullMQ Worker in onModuleInit, which only fires via .init().
    await module.init();
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    storageService = module.get(StorageService);
  });

  beforeEach(async () => {
    // A leftover job from a prior run could otherwise be picked up first by
    // the 'completed'/'failed' listeners below, before this test's own job.
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  let counter = 0;
  async function createProcessingVideo(fixtureFile: string): Promise<Video> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_test_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Worker Channel ${counter}`,
        nickname: `workerchan${counter}`,
        user_id: user.id,
      }),
    );
    const storageKey = `videos/worker-test-${counter}/original.mp4`;
    const content = await readFile(join(FIXTURES_DIR, fixtureFile));
    await storageService.putObject(storageKey, content, 'video/mp4');

    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: `Worker test ${counter}`,
        status: VideoStatus.PROCESSING,
        storage_key: storageKey,
      }),
    );
  }

  it('processes a real video fixture end-to-end: metadata, thumbnail, status ready', async () => {
    const processor = module.get(VideoProcessor);
    const video = await createProcessingVideo('sample.mp4');

    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for processing')),
        15000,
      );
      processor.worker.once('completed', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await module.get(VideoQueueService).enqueueProcessing(video.id);
    await completed;

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBe(1);
    expect(processed.width).toBe(320);
    expect(processed.height).toBe(240);
    expect(processed.codec).toBeTruthy();
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.png`);

    const getUrl = await storageService.presignGetObject(
      processed.thumbnail_key as string,
    );
    const res = await fetch(getUrl);
    expect(res.status).toBe(200);
    const thumbnailBuffer = Buffer.from(await res.arrayBuffer());
    expect(thumbnailBuffer.length).toBeGreaterThan(0);
  }, 20000);

  it('marks the video failed with an error message after a corrupt file exhausts retries', async () => {
    const video = await createProcessingVideo('corrupt.mp4');

    // Bypass VideoQueueService's production attempts:3/exponential-backoff
    // (which would take too long for a deterministic test) by adding the job
    // directly with attempts:1 — same queue, same real VideoProcessor consumer.
    await queue.add(
      'process-video',
      { videoId: video.id },
      { attempts: 1, removeOnComplete: true, removeOnFail: false },
    );

    await pollUntil(async () => {
      const current = await videoRepository.findOneByOrFail({
        id: video.id,
      });
      return current.status === VideoStatus.FAILED;
    }, 10000);

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.error_message).toBeTruthy();
  }, 60000);
});

async function pollUntil(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}
