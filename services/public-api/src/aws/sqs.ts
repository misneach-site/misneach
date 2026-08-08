import { SQSClient } from '@aws-sdk/client-sqs';

let client: SQSClient | null = null;

export function createSqsClient() {
  if (client) return client;
  const endpoint = process.env.AWS_ENDPOINT_URL || process.env.FLOCI_AWS_ENDPOINT_URL;
  client = new SQSClient({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-1',
    ...(endpoint ? { endpoint } : {}),
  });
  return client;
}
