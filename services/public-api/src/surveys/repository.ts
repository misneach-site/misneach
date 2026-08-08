import { QueryCommand, PutCommand, GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  aggregateSurveyResponses,
  buildSurveyCampaignLinks,
  buildSurveyQrUrl,
  defaultTemplateKey,
  normalizeSurveyQuestions,
  PublicFlowValidationError,
  SURVEY_TEMPLATES,
  validateSurveyAnswers,
  type SurveyQuestionDefinition,
  type SurveyTemplateDefinition,
} from '@misneach/public-flows';
import { randomBytes, randomUUID } from 'crypto';
import { HttpError } from '../http/responses';

export type SurveyRepositoryTables = {
  templatesTableName: string;
  campaignsTableName: string;
  responsesTableName: string;
};

type SurveyTemplateRecord = SurveyTemplateDefinition & {
  id: string;
  key: string;
  legacyId: string | null;
  legacyMariaDbId?: string | null;
  description: string | null;
  isActive: boolean;
};

export type SurveyCampaignEmailStatus = 'pending' | 'queued' | 'sent' | 'failed';

export type SurveyCampaignRecord = {
  id: string;
  manageToken: string;
  businessName: string;
  email: string;
  town: string | null;
  emailStatus: SurveyCampaignEmailStatus;
  emailStatusUpdatedAt: string;
  emailFailureReason?: string;
  createdAt: string;
  updatedAt: string;
};

type SurveyResponseRecord = {
  id: string;
  templateKey: string;
  campaignId: string | null;
  templateCampaignKey: string;
  answers: Record<string, unknown>;
  meta: Record<string, unknown>;
  submittedAt: string;
};

