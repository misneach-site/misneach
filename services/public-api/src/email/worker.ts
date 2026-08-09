import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { createDynamoDocumentClient } from '../aws/dynamodb';
import { sendEmail } from './delivery';
import { sendSurveyCampaignLinksEmail } from '../surveys/email';
import { SurveysRepository } from '../surveys/repository';
import { parsePublicEmailJob, type PublicEmailJob } from './jobs';

let repository: SurveysRepository | null = null;

function getRepository() {
  if (repository) return repository;
  const templatesTableName = process.env.SURVEY_TEMPLATES_TABLE_NAME;
  const campaignsTableName = process.env.SURVEY_CAMPAIGNS_TABLE_NAME;
  const responsesTableName = process.env.SURVEY_RESPONSES_TABLE_NAME;
  if (!templatesTableName || !campaignsTableName || !responsesTableName) return null;

  repository = new SurveysRepository(createDynamoDocumentClient(), {
    templatesTableName,
    campaignsTableName,
    responsesTableName,
  });
  return repository;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      await handleRecord(record);
    } catch (error) {
      console.error('Public email job failed', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}

async function handleRecord(record: SQSRecord) {
  const job = parsePublicEmailJob(JSON.parse(record.body));
  await handleJob(job);
}

async function handleJob(job: PublicEmailJob) {
  if (job.type === 'survey.campaign-links') {
    try {
      await sendSurveyCampaignLinksEmail({
        email: job.recipientEmail,
        businessName: job.businessName,
        links: job.links,
      });
    } catch (error) {
      await getRepository()?.markCampaignEmailFailed(job.campaignId, toErrorMessage(error));
      throw error;
    }
    await getRepository()?.markCampaignEmailSent(job.campaignId).catch((error) => {
      console.error('Failed to mark survey campaign email as sent', {
        campaignId: job.campaignId,
        error: toErrorMessage(error),
      });
    });
    return;
  }

  if (job.type === 'email.send') {
    await sendEmail({
      to: job.to,
      subject: job.subject,
      html: job.html,
      text: job.text,
    });
    return;
  }

  throw new Error(`Unsupported public email job type: ${(job as { type?: string }).type}`);
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
