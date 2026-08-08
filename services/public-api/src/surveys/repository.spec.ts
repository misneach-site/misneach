import { SurveysRepository, buildTemplateCampaignKey } from './repository';
import { HttpError } from '../http/responses';

class InMemoryDynamo {
  readonly tables = new Map<string, Map<string, Record<string, unknown>>>();

  async send(command: { input: Record<string, any>; constructor: { name: string } }) {
    const input = command.input;
    const table = this.table(String(input.TableName));

    if (command.constructor.name === 'PutCommand') {
      const item = input.Item as Record<string, unknown>;
      const key = this.keyFor(String(input.TableName), item);
      if (input.ConditionExpression && table.has(key)) {
        throw { name: 'ConditionalCheckFailedException' };
      }
      table.set(key, item);
      return {};
    }

    if (command.constructor.name === 'GetCommand') {
      const key = this.keyFor(String(input.TableName), input.Key);
      return { Item: table.get(key) };
    }

    if (command.constructor.name === 'QueryCommand') {
      const values = input.ExpressionAttributeValues || {};
      const items = [...table.values()].filter((item) => {
        if (input.IndexName === 'manageTokenIndex') return item.manageToken === values[':token'];
        if (input.IndexName === 'templateKeyIndex') return item.templateKey === values[':templateKey'];
        if (input.IndexName === 'legacyMariaDbIdIndex') return item.legacyMariaDbId === values[':id'];
        if (input.IndexName === 'templateCampaignKeyIndex') {
          return item.templateCampaignKey === values[':templateCampaignKey'];
        }
        return false;
      });
      return { Items: input.Limit ? items.slice(0, input.Limit) : items };
    }

    if (command.constructor.name === 'UpdateCommand') {
      const key = this.keyFor(String(input.TableName), input.Key);
      const item = table.get(key);
      if (!item && input.ConditionExpression) {
        throw { name: 'ConditionalCheckFailedException' };
      }
      if (!item) throw new Error(`Missing item ${key}`);
      item.emailStatus = input.ExpressionAttributeValues[':emailStatus'];
      item.emailStatusUpdatedAt = input.ExpressionAttributeValues[':emailStatusUpdatedAt'];
      item.updatedAt = input.ExpressionAttributeValues[':updatedAt'];
      if (input.ExpressionAttributeValues[':emailFailureReason']) {
        item.emailFailureReason = input.ExpressionAttributeValues[':emailFailureReason'];
      } else {
        delete item.emailFailureReason;
      }
      table.set(key, item);
      return {};
    }

    throw new Error(`Unsupported command ${command.constructor.name}`);
  }

  private table(name: string) {
    const existing = this.tables.get(name);
    if (existing) return existing;
    const created = new Map<string, Record<string, unknown>>();
    this.tables.set(name, created);
    return created;
  }

  private keyFor(tableName: string, item: Record<string, unknown>) {
    if (tableName.includes('templates')) return String(item.key);
    if (tableName.includes('campaigns')) return String(item.id);
    if (tableName.includes('responses')) return String(item.id);
    throw new Error(`Unknown table ${tableName}`);
  }
}

