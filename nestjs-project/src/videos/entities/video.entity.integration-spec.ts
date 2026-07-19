import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My video',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject an invalid enum value for status', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "title", "status") VALUES ($1, $2, $3)`,
        [channel.id, 'Bad status', 'not_a_status'],
      ),
    ).rejects.toThrow();
  });

  it('should enforce unique storage_key constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'First',
        storage_key: 'videos/dup/original.mp4',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          title: 'Second',
          storage_key: 'videos/dup/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video with a non-existent channel_id (FK constraint)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'Orphan',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should allow null storage_key, thumbnail_key, and metadata fields', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Untouched',
      }),
    );

    expect(video.storage_key).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.error_message).toBeNull();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Relation test',
      }),
    );

    const found = await videoRepository.findOne({
      where: { title: 'Relation test' },
      relations: ['channel'],
    });

    expect(found?.channel.nickname).toBe(channel.nickname);
  });
});
