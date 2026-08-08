import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createDynamoDocumentClient } from '../aws/dynamodb';
import { enqueuePublicEmailJob, surveyCampaignLinksEmailJob } from '../email/queue';
import { HttpError, jsonResponse, parseJsonBody } from '../http/responses';
import { SurveysRepository } from './repository';

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

export async function handler(event: APIGatewayProxyEventV2) {
  const surveys = getRepository();
  if (!surveys) {
    return jsonResponse(500, { error: 'Survey table configuration is required' });
  }

  try {
    const path = event.rawPath || event.requestContext?.http?.path || '';
    const method = event.requestContext?.http?.method || event.routeKey?.split(' ')[0] || 'GET';

    if (method === 'GET' && path === '/surveys/templates/public/appetite') {
      return jsonResponse(200, await surveys.getAppetiteTemplates());
    }

    const aggregateMatch = path.match(/^\/surveys\/templates\/([^/]+)\/aggregate$/);
    if (method === 'GET' && aggregateMatch) {
      const campaignId = event.queryStringParameters?.campaignId;
      return jsonResponse(200, await surveys.aggregate(decodeURIComponent(aggregateMatch[1]), campaignId));
    }

    const templateMatch = path.match(/^\/surveys\/templates\/([^/]+)$/);
    if (method === 'GET' && templateMatch) {
      return jsonResponse(200, await surveys.getTemplate(decodeURIComponent(templateMatch[1])));
    }

    if (method === 'POST' && path === '/surveys/campaigns') {
      const body = readBody(event);
      const result = await surveys.registerCampaign(body, surveyBaseUrl());
      try {
        await enqueuePublicEmailJob(surveyCampaignLinksEmailJob({
          campaignId: result.saved.id,
          recipientEmail: result.saved.email,
          businessName: result.saved.businessName,
          links: result.response.links,
        }));
        await surveys.markCampaignEmailQueued(result.saved.id);
      } catch (error) {
        await surveys.markCampaignEmailFailed(result.saved.id, toErrorMessage(error)).catch((statusError) => {
          console.error('Failed to mark survey campaign email as failed', statusError);
        });
        throw new HttpError(502, 'Survey campaign email could not be queued');
      }
      return jsonResponse(201, result.response);
    }

    const tokenMatch = path.match(/^\/surveys\/campaigns\/by-token\/([^/]+)$/);
    if (method === 'GET' && tokenMatch) {
      return jsonResponse(200, await surveys.getCampaignByToken(decodeURIComponent(tokenMatch[1]), surveyBaseUrl()));
    }

    const campaignPublicMatch = path.match(/^\/surveys\/campaigns\/([^/]+)\/public$/);
    if (method === 'GET' && campaignPublicMatch) {
      return jsonResponse(200, await surveys.getCampaignPublic(decodeURIComponent(campaignPublicMatch[1])));
    }

    const responseMatch = path.match(/^\/surveys\/responses\/([^/]+)$/);
    if (method === 'POST' && responseMatch) {
      const body = readBody(event);
      return jsonResponse(201, await surveys.submitResponse(decodeURIComponent(responseMatch[1]), body));
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.statusCode, { error: error.message, message: error.message });
    }

    console.error('Survey API failed', error);
    return jsonResponse(500, { error: 'Survey API failed' });
  }
}

function readBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const body = parseJsonBody(event.body, event.isBase64Encoded);
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function surveyBaseUrl() {
  return process.env.SURVEY_PUBLIC_BASE_URL || process.env.WEB_PUBLIC_URL || 'http://localhost:5173';
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
