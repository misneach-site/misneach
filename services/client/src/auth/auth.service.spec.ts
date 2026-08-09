import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { User } from './entities/User';
import { MagicLinkEmailQueue } from './magic-link-email-queue';
import { MagicLinkTokenStore } from './magic-link-token-store';

describe('AuthService token auth', () => {
  let service: AuthService;
  const userRepo = {
    findOne: jest.fn(),
  };
  const magicLinkRepo = {
    createQueryBuilder: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const magicLinkTokenStore = {
    create: jest.fn(),
    consume: jest.fn(),
  };
  const magicLinkEmailQueue = {
    enqueue: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(User),
          useValue: userRepo,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: string) => {
              const values: Record<string, string> = {
                RESEND_API_KEY: 're_test_key',
                AUTH_TOKEN_SECRET: 'unit-test-secret',
                SESSION_SECRET: 'unit-test-session-secret',
                EMAIL_DELIVERY: 'log',
                APP_URL: 'https://misneach.ie',
              };
              return values[key] ?? fallback;
            }),
          },
        },
        {
          provide: MagicLinkTokenStore,
          useValue: magicLinkTokenStore,
        },
        {
          provide: MagicLinkEmailQueue,
          useValue: magicLinkEmailQueue,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('issues access and refresh token pair', () => {
    const user = {
      id: 1,
      email: 'user@example.com',
      clientId: 'client-1',
      role: 'learner',
      hasCompletedSignup: false,
    } as User;

    const result = service.issueTokenPair(user);
    expect(result.ok).toBe(true);
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.expiresInSec).toBe(900);
  });

  it('refreshes token pair for valid refresh token', async () => {
    const user = {
      id: 2,
      email: 'user2@example.com',
      clientId: 'client-2',
      role: 'learner',
      hasCompletedSignup: true,
    } as User;
    const initial = service.issueTokenPair(user);
    userRepo.findOne.mockResolvedValue(user);

    const refreshed = await service.refreshTokenPair(initial.refreshToken);
    expect(userRepo.findOne).toHaveBeenCalledWith({
      where: { id: 2 },
    });
    expect(refreshed.ok).toBe(true);
    expect(refreshed.accessToken).toEqual(expect.any(String));
    expect(refreshed.refreshToken).toEqual(expect.any(String));
  });

  it('creates DynamoDB magic-link tokens and logs email in log delivery mode', async () => {
    const user = {
      id: 3,
      email: 'hello@example.com',
      clientId: 'client-3',
      role: 'learner',
      hasCompletedSignup: false,
    } as User;
    userRepo.findOne.mockResolvedValue(user);
    magicLinkTokenStore.create.mockResolvedValue({
      token: 'raw-token',
      record: {
        tokenHash: 'hash',
        email: user.email,
        userId: user.id,
      },
    });
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(service.handleMagicLink('HELLO@example.com')).resolves.toEqual({
      message: 'Magic link generated (email delivery disabled)',
    });

    expect(magicLinkTokenStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'hello@example.com',
        userId: 3,
        appBaseUrl: 'https://misneach.ie',
      }),
    );
    expect(magicLinkRepo.create).not.toHaveBeenCalled();
    consoleLog.mockRestore();
  });

  it('consumes DynamoDB magic-link tokens before issuing token pairs', async () => {
    const user = {
      id: 4,
      email: 'hello@example.com',
      clientId: 'client-4',
      role: 'learner',
      hasCompletedSignup: true,
    } as User;
    magicLinkTokenStore.consume.mockResolvedValue({
      tokenHash: 'hash',
      email: user.email,
      userId: user.id,
    });
    userRepo.findOne.mockResolvedValue(user);

    const result = await service.issueTokenPairFromMagicLink('HELLO@example.com', 'raw-token');

    expect(magicLinkTokenStore.consume).toHaveBeenCalledWith({
      token: 'raw-token',
      email: 'hello@example.com',
      purpose: 'login',
    });
    expect(result.ok).toBe(true);
  });
});
