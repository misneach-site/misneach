import type { SurveyCampaignLinks } from '@misneach/public-flows';

export type SurveyCampaignLinksEmailJob = {
  type: 'survey.campaign-links';
  campaignId: string;
  recipientEmail: string;
  businessName: string;
  links: SurveyCampaignLinks;
};

export type SendEmailJob = {
  type: 'email.send';
  purpose: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type PublicEmailJob = SurveyCampaignLinksEmailJob | SendEmailJob;

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

  if (value.type === 'email.send') {
    if (
      typeof value.purpose === 'string' &&
      typeof value.to === 'string' &&
      typeof value.subject === 'string' &&
      typeof value.html === 'string' &&
      typeof value.text === 'string'
    ) {
      return {
        type: 'email.send',
        purpose: value.purpose,
        to: value.to,
        subject: value.subject,
        html: value.html,
        text: value.text,
        ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
      };
    }
  }

  throw new Error(`Unsupported public email job payload: ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
