import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

let client: SSMClient | null = null;
const cache = new Map<string, string>();

export function createSsmClient() {
  if (client) return client;
  const endpoint = process.env.AWS_ENDPOINT_URL || process.env.FLOCI_AWS_ENDPOINT_URL;
  client = new SSMClient({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-1',
    ...(endpoint ? { endpoint } : {}),
  });
  return client;
}

export async function readParameter(name: string, options: { withDecryption?: boolean } = {}) {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const response = await createSsmClient().send(
    new GetParameterCommand({
      Name: name,
      WithDecryption: options.withDecryption ?? true,
    }),
  );
  const value = response.Parameter?.Value;
  if (value === undefined) throw new Error(`SSM parameter ${name} has no value`);
  cache.set(name, value);
  return value;
}
