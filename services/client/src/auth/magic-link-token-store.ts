import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export type MagicLinkPurpose = 'login';

export type MagicLinkTokenRecord = {
  tokenHash: string;
  email: string;
  userId: number;
  purpose: MagicLinkPurpose;
  createdAt: string;
  expiresAt: string;
  expiresAtEpoch: number;
  usedAt?: string;
  appBaseUrl?: string;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class MagicLinkTokenStore {
  private readonly client: DynamoDBDocumentClient;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('AWS_ENDPOINT_URL') || this.config.get<string>('FLOCI_AWS_ENDPOINT_URL');
    this.client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: this.config.get<string>('AWS_REGION') || this.config.get<string>('AWS_DEFAULT_REGION') || 'eu-west-1',
        ...(endpoint ? { endpoint } : {}),
      }),
    );
  }

  async create(input: {
    email: string;
    userId: number;
    appBaseUrl?: string;
    ttlSeconds?: number;
    purpose?: MagicLinkPurpose;
    metadata?: Record<string, unknown>;
  }) {
    const tableName = this.getTableName();
    const token = crypto.randomBytes(32).toString('hex');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + (input.ttlSeconds ?? 15 * 60) * 1000);
    const record: MagicLinkTokenRecord = {
      tokenHash: this.hashToken(token),
      email: input.email,
      userId: input.userId,
      purpose: input.purpose ?? 'login',
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      expiresAtEpoch: Math.floor(expiresAt.getTime() / 1000),
      ...(input.appBaseUrl ? { appBaseUrl: input.appBaseUrl } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    await this.client.send(
      new PutCommand({
        TableName: tableName,
        Item: record,
        ConditionExpression: 'attribute_not_exists(tokenHash)',
      }),
    );

    return { token, record };
  }

  async consume(input: { token: string; email: string; purpose?: MagicLinkPurpose; now?: Date }) {
    const tableName = this.getTableName();
    const tokenHash = this.hashToken(input.token);
    const now = input.now ?? new Date();
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const purpose = input.purpose ?? 'login';

    const existing = await this.client.send(
      new GetCommand({
        TableName: tableName,
        Key: { tokenHash },
      }),
    );
    const record = existing.Item as MagicLinkTokenRecord | undefined;
    if (!record) throw new NotFoundException('Token not found');
    if (record.email !== input.email || record.purpose !== purpose) {
      throw new UnauthorizedException('Invalid token');
    }
    if (record.usedAt) throw new UnauthorizedException('Token already used');
    if (record.expiresAtEpoch <= nowEpoch) throw new UnauthorizedException('Token expired');

    try {
      const response = await this.client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { tokenHash },
          UpdateExpression: 'SET usedAt = :usedAt',
          ConditionExpression:
            'attribute_exists(tokenHash) AND email = :email AND purpose = :purpose AND attribute_not_exists(usedAt) AND expiresAtEpoch > :nowEpoch',
          ExpressionAttributeValues: {
            ':usedAt': now.toISOString(),
            ':email': input.email,
            ':purpose': purpose,
            ':nowEpoch': nowEpoch,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return response.Attributes as MagicLinkTokenRecord;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        throw new UnauthorizedException('Invalid or already used token');
      }
      throw error;
    }
  }

  hashToken(token: string) {
    return crypto
      .createHmac('sha256', this.getHashSecret())
      .update(token)
      .digest('hex');
  }

  private getHashSecret() {
    return (
      this.config.get<string>('MAGIC_LINK_TOKEN_HASH_SECRET') ||
      this.config.get<string>('AUTH_TOKEN_SECRET') ||
      this.config.get<string>('SESSION_SECRET') ||
      'dev-insecure-magic-link-token-secret'
    );
  }

  private getTableName() {
    const tableName = this.config.get<string>('MAGIC_LINK_TOKENS_TABLE_NAME');
    if (!tableName) throw new Error('MAGIC_LINK_TOKENS_TABLE_NAME is required');
    return tableName;
  }
}

function isConditionalCheckFailed(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ConditionalCheckFailedException'
  );
}
