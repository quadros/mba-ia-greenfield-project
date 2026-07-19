import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import type { ProcessVideoJobData } from '../../queue/video-queue.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  process(job: Job<ProcessVideoJobData>): Promise<void> {
    this.logger.log(`Received job ${job.id} for video ${job.data.videoId}`);
    // Metadata extraction, thumbnail generation, and status transitions
    // are implemented in SI-03.8.
    return Promise.resolve();
  }
}
