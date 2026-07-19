import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { VideoQueueService } from '../../queue/video-queue.service';
import type { ProcessVideoJobData } from '../../queue/video-queue.service';
import { WorkerModule } from './worker.module';
import { VideoProcessor } from './video.processor';

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    // .compile() alone does not run lifecycle hooks — WorkerHost starts its
    // internal BullMQ Worker in onModuleInit, which only fires via .init().
    await module.init();
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    // A leftover job from a prior run could otherwise be picked up first by
    // the 'completed' listener below, before this test's own job.
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await module.close();
  });

  it('picks up a job enqueued by VideoQueueService and completes it', async () => {
    const processor = module.get(VideoProcessor);
    const queueService = module.get(VideoQueueService);

    // Job options set removeOnComplete: true (TD-07), so the job is deleted
    // from Redis the instant it completes — assert via the worker's own
    // 'completed' event, not by polling the queue/job state afterward.
    const completed = new Promise<Job<ProcessVideoJobData>>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for job completion')),
          5000,
        );
        processor.worker.once('completed', (job: Job<ProcessVideoJobData>) => {
          clearTimeout(timeout);
          resolve(job);
        });
      },
    );

    await queueService.enqueueProcessing('video-worker-test-1');
    const job = await completed;

    expect(job.data).toEqual({ videoId: 'video-worker-test-1' });
  }, 10000);
});