export class SurveysRepository {
  private seededTemplates: Promise<void> | null = null;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tables: SurveyRepositoryTables,
    private readonly now = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly createManageToken = () => randomBytes(18).toString('base64url'),
  ) {}

  async seedDefaultTemplates() {
    if (!this.seededTemplates) {
      this.seededTemplates = Promise.all(
        SURVEY_TEMPLATES.map((template) => {
          const key = defaultTemplateKey(template.id);
          const now = this.now().toISOString();
          const record: SurveyTemplateRecord = {
            id: key,
            key,
            legacyId: template.id,
            title: template.title,
            audience: template.audience,
            description: null,
            questions: template.questions,
            isActive: true,
          };
          return this.client.send(
            new PutCommand({
              TableName: this.tables.templatesTableName,
              Item: {
                ...record,
                createdAt: now,
                updatedAt: now,
              },
              ConditionExpression: 'attribute_not_exists(#key)',
              ExpressionAttributeNames: {
                '#key': 'key',
              },
            }),
          ).catch((error) => {
            if (isConditionalCheckFailed(error)) return undefined;
            throw error;
          });
        }),
      ).then(() => undefined);
    }

    return this.seededTemplates;
  }

  async getAppetiteTemplates() {
    const staff = await this.findTemplateByKeyOrLegacy('staff-appetite');
    const customers = await this.findTemplateByKeyOrLegacy('customers-appetite');
    return { staff, customers };
  }

  async getTemplate(templateId: string) {
    const template = await this.findTemplateByKeyOrLegacy(templateId);
    return { template };
  }

  async findTemplateByKeyOrLegacy(templateId: string): Promise<SurveyTemplateRecord> {
    await this.seedDefaultTemplates();
    const normalized = templateId.trim();
    if (!normalized) throw new HttpError(404, 'Survey template not found');

    const key = defaultTemplateKey(normalized);
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tables.templatesTableName,
        Key: { key },
      }),
    );

    const template = (response.Item as SurveyTemplateRecord | undefined) || await this.findTemplateByLegacyMariaDbId(normalized);
    if (!template || !template.isActive) {
      throw new HttpError(404, `Unknown survey template: ${templateId}`);
    }

    return {
      id: template.id,
      key: template.key,
      legacyId: template.legacyId ?? null,
      legacyMariaDbId: template.legacyMariaDbId ?? null,
      title: template.title,
      audience: template.audience,
      description: template.description ?? null,
      questions: normalizeSurveyQuestions(template.questions),
      isActive: template.isActive,
    };
  }

  async registerCampaign(input: { businessName?: unknown; email?: unknown; town?: unknown }, baseUrl: string) {
    const businessName = String(input.businessName || '').trim();
    const email = String(input.email || '').trim().toLowerCase();
    const town = String(input.town || '').trim();

    if (!businessName) throw new HttpError(400, 'businessName is required');
    if (!email) throw new HttpError(400, 'email is required');
    if (businessName.length > 140) throw new HttpError(400, 'businessName must be at most 140 characters');
    if (town.length > 120) throw new HttpError(400, 'town must be at most 120 characters');

    const timestamp = this.now().toISOString();
    const campaign: SurveyCampaignRecord = {
      id: this.createId(),
      manageToken: this.createManageToken(),
      businessName,
      email,
      town: town || null,
      emailStatus: 'pending',
      emailStatusUpdatedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.client.send(
      new PutCommand({
        TableName: this.tables.campaignsTableName,
        Item: campaign,
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );

    const links = buildSurveyCampaignLinks({ baseUrl, campaignId: campaign.id, manageToken: campaign.manageToken });
    return {
      saved: campaign,
      response: {
        campaign: {
          id: campaign.id,
          businessName: campaign.businessName,
          town: campaign.town,
          createdAt: campaign.createdAt,
        },
        links,
        qrCodes: buildQrCodes(links),
      },
    };
  }

  async getCampaignByToken(token: string, baseUrl: string) {
    const campaign = await this.findCampaignByToken(token);
    const links = buildSurveyCampaignLinks({ baseUrl, campaignId: campaign.id, manageToken: token });
    const staff = await this.findTemplateByKeyOrLegacy('staff-appetite');
    const customers = await this.findTemplateByKeyOrLegacy('customers-appetite');

    return {
      campaign: {
        id: campaign.id,
        businessName: campaign.businessName,
        town: campaign.town,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      },
      links,
      qrCodes: buildQrCodes(links),
      results: {
        staff: await this.aggregateTemplate(staff, campaign.id),
        customers: await this.aggregateTemplate(customers, campaign.id),
      },
    };
  }

  async getCampaignPublic(campaignId: string) {
    const campaign = await this.requireCampaign(campaignId);
    return {
      campaign: {
        id: campaign.id,
        businessName: campaign.businessName,
        town: campaign.town,
      },
    };
  }

  async submitResponse(templateId: string, payload: { campaignId?: unknown; answers?: unknown; meta?: unknown }) {
    const template = await this.findTemplateByKeyOrLegacy(templateId);
    const answers = (payload.answers || {}) as Record<string, unknown>;

    try {
      validateSurveyAnswers(template.questions, answers);
    } catch (error) {
      if (error instanceof PublicFlowValidationError) throw new HttpError(400, error.message);
      throw error;
    }

    let campaignId: string | null = null;
    if (payload.campaignId) {
      const campaign = await this.requireCampaign(String(payload.campaignId));
      campaignId = campaign.id;
    }

    const submittedAt = this.now().toISOString();
    const record: SurveyResponseRecord = {
      id: this.createId(),
      templateKey: template.key,
      campaignId,
      templateCampaignKey: buildTemplateCampaignKey(template.key, campaignId),
      answers,
      meta: isObjectRecord(payload.meta) ? payload.meta : {},
      submittedAt,
    };

    await this.client.send(
      new PutCommand({
        TableName: this.tables.responsesTableName,
        Item: record,
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );

    return {
      ok: true,
      responseId: record.id,
      submittedAt: record.submittedAt,
    };
  }

  async aggregate(templateId: string, campaignId?: string) {
    const template = await this.findTemplateByKeyOrLegacy(templateId);
    if (campaignId) await this.requireCampaign(campaignId);
    return this.aggregateTemplate(template, campaignId);
  }

  async markCampaignEmailQueued(campaignId: string) {
    return this.updateCampaignEmailStatus(campaignId, 'queued');
  }

  async markCampaignEmailSent(campaignId: string) {
    return this.updateCampaignEmailStatus(campaignId, 'sent');
  }

  async markCampaignEmailFailed(campaignId: string, reason: string) {
    return this.updateCampaignEmailStatus(campaignId, 'failed', reason);
  }

  private async aggregateTemplate(template: SurveyTemplateRecord, campaignId?: string) {
    const responses = campaignId
      ? await this.queryResponsesByTemplateCampaign(template.key, campaignId)
      : await this.queryResponsesByTemplate(template.key);

    return aggregateSurveyResponses({
      templateKey: template.key,
      title: template.title,
      audience: template.audience,
      questions: template.questions,
      responses,
    });
  }

  private async requireCampaign(campaignId: string): Promise<SurveyCampaignRecord> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tables.campaignsTableName,
        Key: { id: campaignId },
      }),
    );
    const campaign = response.Item as SurveyCampaignRecord | undefined;
    if (!campaign) throw new HttpError(404, 'Survey campaign not found');
    return campaign;
  }

  private async findCampaignByToken(token: string): Promise<SurveyCampaignRecord> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tables.campaignsTableName,
        IndexName: 'manageTokenIndex',
        KeyConditionExpression: 'manageToken = :token',
        ExpressionAttributeValues: {
          ':token': token,
        },
        Limit: 1,
      }),
    );
    const campaign = response.Items?.[0] as SurveyCampaignRecord | undefined;
    if (!campaign) throw new HttpError(404, 'Campaign token is invalid');
    return campaign;
  }

  private async findTemplateByLegacyMariaDbId(id: string): Promise<SurveyTemplateRecord | undefined> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tables.templatesTableName,
        IndexName: 'legacyMariaDbIdIndex',
        KeyConditionExpression: 'legacyMariaDbId = :id',
        ExpressionAttributeValues: {
          ':id': id,
        },
        Limit: 1,
      }),
    );
    return response.Items?.[0] as SurveyTemplateRecord | undefined;
  }

  private async queryResponsesByTemplate(templateKey: string): Promise<SurveyResponseRecord[]> {
    const items: SurveyResponseRecord[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tables.responsesTableName,
          IndexName: 'templateKeyIndex',
          KeyConditionExpression: 'templateKey = :templateKey',
          ExpressionAttributeValues: {
            ':templateKey': templateKey,
          },
          ExclusiveStartKey,
        }),
      );
      items.push(...((response.Items || []) as SurveyResponseRecord[]));
      ExclusiveStartKey = response.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  private async queryResponsesByTemplateCampaign(templateKey: string, campaignId: string): Promise<SurveyResponseRecord[]> {
    const items: SurveyResponseRecord[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tables.responsesTableName,
          IndexName: 'templateCampaignKeyIndex',
          KeyConditionExpression: 'templateCampaignKey = :templateCampaignKey',
          ExpressionAttributeValues: {
            ':templateCampaignKey': buildTemplateCampaignKey(templateKey, campaignId),
          },
          ExclusiveStartKey,
        }),
      );
      items.push(...((response.Items || []) as SurveyResponseRecord[]));
      ExclusiveStartKey = response.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  private async updateCampaignEmailStatus(
    campaignId: string,
    status: SurveyCampaignEmailStatus,
    failureReason?: string,
  ) {
    const timestamp = this.now().toISOString();
    const names: Record<string, string> = {
      '#emailStatus': 'emailStatus',
      '#emailStatusUpdatedAt': 'emailStatusUpdatedAt',
      '#updatedAt': 'updatedAt',
    };
    const values: Record<string, unknown> = {
      ':emailStatus': status,
      ':emailStatusUpdatedAt': timestamp,
      ':updatedAt': timestamp,
    };
    const setExpressions = [
      '#emailStatus = :emailStatus',
      '#emailStatusUpdatedAt = :emailStatusUpdatedAt',
      '#updatedAt = :updatedAt',
    ];
    let removeExpression = '';

    if (failureReason) {
      names['#emailFailureReason'] = 'emailFailureReason';
      values[':emailFailureReason'] = failureReason.slice(0, 500);
      setExpressions.push('#emailFailureReason = :emailFailureReason');
    } else {
      names['#emailFailureReason'] = 'emailFailureReason';
      removeExpression = ' REMOVE #emailFailureReason';
    }

    await this.client.send(
      new UpdateCommand({
        TableName: this.tables.campaignsTableName,
        Key: { id: campaignId },
        UpdateExpression: `SET ${setExpressions.join(',')}${removeExpression}`,
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }
}

export function buildTemplateCampaignKey(templateKey: string, campaignId: string | null) {
  return `${templateKey}#${campaignId || 'global'}`;
}

function buildQrCodes(links: { staffSurveyUrl: string; customersSurveyUrl: string }) {
  return {
    staff: {
      pngUrl: buildSurveyQrUrl(links.staffSurveyUrl, 'png'),
      svgUrl: buildSurveyQrUrl(links.staffSurveyUrl, 'svg'),
    },
    customers: {
      pngUrl: buildSurveyQrUrl(links.customersSurveyUrl, 'png'),
      svgUrl: buildSurveyQrUrl(links.customersSurveyUrl, 'svg'),
    },
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConditionalCheckFailed(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ConditionalCheckFailedException'
  );
}