describe('SurveysRepository', () => {
  function createRepo() {
    let id = 0;
    let token = 0;
    const dynamo = new InMemoryDynamo();
    const repo = new SurveysRepository(
      dynamo as never,
      {
        templatesTableName: 'survey-templates',
        campaignsTableName: 'survey-campaigns',
        responsesTableName: 'survey-responses',
      },
      () => new Date('2026-08-06T12:00:00.000Z'),
      () => `id-${++id}`,
      () => `token-${++token}`,
    );
    return { repo, dynamo };
  }

  it('seeds and returns default appetite templates', async () => {
    const { repo } = createRepo();
    const result = await repo.getAppetiteTemplates();

    expect(result.staff.key).toBe('staff-appetite');
    expect(result.staff.legacyId).toBe('staff-cafe-v1');
    expect(result.customers.key).toBe('customers-appetite');
    expect(result.customers.questions.length).toBeGreaterThan(0);
  });

  it('resolves legacy template ids', async () => {
    const { repo } = createRepo();
    const result = await repo.getTemplate('customers-cafe-v1');

    expect(result.template.key).toBe('customers-appetite');
    expect(result.template.legacyId).toBe('customers-cafe-v1');
  });

  it('resolves migrated MariaDB template primary ids', async () => {
    const { repo, dynamo } = createRepo();
    dynamo.tables.set(
      'survey-templates',
      new Map([
        [
          'migrated-template',
          {
            id: 'migrated-template',
            key: 'migrated-template',
            legacyId: 'old-template-key',
            legacyMariaDbId: '91546b36-0e1c-4f51-8869-8a0cc9422efe',
            title: 'Migrated template',
            audience: 'staff',
            questions: [
              {
                id: 'q1',
                label: 'Question 1',
                type: 'radio',
                required: true,
                options: ['Yes', 'No'],
              },
            ],
            isActive: true,
            createdAt: '2026-08-06T12:00:00.000Z',
            updatedAt: '2026-08-06T12:00:00.000Z',
          },
        ],
      ]),
    );

    const result = await repo.getTemplate('91546b36-0e1c-4f51-8869-8a0cc9422efe');

    expect(result.template.key).toBe('migrated-template');
    expect(result.template.legacyMariaDbId).toBe('91546b36-0e1c-4f51-8869-8a0cc9422efe');
  });

  it('creates campaigns, looks them up publicly and by manage token', async () => {
    const { repo } = createRepo();
    const created = await repo.registerCampaign(
      { businessName: 'Cafe Beag', email: 'HELLO@example.com', town: 'Galway' },
      'https://misneach.ie/',
    );

    expect(created.response.campaign).toEqual({
      id: 'id-1',
      businessName: 'Cafe Beag',
      town: 'Galway',
      createdAt: '2026-08-06T12:00:00.000Z',
    });
    expect(created.saved.emailStatus).toBe('pending');
    expect(created.response.links.manageUrl).toBe('https://misneach.ie/survey/manage?t=token-1');

    await expect(repo.getCampaignPublic('id-1')).resolves.toEqual({
      campaign: {
        id: 'id-1',
        businessName: 'Cafe Beag',
        town: 'Galway',
      },
    });

    const byToken = await repo.getCampaignByToken('token-1', 'https://misneach.ie');
    expect(byToken.campaign.id).toBe('id-1');
    expect(byToken.results.staff.responseCount).toBe(0);
  });

  it('tracks campaign email delivery status', async () => {
    const { repo, dynamo } = createRepo();
    await repo.registerCampaign({ businessName: 'Cafe Beag', email: 'hello@example.com' }, 'https://misneach.ie');

    await repo.markCampaignEmailQueued('id-1');
    expect(dynamo.tables.get('survey-campaigns')?.get('id-1')?.emailStatus).toBe('queued');

    await repo.markCampaignEmailFailed('id-1', 'Resend unavailable');
    expect(dynamo.tables.get('survey-campaigns')?.get('id-1')?.emailStatus).toBe('failed');
    expect(dynamo.tables.get('survey-campaigns')?.get('id-1')?.emailFailureReason).toBe('Resend unavailable');

    await repo.markCampaignEmailSent('id-1');
    expect(dynamo.tables.get('survey-campaigns')?.get('id-1')?.emailStatus).toBe('sent');
    expect(dynamo.tables.get('survey-campaigns')?.get('id-1')?.emailFailureReason).toBeUndefined();
  });

  it('submits valid responses and aggregates by template and campaign', async () => {
    const { repo } = createRepo();
    const campaign = await repo.registerCampaign(
      { businessName: 'Cafe Beag', email: 'hello@example.com' },
      'https://misneach.ie',
    );
    const campaignId = campaign.response.campaign.id;

    const submitted = await repo.submitResponse('customers-appetite', {
      campaignId,
      answers: {
        q1: 'None at all',
        q2: 'Never',
        q3: 'Pleasantly surprised',
        q4: "Yes - I'd do it straight away",
        q5: ['A sign on the door saying Irish is welcome', "Nothing - I'd just do it"],
        q6: "Probably - it's a nice thing to do",
      },
      meta: { source: 'test' },
    });

    expect(submitted).toEqual({
      ok: true,
      responseId: 'id-2',
      submittedAt: '2026-08-06T12:00:00.000Z',
    });

    const aggregate = await repo.aggregate('customers-cafe-v1', campaignId);
    expect(aggregate.responseCount).toBe(1);
    expect(aggregate.questions.q4.optionCounts["Yes - I'd do it straight away"]).toBe(1);
    expect(aggregate.questions.q5.optionCounts["Nothing - I'd just do it"]).toBe(1);
  });

  it('returns typed errors for invalid templates, campaigns, and answers', async () => {
    const { repo } = createRepo();

    await expect(repo.getTemplate('missing-template')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Unknown survey template: missing-template',
    } satisfies Partial<HttpError>);

    await expect(
      repo.submitResponse('staff-appetite', {
        answers: {},
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Missing required answer for q1',
    } satisfies Partial<HttpError>);

    await expect(repo.getCampaignPublic('missing-campaign')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Survey campaign not found',
    } satisfies Partial<HttpError>);
  });

  it('builds campaign response index keys', () => {
    expect(buildTemplateCampaignKey('staff-appetite', 'campaign-1')).toBe('staff-appetite#campaign-1');
    expect(buildTemplateCampaignKey('staff-appetite', null)).toBe('staff-appetite#global');
  });
});
