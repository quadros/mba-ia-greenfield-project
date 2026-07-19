import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { TestingModule } from '@nestjs/testing';
import type { ConfigType } from '@nestjs/config';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { ChannelsService } from '../channels/channels.service';
import { User } from '../users/entities/user.entity';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { cleanAllTables } from '../test/create-test-data-source';
import { StorageModule } from '../storage/storage.module';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let videosService: VideosService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (config: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres',
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            database: config.name,
            autoLoadEntities: true,
            synchronize: false,
          }),
        }),
        TypeOrmModule.forFeature([User]),
        StorageModule,
        VideosModule,
      ],
    }).compile();

    videosService = module.get(VideosService);
    channelsService = module.get(ChannelsService);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createOwnedVideo(): Promise<{
    userId: string;
    videoId: string;
  }> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_svc_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(user.id, user.email);
    const video = await videosService.createDraft(user.id, {
      title: `Video ${counter}`,
    });
    return { userId: user.id, videoId: video.id };
  }

  it('persists a draft row on createDraft', async () => {
    const { videoId } = await createOwnedVideo();
    expect(videoId).toBeTruthy();
  });

  it('creates a real MinIO multipart upload session and persists its fields', async () => {
    const { userId, videoId } = await createOwnedVideo();

    const session = await videosService.createUploadSession(videoId, userId, {
      sizeBytes: 1000,
      contentType: 'video/mp4',
    });

    expect(session.uploadId).toBeTruthy();

    // Prove it's a real, active MinIO multipart upload: presigning a part
    // for this uploadId must succeed.
    const url = await videosService.presignUploadPart(videoId, userId, 1);
    expect(url).toContain(session.uploadId);
  });

  it('really aborts the multipart upload so it can no longer be presigned', async () => {
    const { userId, videoId } = await createOwnedVideo();
    await videosService.createUploadSession(videoId, userId, {
      sizeBytes: 1000,
      contentType: 'video/mp4',
    });

    await videosService.abortUploadSession(videoId, userId);

    await expect(
      videosService.presignUploadPart(videoId, userId, 1),
    ).rejects.toThrow(UploadSessionNotFoundException);
  });

  it('rejects operations on a video owned by a different user (404, not leaked)', async () => {
    const { videoId } = await createOwnedVideo();
    counter += 1;
    const otherUser = await userRepository.save(
      userRepository.create({
        email: `video_svc_other_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(otherUser.id, otherUser.email);

    await expect(
      videosService.createUploadSession(videoId, otherUser.id, {
        sizeBytes: 1000,
        contentType: 'video/mp4',
      }),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('rejects a second upload session on an already-processing video', async () => {
    const { userId, videoId } = await createOwnedVideo();
    await videosService.createUploadSession(videoId, userId, {
      sizeBytes: 1000,
      contentType: 'video/mp4',
    });
    await dataSource
      .getRepository(Video)
      .update(videoId, { status: VideoStatus.PROCESSING });

    await expect(
      videosService.createUploadSession(videoId, userId, {
        sizeBytes: 1000,
        contentType: 'video/mp4',
      }),
    ).rejects.toThrow(InvalidUploadStateException);
  });

  it('rejects an upload session over the 10GB limit', async () => {
    const { userId, videoId } = await createOwnedVideo();

    await expect(
      videosService.createUploadSession(videoId, userId, {
        sizeBytes: 10 * 1024 * 1024 * 1024 + 1,
        contentType: 'video/mp4',
      }),
    ).rejects.toThrow(FileTooLargeException);
  });
});
