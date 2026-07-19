import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoQueueService } from './video-queue.service';
import type { ProcessVideoJobData } from './video-queue.service';

describe('VideoQueueService (integration)', () => {
  let videoQueueService: VideoQueueService;
  let queue: Queue<ProcessVideoJobData>;
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    videoQueueService = module.get(VideoQueueService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await module.close();
  });

  it('adds a job to the video-processing queue with the correct payload and options', async () => {
    await videoQueueService.enqueueProcessing('video-123');

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('process-video');
    expect(jobs[0].data).toEqual({ videoId: 'video-123' });
    expect(jobs[0].opts.attempts).toBe(3);
    expect(jobs[0].opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
    expect(jobs[0].opts.removeOnFail).toBe(false);
  });
});
