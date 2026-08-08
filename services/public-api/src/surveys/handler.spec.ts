process.env.SURVEY_TEMPLATES_TABLE_NAME = 'survey-templates';
process.env.SURVEY_CAMPAIGNS_TABLE_NAME = 'survey-campaigns';
process.env.SURVEY_RESPONSES_TABLE_NAME = 'survey-responses';
process.env.WEB_PUBLIC_URL = 'https://misneach.ie';
process.env.PUBLIC_EMAIL_QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/123/public-email';

const send = jest.fn();

jest.mock('../aws/dynamodb', () => ({
  createDynamoDocumentClient: () => ({ send }),
}));

jest.mock('../email/queue', () => ({
  enqueuePublicEmailJob: jest.fn().mockResolvedValue(undefined),
  surveyCampaignLinksEmailJob: jest.requireActual('../email/queue').surveyCampaignLinksEmailJob,
}));

import { handler } from './handler';
import { enqueuePublicEmailJob } from '../email/queue';

describe('survey Lambda handler', () => {
  beforeEach(() => {
    send.mockReset();
    jest.mocked(enqueuePublicEmailJob).mockClear();
    jest.mocked(enqueuePublicEmailJob).mockResolvedValue(undefined);
  });

  it('returns 400 for invalid JSON bodies', async () => {
    const response = await handler({
      rawPath: '/surveys/campaigns',
      requestContext: { http: { method: 'POST' } },
      body: '{nope',
      isBase64Encoded: false,
    } as never);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('Invalid JSON body');
  });

  it('routes campaign creation and queues campaign email', async () => {
    send.mockResolvedValue({});

    const response = await handler({
      rawPath: '/surveys/campaigns',
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({ businessName: 'Cafe Beag', email: 'hello@example.com' }),
      isBase64Encoded: false,
    } as never);

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).campaign.businessName).toBe('Cafe Beag');
    expect(enqueuePublicEmailJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'survey.campaign-links',
        recipientEmail: 'hello@example.com',
        businessName: 'Cafe Beag',
      }),
    );
  });

  it('returns 502 when campaign email cannot be queued', async () => {
    send.mockResolvedValue({});
    jest.mocked(enqueuePublicEmailJob).mockRejectedValueOnce(new Error('SQS is unavailable'));

    const response = await handler({
      rawPath: '/surveys/campaigns',
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({ businessName: 'Cafe Beag', email: 'hello@example.com' }),
      isBase64Encoded: false,
    } as never);

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toBe('Survey campaign email could not be queued');
  });

  it('returns 404 for unknown routes', async () => {
    const response = await handler({
      rawPath: '/surveys/nope',
      requestContext: { http: { method: 'GET' } },
      isBase64Encoded: false,
    } as never);

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toBe('Not found');
  });
});
