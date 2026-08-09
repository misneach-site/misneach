import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MagicLinkTokenStore } from './magic-link-token-store';

const send = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send })),
    },
  };
});

describe('MagicLinkTokenStore', () => {
  let store: MagicLinkTokenStore;

  beforeEach(() => {
    send.mockReset();
    store = new MagicLinkTokenStore({
      get: jest.fn((key: string, fallback?: string) => {
        const values: Record<string, string> = {
          MAGIC_LINK_TOKENS_TABLE_NAME: 'magic-link-tokens',
          MAGIC_LINK_TOKEN_HASH_SECRET: 'hash-secret',
          AWS_REGION: 'eu-west-1',
        };
        return values[key] ?? fallback;
      }),
    } as unknown as ConfigService);
  });

  it('creates raw tokens but stores only token hashes', async () => {
    send.mockResolvedValue({});

    const result = await store.create({
      email: 'hello@example.com',
      userId: 1,
      appBaseUrl: 'https://misneach.ie',
      ttlSeconds: 900,
    });

    expect(result.token).toEqual(expect.any(String));
    expect(result.record.tokenHash).toBe(store.hashToken(result.token));
    expect(result.record.tokenHash).not.toBe(result.token);
    expect(send.mock.calls[0][0].input.Item.tokenHash).toBe(result.record.tokenHash);
    expect(send.mock.calls[0][0].input.Item.token).toBeUndefined();
  });

  it('atomically marks valid tokens as used', async () => {
    const future = Math.floor(Date.now() / 1000) + 60;
    send
      .mockResolvedValueOnce({
        Item: {
          tokenHash: 'hash',
          email: 'hello@example.com',
          userId: 1,
          purpose: 'login',
          expiresAtEpoch: future,
        },
      })
      .mockResolvedValueOnce({
        Attributes: {
          tokenHash: 'hash',
          email: 'hello@example.com',
          userId: 1,
          purpose: 'login',
          expiresAtEpoch: future,
          usedAt: new Date().toISOString(),
        },
      });

    await expect(store.consume({ token: 'raw-token', email: 'hello@example.com' })).resolves.toMatchObject({
      email: 'hello@example.com',
      usedAt: expect.any(String),
    });

    expect(send.mock.calls[1][0].input.ConditionExpression).toContain('attribute_not_exists(usedAt)');
  });

  it('rejects missing, expired, and reused tokens', async () => {
    send.mockResolvedValueOnce({});
    await expect(store.consume({ token: 'missing', email: 'hello@example.com' })).rejects.toBeInstanceOf(NotFoundException);

    send.mockResolvedValueOnce({
      Item: {
        tokenHash: 'hash',
        email: 'hello@example.com',
        userId: 1,
        purpose: 'login',
        expiresAtEpoch: Math.floor(Date.now() / 1000) - 1,
      },
    });
    await expect(store.consume({ token: 'expired', email: 'hello@example.com' })).rejects.toMatchObject({
      message: 'Token expired',
    } satisfies Partial<UnauthorizedException>);

    send.mockResolvedValueOnce({
      Item: {
        tokenHash: 'hash',
        email: 'hello@example.com',
        userId: 1,
        purpose: 'login',
        expiresAtEpoch: Math.floor(Date.now() / 1000) + 60,
        usedAt: new Date().toISOString(),
      },
    });
    await expect(store.consume({ token: 'reused', email: 'hello@example.com' })).rejects.toMatchObject({
      message: 'Token already used',
    } satisfies Partial<UnauthorizedException>);
  });
});
