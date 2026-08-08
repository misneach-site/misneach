import { readParameter } from '../aws/ssm';

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export async function sendEmail(message: EmailMessage, logger: Pick<Console, 'log' | 'error'> = console) {
  const config = await readEmailConfig();

  if (config.deliveryMode === 'log') {
    logger.log('---- PUBLIC EMAIL ----');
    logger.log(`To: ${message.to}`);
    logger.log(`Subject: ${message.subject}`);
    logger.log(message.text);
    logger.log('----------------------');
    return;
  }

  if (!config.resendKey) throw new Error('RESEND_API_KEY is required for public email delivery');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.error(`Failed to send public email (${response.status}): ${text}`);
    throw new Error('Failed to send public email');
  }
}

async function readEmailConfig() {
  const deliveryMode =
    process.env.EMAIL_DELIVERY ||
    await readOptionalParameter(process.env.EMAIL_DELIVERY_PARAMETER_NAME, false) ||
    'log';
  const resendKey =
    process.env.RESEND_API_KEY ||
    await readOptionalParameter(process.env.RESEND_API_KEY_PARAMETER_NAME, true) ||
    '';
  const from =
    process.env.EMAIL_FROM ||
    await readOptionalParameter(process.env.EMAIL_FROM_PARAMETER_NAME, false) ||
    'no-reply@example.com';

  return { deliveryMode, resendKey, from };
}

async function readOptionalParameter(name: string | undefined, withDecryption: boolean) {
  if (!name) return undefined;
  try {
    return await readParameter(name, { withDecryption });
  } catch (error) {
    if (isParameterNotFound(error)) return undefined;
    throw error;
  }
}

function isParameterNotFound(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ParameterNotFound'
  );
}
