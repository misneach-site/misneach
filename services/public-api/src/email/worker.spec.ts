process.env.SURVEY_TEMPLATES_TABLE_NAME = 'survey-templates';
process.env.SURVEY_CAMPAIGNS_TABLE_NAME = 'survey-campaigns';
process.env.SURVEY_RESPONSES_TABLE_NAME = 'survey-responses';

const send = jest.fn();

jest.mock('../aws/dynamodb', () => ({
  createDynamoDocumentClient: () => ({ send }),
}));

jest.mock('../surveys/email', () => ({
  sendSurveyCampaignLinksEmail: jest.fn().mockResolvedValue(undefined),
}));

import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { sendSurveyCampaignLinksEmail } from '../surveys/email';
import { handler } from './worker';

describe('public email worker', () => {
  let consoleError: jest.SpyInstance;

  beforeAll(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    jest.mocked(sendSurveyCampaignLinksEmail).mockClear();
    jest.mocked(sendSurveyCampaignLinksEmail).mockResolvedValue(undefined);
  });

  afterAll(() => {
    consoleError.mockRestore();
  });

  it('sends survey campaign link emails from queued jobs', async () => {
    const response = await handler(eventFor({
      type: 'survey.campaign-links',
      campaignId: 'campaign-1',
      recipientEmail: 'hello@example.com',
      businessName: 'Cafe Beag',
      links: {
        staffSurveyUrl: 'https://misneach.ie/survey/staff',
        customersSurveyUrl: 'https://misneach.ie/survey/customers',
        manageUrl: 'https://misneach.ie/survey/manage?t=token',
      },
    }));

    expect(response.batchItemFailures).toEqual([]);
    expect(sendSurveyCampaignLinksEmail).toHaveBeenCalledWith({
      email: 'hello@example.com',
      businessName: 'Cafe Beag',
      links: expect.objectContaining({
        manageUrl: 'https://misneach.ie/survey/manage?t=token',
      }),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.UpdateExpression).toContain('#emailStatus = :emailStatus');
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':emailStatus']).toBe('sent');
  });

  it('marks failed sends and returns a batch failure for retry', async () => {
    jest.mocked(sendSurveyCampaignLinksEmail).mockRejectedValueOnce(new Error('Resend unavailable'));

    const response = await handler(eventFor({
      type: 'survey.campaign-links',
      campaignId: 'campaign-1',
      recipientEmail: 'hello@example.com',
      businessName: 'Cafe Beag',
      links: {
        staffSurveyUrl: 'https://misneach.ie/survey/staff',
        customersSurveyUrl: 'https://misneach.ie/survey/customers',
        manageUrl: 'https://misneach.ie/survey/manage?t=token',
      },
    }));

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'message-1' }]);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':emailStatus']).toBe('failed');
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':emailFailureReason']).toBe('Resend unavailable');
  });
});

function eventFor(body: unknown): SQSEvent {
  return {
    Records: [
      {
        messageId: 'message-1',
        body: JSON.stringify(body),
      } as SQSRecord,
    ],
  };
}
