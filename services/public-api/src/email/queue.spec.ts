import { enqueuePublicEmailJob, surveyCampaignLinksEmailJob } from './queue';

describe('public email queue', () => {
  const originalQueueUrl = process.env.PUBLIC_EMAIL_QUEUE_URL;
  const originalDelivery = process.env.EMAIL_DELIVERY;

  afterEach(() => {
    restoreEnv('PUBLIC_EMAIL_QUEUE_URL', originalQueueUrl);
    restoreEnv('EMAIL_DELIVERY', originalDelivery);
  });

  it('sends typed public email jobs to SQS', async () => {
    const send = jest.fn().mockResolvedValue({});
    const job = surveyCampaignLinksEmailJob({
      campaignId: 'campaign-1',
      recipientEmail: 'hello@example.com',
      businessName: 'Cafe Beag',
      links: {
        staffSurveyUrl: 'https://misneach.ie/survey/staff',
        customersSurveyUrl: 'https://misneach.ie/survey/customers',
        manageUrl: 'https://misneach.ie/survey/manage?t=token',
      },
    });

    await enqueuePublicEmailJob(job, {
      queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123/public-email',
      sqs: { send } as never,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.QueueUrl).toBe('https://sqs.eu-west-1.amazonaws.com/123/public-email');
    expect(JSON.parse(send.mock.calls[0][0].input.MessageBody)).toMatchObject({
      type: 'survey.campaign-links',
      campaignId: 'campaign-1',
    });
  });

  it('fails when a queue URL is missing outside log delivery', async () => {
    delete process.env.PUBLIC_EMAIL_QUEUE_URL;
    process.env.EMAIL_DELIVERY = 'send';

    await expect(
      enqueuePublicEmailJob(surveyCampaignLinksEmailJob({
        campaignId: 'campaign-1',
        recipientEmail: 'hello@example.com',
        businessName: 'Cafe Beag',
        links: {
          staffSurveyUrl: 'https://misneach.ie/survey/staff',
          customersSurveyUrl: 'https://misneach.ie/survey/customers',
          manageUrl: 'https://misneach.ie/survey/manage?t=token',
        },
      })),
    ).rejects.toThrow('PUBLIC_EMAIL_QUEUE_URL is required');
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
