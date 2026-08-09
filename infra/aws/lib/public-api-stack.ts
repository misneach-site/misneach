import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface PublicApiStackProps extends cdk.StackProps {
  environmentName: string;
}

export class PublicApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PublicApiStackProps) {
    super(scope, id, props);
    const isLocal = props.environmentName === 'local';
    const localAwsEndpoint = process.env.FLOCI_LAMBDA_AWS_ENDPOINT_URL || 'http://floci:4566';
    const localAwsEnvironment: Record<string, string> = isLocal
        ? {
            AWS_ENDPOINT_URL: localAwsEndpoint,
            FLOCI_AWS_ENDPOINT_URL: localAwsEndpoint,
          }
      : {};
    const tableRemovalPolicy = isLocal ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    cdk.Tags.of(this).add('Application', 'decyphr');
    cdk.Tags.of(this).add('Service', 'public-api');
    cdk.Tags.of(this).add('Environment', props.environmentName);

    const runtimeConfigParameterRoot = `/misneach/${props.environmentName}`;
    const runtimeConfigParameterArnPrefix = `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${runtimeConfigParameterRoot}`;
    const runtimeConfigReaderRoleArn = this.node.tryGetContext('runtimeConfigReaderRoleArn') || process.env.RUNTIME_CONFIG_READER_ROLE_ARN;
    let runtimeConfigReaderRole: iam.IRole | undefined;

