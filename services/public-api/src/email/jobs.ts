import type { SurveyCampaignLinks } from '@misneach/public-flows';

export type SurveyCampaignLinksEmailJob = {
  type: 'survey.campaign-links';
  campaignId: string;
  recipientEmail: string;
  businessName: string;
  links: SurveyCampaignLinks;
};

export type PublicEmailJob = SurveyCampaignLinksEmailJob;

export function parsePublicEmailJob(value: unknown): PublicEmailJob {
  if (!isRecord(value)) throw new Error('Email job payload must be an object');
  if (value.type === 'survey.campaign-links') {
    if (
      typeof value.campaignId === 'string' &&
      typeof value.recipientEmail === 'string' &&
      typeof value.businessName === 'string' &&
      isRecord(value.links)
    ) {
      return value as SurveyCampaignLinksEmailJob;
    }
  }

  throw new Error(`Unsupported public email job payload: ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
