import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

type MockedVideoRepository = {
  create: jest.Mock;
  save: jest.Mock<Promise<Video>, [Video]>;
  findOne: jest.Mock;
};

describe('VideosService', () => {
  let videosService: VideosService;
  let videoRepository: MockedVideoRepository;
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };

  const channel = { id: 'channel-1' } as Channel;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            create: jest.fn((v: Partial<Video>) => v as Video),
            save: jest.fn((v: Video) => Promise.resolve(v)),
            findOne: jest.fn(),
          },
        },
        {
          provide: ChannelsService,
          useValue: { findByUserId: jest.fn().mockResolvedValue(channel) },
        },
        {
          provide: StorageService,
          useValue: {
            createMultipartUpload: jest.fn(),
            presignUploadPart: jest.fn(),
            abortMultipartUpload: jest.fn(),
          },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    channelsService = module.get(ChannelsService);
    storageService = module.get(StorageService);
  });

  describe('createDraft', () => {
    it('creates a draft video for the caller channel', async () => {
      const result = await videosService.createDraft('user-1', {
        title: 'My video',
      });

      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-1');
      expect(videoRepository.create).toHaveBeenCalledWith({
        channel_id: 'channel-1',
        title: 'My video',
        status: VideoStatus.DRAFT,
      });
      expect(result).toMatchObject({
        channel_id: 'channel-1',
        title: 'My video',
      });
    });

    it('throws VideoNotFoundException when caller has no channel', async () => {
      channelsService.findByUserId.mockResolvedValueOnce(null);

      await expect(
        videosService.createDraft('user-without-channel', { title: 'X' }),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('createUploadSession', () => {
    const draftVideo = {
      id: 'video-1',
      channel_id: 'channel-1',
      status: VideoStatus.DRAFT,
    } as Video;

    it('throws VideoNotFoundException when video is not owned by caller', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        videosService.createUploadSession('video-1', 'user-1', {
          sizeBytes: 1000,
          contentType: 'video/mp4',
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws InvalidUploadStateException when video is not in draft status', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...draftVideo,
        status: VideoStatus.PROCESSING,
      });

      await expect(
        videosService.createUploadSession('video-1', 'user-1', {
          sizeBytes: 1000,
          contentType: 'video/mp4',
        }),
      ).rejects.toThrow(InvalidUploadStateException);
    });

    it('throws FileTooLargeException when sizeBytes exceeds 10GB', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo);

      await expect(
        videosService.createUploadSession('video-1', 'user-1', {
          sizeBytes: 10 * 1024 * 1024 * 1024 + 1,
          contentType: 'video/mp4',
        }),
      ).rejects.toThrow(FileTooLargeException);
    });

    it('accepts sizeBytes at exactly the 10GB boundary', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo);
      storageService.createMultipartUpload.mockResolvedValue({
        uploadId: 'upload-1',
      });

      await expect(
        videosService.createUploadSession('video-1', 'user-1', {
          sizeBytes: 10 * 1024 * 1024 * 1024,
          contentType: 'video/mp4',
        }),
      ).resolves.toMatchObject({ uploadId: 'upload-1' });
    });

    it('computes partCount as ceil(sizeBytes / partSize)', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo);
      storageService.createMultipartUpload.mockResolvedValue({
        uploadId: 'upload-1',
      });
      const partSize = 100 * 1024 * 1024;

      const exactMultiple = await videosService.createUploadSession(
        'video-1',
        'user-1',
        { sizeBytes: partSize * 3, contentType: 'video/mp4' },
      );
      expect(exactMultiple.partCount).toBe(3);

      const offByOne = await videosService.createUploadSession(
        'video-1',
        'user-1',
        { sizeBytes: partSize * 3 + 1, contentType: 'video/mp4' },
      );
      expect(offByOne.partCount).toBe(4);
    });
  });

  describe('presignUploadPart', () => {
    it('throws UploadSessionNotFoundException when no active session exists', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        channel_id: 'channel-1',
        upload_id: null,
        storage_key: null,
      } as Video);

      await expect(
        videosService.presignUploadPart('video-1', 'user-1', 1),
      ).rejects.toThrow(UploadSessionNotFoundException);
    });

    it('delegates to StorageService when a session is active', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        channel_id: 'channel-1',
        upload_id: 'upload-1',
        storage_key: 'videos/video-1/original.mp4',
      } as Video);
      storageService.presignUploadPart.mockResolvedValue('https://presigned');

      const url = await videosService.presignUploadPart('video-1', 'user-1', 2);

      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
        2,
      );
      expect(url).toBe('https://presigned');
    });
  });

  describe('abortUploadSession', () => {
    it('aborts via StorageService and clears the session fields', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        channel_id: 'channel-1',
        upload_id: 'upload-1',
        storage_key: 'videos/video-1/original.mp4',
        size_bytes: '1000',
      } as Video);

      await videosService.abortUploadSession('video-1', 'user-1');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
      );
      const saved = videoRepository.save.mock.calls[0][0];
      expect(saved.upload_id).toBeNull();
      expect(saved.storage_key).toBeNull();
      expect(saved.size_bytes).toBeNull();
    });
  });
});