    if (runtimeConfigReaderRoleArn) {
      runtimeConfigReaderRole = iam.Role.fromRoleArn(
        this,
        'RuntimeConfigReaderRole',
        runtimeConfigReaderRoleArn,
        { mutable: true },
      );

      runtimeConfigReaderRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'ReadMisneachRuntimeConfigParameters',
          actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
          resources: [`${runtimeConfigParameterArnPrefix}/*`],
        }),
      );
      runtimeConfigReaderRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'DecryptMisneachRuntimeConfigParameters',
          actions: ['kms:Decrypt'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'kms:ViaService': `ssm.${cdk.Aws.REGION}.amazonaws.com`,
            },
          },
        }),
      );
    }

    const waitlistTable = new dynamodb.Table(this, 'WaitlistTable', {
      tableName: `decyphr-${props.environmentName}-waitlist`,
      partitionKey: {
        name: 'entryKey',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: tableRemovalPolicy,
    });

    const surveyTemplatesTable = new dynamodb.Table(this, 'SurveyTemplatesTable', {
      tableName: `decyphr-${props.environmentName}-survey-templates`,
      partitionKey: {
        name: 'key',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: tableRemovalPolicy,
    });
    surveyTemplatesTable.addGlobalSecondaryIndex({
      indexName: 'legacyMariaDbIdIndex',
      partitionKey: {
        name: 'legacyMariaDbId',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const surveyCampaignsTable = new dynamodb.Table(this, 'SurveyCampaignsTable', {
      tableName: `decyphr-${props.environmentName}-survey-campaigns`,
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: tableRemovalPolicy,
    });
    surveyCampaignsTable.addGlobalSecondaryIndex({
      indexName: 'manageTokenIndex',
      partitionKey: {
        name: 'manageToken',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const surveyResponsesTable = new dynamodb.Table(this, 'SurveyResponsesTable', {
      tableName: `decyphr-${props.environmentName}-survey-responses`,
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: tableRemovalPolicy,
    });
    surveyResponsesTable.addGlobalSecondaryIndex({
      indexName: 'templateKeyIndex',
      partitionKey: {
        name: 'templateKey',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    surveyResponsesTable.addGlobalSecondaryIndex({
      indexName: 'templateCampaignKeyIndex',
      partitionKey: {
        name: 'templateCampaignKey',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const magicLinkTokensTable = new dynamodb.Table(this, 'MagicLinkTokensTable', {
      tableName: `decyphr-${props.environmentName}-magic-link-tokens`,
      partitionKey: {
        name: 'tokenHash',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAtEpoch',
      removalPolicy: tableRemovalPolicy,
    });

    const publicEmailDlq = new sqs.Queue(this, 'PublicEmailDeadLetterQueue', {
      queueName: `decyphr-${props.environmentName}-public-email-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: tableRemovalPolicy,
    });
    const publicEmailQueue = new sqs.Queue(this, 'PublicEmailQueue', {
      queueName: `decyphr-${props.environmentName}-public-email`,
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: publicEmailDlq,
        maxReceiveCount: 3,
      },
      removalPolicy: tableRemovalPolicy,
    });

    const waitlistJoinHandler = new nodejs.NodejsFunction(this, 'WaitlistJoinHandler', {
      functionName: `decyphr-${props.environmentName}-waitlist-join`,
      entry: path.join(__dirname, '../../../services/public-api/src/waitlist/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      environment: {
        WAITLIST_TABLE_NAME: waitlistTable.tableName,
        ...localAwsEnvironment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });
    waitlistTable.grantReadWriteData(waitlistJoinHandler);

    const surveysHandler = new nodejs.NodejsFunction(this, 'SurveysHandler', {
      functionName: `decyphr-${props.environmentName}-surveys`,
      entry: path.join(__dirname, '../../../services/public-api/src/surveys/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: {
        SURVEY_TEMPLATES_TABLE_NAME: surveyTemplatesTable.tableName,
        SURVEY_CAMPAIGNS_TABLE_NAME: surveyCampaignsTable.tableName,
        SURVEY_RESPONSES_TABLE_NAME: surveyResponsesTable.tableName,
        PUBLIC_EMAIL_QUEUE_URL: publicEmailQueue.queueUrl,
        ...localAwsEnvironment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });
    surveyTemplatesTable.grantReadWriteData(surveysHandler);
    surveyCampaignsTable.grantReadWriteData(surveysHandler);
    surveyResponsesTable.grantReadWriteData(surveysHandler);
    publicEmailQueue.grantSendMessages(surveysHandler);

    if (runtimeConfigReaderRole) {
      magicLinkTokensTable.grantReadWriteData(runtimeConfigReaderRole);
      publicEmailQueue.grantSendMessages(runtimeConfigReaderRole);
    }

    const publicEmailWorker = new nodejs.NodejsFunction(this, 'PublicEmailWorker', {
      functionName: `decyphr-${props.environmentName}-public-email-worker`,
      entry: path.join(__dirname, '../../../services/public-api/src/email/worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        SURVEY_TEMPLATES_TABLE_NAME: surveyTemplatesTable.tableName,
        SURVEY_CAMPAIGNS_TABLE_NAME: surveyCampaignsTable.tableName,
        SURVEY_RESPONSES_TABLE_NAME: surveyResponsesTable.tableName,
        EMAIL_DELIVERY: isLocal ? 'log' : 'send',
        EMAIL_FROM_PARAMETER_NAME: `${runtimeConfigParameterRoot}/public-email/EMAIL_FROM`,
        RESEND_API_KEY_PARAMETER_NAME: `${runtimeConfigParameterRoot}/public-email/RESEND_API_KEY`,
        ...localAwsEnvironment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });
    surveyCampaignsTable.grantReadWriteData(publicEmailWorker);
    publicEmailQueue.grantConsumeMessages(publicEmailWorker);
    publicEmailWorker.addEventSource(
      new lambdaEventSources.SqsEventSource(publicEmailQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    publicEmailWorker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadPublicEmailParameters',
        actions: ['ssm:GetParameter'],
        resources: [`${runtimeConfigParameterArnPrefix}/public-email/*`],
      }),
    );
    publicEmailWorker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DecryptPublicEmailParameters',
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `ssm.${cdk.Aws.REGION}.amazonaws.com`,
          },
        },
      }),
    );

    const httpApi = new apigatewayv2.HttpApi(this, 'PublicHttpApi', {
      apiName: `decyphr-${props.environmentName}-public-api`,
      corsPreflight: {
        allowHeaders: ['content-type'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.OPTIONS,
          apigatewayv2.CorsHttpMethod.POST,
        ],
        allowOrigins: ['*'],
      },
    });

    const surveysIntegration = new integrations.HttpLambdaIntegration('SurveysIntegration', surveysHandler);

    httpApi.addRoutes({
      path: '/waitlist/join',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('WaitlistJoinIntegration', waitlistJoinHandler),
    });
    httpApi.addRoutes({
      path: '/surveys/templates/public/appetite',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: surveysIntegration,
    });
    httpApi.addRoutes({
      path: '/surveys/templates/{templateId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: surveysIntegration,
    });
    httpApi.addRoutes({
      path: '/surveys/templates/{templateId}/aggregate',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: surveysIntegration,
    });
    httpApi.addRoutes({
      path: '/surveys/campaigns',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: surveysIntegration,
    });
    httpApi.addRoutes({
      path: '/surveys/campaigns/by-token/{token}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: surveysIntegration,
    });
    httpApi.addRoutes({
      path: '/surveys/campaigns/{campaignId}/public',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: surveysIntegration,
    });
    httpApi.addRoutes({
      path: '/surveys/responses/{templateId}',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: surveysIntegration,
    });

    new cdk.CfnOutput(this, 'EnvironmentName', {
      value: props.environmentName,
      description: 'Deployment environment name used for resource naming.',
    });

    new cdk.CfnOutput(this, 'PublicApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'Base URL for public waitlist and survey API calls.',
    });

    new cdk.CfnOutput(this, 'RuntimeConfigParameterRoot', {
      value: runtimeConfigParameterRoot,
      description: 'SSM Parameter Store root for production/runtime service env rendering.',
    });

    new cdk.CfnOutput(this, 'RuntimeConfigParameterArnPattern', {
      value: `${runtimeConfigParameterArnPrefix}/*`,
      description: 'IAM resource pattern needed to read runtime config parameters.',
    });

    new cdk.CfnOutput(this, 'WaitlistTableName', {
      value: waitlistTable.tableName,
      description: 'DynamoDB table backing public waitlist joins.',
    });

    new cdk.CfnOutput(this, 'SurveyTemplatesTableName', {
      value: surveyTemplatesTable.tableName,
      description: 'DynamoDB table backing public survey templates.',
    });

    new cdk.CfnOutput(this, 'SurveyCampaignsTableName', {
      value: surveyCampaignsTable.tableName,
      description: 'DynamoDB table backing public survey campaigns.',
    });

    new cdk.CfnOutput(this, 'SurveyResponsesTableName', {
      value: surveyResponsesTable.tableName,
      description: 'DynamoDB table backing public survey responses.',
    });

    new cdk.CfnOutput(this, 'MagicLinkTokensTableName', {
      value: magicLinkTokensTable.tableName,
      description: 'DynamoDB table backing hashed magic-link tokens with TTL.',
    });

    new cdk.CfnOutput(this, 'PublicEmailQueueUrl', {
      value: publicEmailQueue.queueUrl,
      description: 'SQS queue for public email jobs.',
    });

    new cdk.CfnOutput(this, 'PublicEmailDeadLetterQueueUrl', {
      value: publicEmailDlq.queueUrl,
      description: 'SQS dead-letter queue for failed public email jobs.',
    });
  }
}
