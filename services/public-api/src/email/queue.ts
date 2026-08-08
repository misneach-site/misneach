import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../aws/sqs';
import type { PublicEmailJob, SurveyCampaignLinksEmailJob } from './jobs';

export async function enqueuePublicEmailJob(
  job: PublicEmailJob,
  options: {
    queueUrl?: string;
    sqs?: Pick<SQSClient, 'send'>;
    logger?: Pick<Console, 'log'>;
  } = {},
) {
  const queueUrl = options.queueUrl || process.env.PUBLIC_EMAIL_QUEUE_URL;
  const logger = options.logger || console;

  if (!queueUrl) {
    if ((process.env.EMAIL_DELIVERY || 'log') === 'log') {
      logger.log(`Public email queue not configured; logging ${job.type} email job for local delivery.`);
      return;
    }
    throw new Error('PUBLIC_EMAIL_QUEUE_URL is required');
  }

  const sqs = options.sqs || createSqsClient();
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(job),
    }),
  );
}

export function surveyCampaignLinksEmailJob(input: Omit<SurveyCampaignLinksEmailJob, 'type'>): SurveyCampaignLinksEmailJob {
  return {
    type: 'survey.campaign-links',
    ...input,
  };
}
