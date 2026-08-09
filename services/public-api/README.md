# public-api

Lambda runtime package for public Misneach API handlers.

## Waitlist

`POST /waitlist/join` accepts the current public waitlist payload:

```json
{
  "email": "hello@example.com",
  "name": "Optional",
  "interest": "business_pack",
  "source": "/waitlist"
}
```

The response shape matches the existing service:

```json
{
  "ok": true,
  "alreadyJoined": false,
  "id": "..."
}
```

## Local Floci Integration

Start Floci, then run the API-path integration suite:

```bash
npm run floci:start
npm run floci:test:public-api
```

The integration tests create isolated local DynamoDB tables, start a local HTTP adapter over the Lambda handlers, and exercise the public routes with `fetch()`.

To run the public API HTTP adapter manually:

```bash
WAITLIST_TABLE_NAME=decyphr-local-waitlist \
SURVEY_TEMPLATES_TABLE_NAME=decyphr-local-survey-templates \
SURVEY_CAMPAIGNS_TABLE_NAME=decyphr-local-survey-campaigns \
SURVEY_RESPONSES_TABLE_NAME=decyphr-local-survey-responses \
AWS_ENDPOINT_URL=http://localhost:4566 \
npm run start:local --workspace public-api
```

The adapter starts at port `5174` by default and tries the next ports if that one is already in use. Override the starting port with `PUBLIC_API_LOCAL_PORT`.

## Surveys

The surveys Lambda preserves the public response shapes from the existing `business` service for:

- `GET /surveys/templates/public/appetite`
- `GET /surveys/templates/:templateId`
- `GET /surveys/templates/:templateId/aggregate`
- `POST /surveys/campaigns`
- `GET /surveys/campaigns/by-token/:token`
- `GET /surveys/campaigns/:campaignId/public`
- `POST /surveys/responses/:templateId`

Set `SURVEYS_API_URL` in `misneach-web` to the CDK `PublicApiUrl` output to route the existing `/api/surveys/*` proxy to Lambda.

Survey campaign setup sends public email through SQS instead of the request path:

1. `POST /surveys/campaigns` writes the campaign to DynamoDB with `emailStatus=pending`.
2. The survey Lambda enqueues a `survey.campaign-links` job and marks the campaign `queued`.
3. `decyphr-<env>-public-email-worker` consumes the job, sends via Resend, and marks the campaign `sent` or `failed`.
4. Failed worker attempts retry through SQS and eventually move to `decyphr-<env>-public-email-dlq`.

Production email worker config is read from SSM Parameter Store:

```txt
/misneach/prod/public-email/EMAIL_FROM
/misneach/prod/public-email/RESEND_API_KEY
```

Set `EMAIL_DELIVERY=log` only for local or test runs. Production CDK config sets the worker to `send` mode.

Check failed public email jobs:

```bash
aws sqs get-queue-attributes \
  --queue-url <PublicEmailDeadLetterQueueUrl> \
  --attribute-names ApproximateNumberOfMessages \
  --region eu-west-1
```

Replay a DLQ message by receiving it from the DLQ and sending the same body to `<PublicEmailQueueUrl>`, then deleting it from the DLQ after the send succeeds.

The same worker also accepts generic `email.send` jobs for follow-on public/auth flows such as magic-link email. Those jobs contain the final `to`, `subject`, `html`, and `text` payload, while the worker remains the only Lambda with Resend credentials.

## Misneach Web Cutover

Set `PUBLIC_API_URL` in `misneach-web` to the CDK `PublicApiUrl` output to route both public waitlist and survey proxies to Lambda:

```txt
PUBLIC_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com
```

`WAITLIST_API_URL` and `SURVEYS_API_URL` remain available as narrower overrides if either flow needs to move independently.

Smoke-test the deployed public API without writing data:

```bash
PUBLIC_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com npm run smoke:public-api
```

Run a write-path smoke during cutover:

```bash
PUBLIC_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com npm run smoke:public-api -- --write
```

## Legacy Data Migration

The MariaDB to DynamoDB migration is dry-run by default and maps existing waitlist entries, survey templates, campaigns, and responses to the serverless table shapes:

```bash
DB_HOST=<mariadb-host> \
DB_PORT=3306 \
DB_USER=<user> \
DB_PASSWORD=<password> \
DB_NAME=<database> \
AWS_REGION=<region> \
npm run migrate:mariadb --workspace public-api
```

Write to DynamoDB after reviewing the dry-run counts:

```bash
DB_HOST=<mariadb-host> \
DB_PORT=3306 \
DB_USER=<user> \
DB_PASSWORD=<password> \
DB_NAME=<database> \
AWS_REGION=<region> \
npm run migrate:mariadb:write --workspace public-api
```

The write migration uses conditional puts, so existing DynamoDB rows are left in place on reruns. Override target table names with `WAITLIST_TABLE_NAME`, `SURVEY_TEMPLATES_TABLE_NAME`, `SURVEY_CAMPAIGNS_TABLE_NAME`, and `SURVEY_RESPONSES_TABLE_NAME` when needed.
