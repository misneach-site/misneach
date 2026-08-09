import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type MagicLinkEmailJob = {
  type: 'email.send';
  purpose: 'auth.magic-link';
  to: string;
  subject: string;
  html: string;
  text: string;
  metadata: {
    userId: number;
    clientId: string;
    appBaseUrl: string;
  };
};

@Injectable()
export class MagicLinkEmailQueue {
  private readonly client: SQSClient;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('AWS_ENDPOINT_URL') || this.config.get<string>('FLOCI_AWS_ENDPOINT_URL');
    this.client = new SQSClient({
      region: this.config.get<string>('AWS_REGION') || this.config.get<string>('AWS_DEFAULT_REGION') || 'eu-west-1',
      ...(endpoint ? { endpoint } : {}),
    });
  }

  async enqueue(job: MagicLinkEmailJob) {
    const queueUrl = this.config.get<string>('PUBLIC_EMAIL_QUEUE_URL');
    if (!queueUrl) return false;

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(job),
      }),
    );
    return true;
  }
}
