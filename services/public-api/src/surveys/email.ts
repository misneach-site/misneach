import {
  buildSurveyCampaignEmailText,
  renderSurveyCampaignEmailHtml,
  type SurveyCampaignLinks,
} from '@misneach/public-flows';
import { sendEmail } from '../email/delivery';

export async function sendSurveyCampaignLinksEmail(input: {
  email: string;
  businessName: string;
  links: SurveyCampaignLinks;
  logger?: Pick<Console, 'log' | 'error'>;
}) {
  const logger = input.logger || console;
  await sendEmail(
    {
      to: input.email,
      subject: `Your Misneach appetite survey links for ${input.businessName}`,
      html: renderSurveyCampaignEmailHtml(input.businessName, input.links),
      text: buildSurveyCampaignEmailText(input.businessName, input.links),
    },
    logger,
  );
}
