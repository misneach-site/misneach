# AWS Infrastructure

AWS CDK workspace for Decyphr infrastructure. The initial stack establishes the serverless public API deployment boundary for Misneach waitlist and survey flows without changing application behavior.

## Layout

- `bin/decyphr-public.ts`: CDK app entrypoint.
- `lib/public-api-stack.ts`: stack for public Misneach serverless resources.
- `cdk.json`: CDK command configuration.

## Environment

The real AWS serverless stack targets production. Local Floci deployments use the `local` environment name through the Floci scripts.

The stack name convention is:

```txt
decyphr-prod-public-api
```

The CDK app defaults to `prod` for real AWS deployments:

```bash
npm run synth --workspace @decyphr/aws-infra
```

Local Floci resources use names like `decyphr-local-public-api`, `decyphr-local-waitlist`, and `decyphr-local-survey-responses`.

## Commands

Bootstrap an AWS account/region once:

```bash
npm run bootstrap --workspace @decyphr/aws-infra -- aws://<account-id>/<region>
```

Preview generated CloudFormation:

```bash
npm run synth --workspace @decyphr/aws-infra
```

Preview changes:

```bash
npm run diff --workspace @decyphr/aws-infra
```

Deploy to AWS:

```bash
npm run deploy --workspace @decyphr/aws-infra
```

Attach runtime config SSM read permissions, magic-link token table access, and public email queue send permissions to an existing deploy/runtime IAM role:

```bash
npm run deploy --workspace @decyphr/aws-infra -- \
  --require-approval never \
  -c runtimeConfigReaderRoleArn=arn:aws:iam::<account-id>:role/<role-name>
```

Runtime compose env values are read from SSM under:

```txt
/misneach/prod/<service>/<ENV_VAR_NAME>
```

The stack outputs `RuntimeConfigParameterRoot`, `RuntimeConfigParameterArnPattern`, `MagicLinkTokensTableName`, `PublicEmailQueueUrl`, `PublicEmailDeadLetterQueueUrl`, `PublicApiDashboardName`, and `PublicApiDashboardUrl`.

## CloudWatch Dashboard

CDK creates a dashboard named `decyphr-<environment>-public-api`. For production, open the `PublicApiDashboardUrl` stack output or choose `decyphr-prod-public-api` in CloudWatch Dashboards.

The dashboard covers:

- API Gateway request count, 4xx, 5xx, latency, and integration latency.
- Lambda invocations, errors, duration, throttles, and concurrent executions for waitlist, surveys, and public email worker.
- DynamoDB consumed read/write capacity, throttle events, table operation system errors, and account-level user errors for waitlist and survey traffic.
- SQS visible messages, oldest message age, sent/received/deleted throughput, and DLQ depth for public email delivery.

Investigate sustained 5xx responses, Lambda errors or throttles, DynamoDB throttles/system errors/user errors, queue age growth, or any visible DLQ messages.

Deploy and write CDK outputs to a file:

```bash
npm run deploy --workspace @decyphr/aws-infra -- --require-approval never --outputs-file ../../cdk-public-api-outputs.json
```

## CI Deployment

Public API infrastructure has separate validation and deployment workflows:

- `.github/workflows/public-api-pr.yml` runs on pull requests and validates install, public-flow tests, public API Lambda tests/build, and CDK synth.
- `.github/workflows/public-api-deploy.yml` runs on pushes to `main` and deploys `decyphr-prod-public-api`.

Required repository/environment secrets:

```txt
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

The deploy workflow writes the `PublicApiUrl` stack output to the GitHub Actions step summary. Use that value for `PUBLIC_API_URL` in `misneach-web`.

## Rollback

To roll back a bad public API deploy, revert the PR that changed the stack or Lambda code and merge that revert to `main`; the deploy workflow will redeploy the previous desired state.

Manual rollback to a known-good commit is also possible:

```bash
git checkout <known-good-sha>
npm ci
npm run deploy --workspace @decyphr/aws-infra -- --require-approval never
```

If a deployment fails, inspect the CloudFormation events:

```bash
aws cloudformation describe-stack-events \
  --stack-name decyphr-prod-public-api \
  --region <region> \
  --max-items 25 \
  --output table
```

## Local Floci

Start local AWS services:

```bash
npm run floci:start
```

Synthesize against local settings:

```bash
npm run floci:cdk:synth
```

Bootstrap the local CDK toolkit stack once:

```bash
npm run floci:cdk:bootstrap
```

This command is safe to rerun locally. If Floci already has CDK bootstrap resources, the script treats that as a no-op.

Deploy the public API stack to Floci:

```bash
npm run floci:cdk:deploy
```

Run API-path integration tests against Floci DynamoDB:

```bash
npm run floci:test:public-api
```

The local stack includes HTTP API Gateway routes, Lambda handlers, and DynamoDB tables for waitlist and survey flows. Lambda functions in the local stack receive `AWS_ENDPOINT_URL`/`FLOCI_AWS_ENDPOINT_URL` so they use emulated DynamoDB.

## Public API Outputs

The stack outputs `PublicApiUrl`. Set `misneach-web` server-side `PUBLIC_API_URL` to that value to route the existing waitlist and survey proxies to Lambda:

```txt
PUBLIC_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com
```

`WAITLIST_API_URL` and `SURVEYS_API_URL` remain supported as flow-specific overrides.

Run a deployed smoke test:

```bash
PUBLIC_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com npm run smoke:public-api
PUBLIC_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com npm run smoke:public-api -- --write
```

## Legacy Data Migration

After deploying the stack, migrate existing MariaDB public-flow data from the EC2-backed services:

```bash
DB_HOST=<mariadb-host> \
DB_PORT=3306 \
DB_USER=<user> \
DB_PASSWORD=<password> \
DB_NAME=<database> \
AWS_REGION=<region> \
npm run migrate:mariadb --workspace public-api
```

When the dry-run counts look right, write to DynamoDB:

```bash
DB_HOST=<mariadb-host> \
DB_PORT=3306 \
DB_USER=<user> \
DB_PASSWORD=<password> \
DB_NAME=<database> \
AWS_REGION=<region> \
npm run migrate:mariadb:write --workspace public-api
```

The migration is idempotent: it preserves existing DynamoDB rows and keeps old MariaDB survey template primary IDs searchable through `legacyMariaDbIdIndex`.
