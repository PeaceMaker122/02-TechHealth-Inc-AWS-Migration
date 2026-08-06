import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as path from 'path';

// PipelineStack — automated AI security review pipeline.
//
// Pipeline flow (mirrors decisions.md Task 3, "What I did"):
//   1. CDK deployment process uploads synthesized CloudFormation template → templates S3 bucket
//   2. S3 Object Created event fires → EventBridge rule picks it up
//   3. EventBridge triggers Lambda (security-reviewer)
//   4. Lambda reads template from S3, submits to Bedrock (Claude) with security review prompt
//   5. Bedrock returns findings → Lambda writes timestamped JSON report → findings S3 bucket
//   6. Lambda logs full execution → CloudWatch log group
//
// This pipeline surfaces findings for human review only. It does not block deployments
// autonomously. All accept/reject decisions remain with the consultant. (decisions.md #6)

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // S3 Bucket 1 — CDK Templates
    // -------------------------------------------------------------------------
    // Receives synthesized CloudFormation templates uploaded before deployment.
    // This bucket is the trigger point for the entire pipeline — an Object Created
    // event on this bucket fires the EventBridge rule below.
    //
    // Versioning is enabled so that every template upload is retained and
    // individually addressable. This supports the audit trail goal.
    //
    // All public access is blocked. Templates contain infrastructure definitions
    // and must never be publicly readable.
    const templatesBucket = new s3.Bucket(this, 'CdkTemplatesBucket', {
      bucketName: `techhealth-cdk-templates-${this.account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // SSE-S3 at rest
      enforceSSL: true, // Reject any HTTP (non-TLS) requests to the bucket
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Allow cdk destroy during development
      autoDeleteObjects: true, // Required when removalPolicy is DESTROY
    });

    // -------------------------------------------------------------------------
    // S3 Bucket 2 — Findings and Audit Reports
    // -------------------------------------------------------------------------
    // Separate from the templates bucket (decisions.md Task 3, "What I rejected" —
    // mixing findings and templates in one bucket was ruled out to keep the audit
    // trail clean and independently queryable).
    //
    // Lambda writes timestamped JSON findings reports here after each review.
    // Lifecycle rule retains reports for 365 days before transitioning to
    // Glacier, preserving the durable audit trail at minimal long-term cost.
    const findingsBucket = new s3.Bucket(this, 'FindingsBucket', {
      bucketName: `techhealth-security-findings-${this.account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          // After 365 days, move findings to Glacier for low-cost long-term retention.
          // Findings are rarely accessed after the immediate review window but must
          // be retained for compliance and audit purposes.
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(365),
            },
          ],
        },
      ],
    });

    // -------------------------------------------------------------------------
    // CloudWatch Log Group — Lambda execution logs
    // -------------------------------------------------------------------------
    // Explicitly created so the log group has a predictable name, a defined
    // retention period, and is cleaned up with the stack on cdk destroy.
    // Without this, Lambda auto-creates a log group with no retention limit,
    // which accumulates cost indefinitely.
    const lambdaLogGroup = new logs.LogGroup(this, 'SecurityReviewerLogGroup', {
      logGroupName: '/aws/lambda/techhealth-security-reviewer',
      retention: logs.RetentionDays.THREE_MONTHS, // 90 days covers any reasonable audit window
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------------------------
    // IAM Role — Lambda execution role
    // -------------------------------------------------------------------------
    // Scoped to the minimum permissions needed by the Lambda function:
    //   - S3 GetObject on the templates bucket (read the uploaded template)
    //   - S3 PutObject on the findings bucket (write the review report)
    //   - Bedrock InvokeModel (call Claude for the security review)
    //   - CloudWatch Logs (write execution logs to the log group above)
    //
    // No wildcard resources. Each grant is scoped to a specific bucket ARN
    // or the Bedrock Claude model ARN. This satisfies the least-privilege IAM
    // requirement that is itself one of the security checks the pipeline enforces.
    const lambdaRole = new iam.Role(this, 'SecurityReviewerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for TechHealth security reviewer Lambda',
    });

    // Allow Lambda to read CloudFormation templates from the templates bucket.
    // grantRead scopes the policy to GetObject + ListBucket on this bucket only.
    templatesBucket.grantRead(lambdaRole);

    // Allow Lambda to write findings reports to the findings bucket.
    // grantPut scopes the policy to PutObject on this bucket only.
    findingsBucket.grantPut(lambdaRole);

    // Allow Lambda to write logs to CloudWatch.
    // This is equivalent to the AWSLambdaBasicExecutionRole managed policy
    // but scoped to the specific log group rather than using a wildcard.
    lambdaLogGroup.grantWrite(lambdaRole);

    // Allow Lambda to invoke Bedrock models.
    // The ARN pattern covers all Claude models in af-south-1 under this account.
    // If a specific model ID needs to be pinned later, replace the wildcard
    // with the exact model ARN (e.g. anthropic.claude-3-5-sonnet-20241022-v2:0).
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvokeModel',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      // Scoped to Claude models in this region and account.
      // The wildcard covers model versions without requiring a code change
      // when Anthropic releases a new version.
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
      ],
    }));

    // -------------------------------------------------------------------------
    // Lambda Function — Security Reviewer
    // -------------------------------------------------------------------------
    // Python 3.12 runtime with boto3 for Bedrock API calls.
    // Python was chosen over Node.js because boto3 is the mature, well-documented
    // library for Bedrock in Python. (decisions.md — Lambda runtime decision)
    //
    // The function code lives in lambda/security-reviewer/index.py.
    // Code.fromAsset bundles the directory and uploads it to the CDK assets
    // S3 bucket during cdk deploy. This is equivalent to packaging a Lambda
    // zip manually, but CDK handles the zip and upload automatically.
    //
    // Timeout: 5 minutes. Bedrock calls can take 10-30 seconds for large templates;
    // 300 seconds gives comfortable headroom while capping runaway executions.
    // Memory: 256 MB. The function reads a CloudFormation template (typically
    // <1 MB) and makes an API call — 256 MB is more than sufficient.
    const securityReviewerFn = new lambda.Function(this, 'SecurityReviewerFunction', {
      functionName: 'techhealth-security-reviewer',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler', // handler function inside lambda/security-reviewer/index.py
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'security-reviewer')),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(300), // 5 minutes — headroom for Bedrock API latency
      memorySize: 256,
      // Tell the function which buckets to read from and write to.
      // Using environment variables means the bucket names don't need to be
      // hardcoded in the Python code — they are injected at deploy time.
      environment: {
        TEMPLATES_BUCKET_NAME: templatesBucket.bucketName,
        FINDINGS_BUCKET_NAME: findingsBucket.bucketName,
        BEDROCK_REGION: this.region,
      },
      // Point Lambda at the explicitly created log group so logs land in a
      // predictable, retention-controlled location rather than an auto-created one.
      logGroup: lambdaLogGroup,
    });

    // -------------------------------------------------------------------------
    // EventBridge Rule — trigger Lambda on S3 Object Created
    // -------------------------------------------------------------------------
    // EventBridge (formerly CloudWatch Events) detects new object uploads to
    // the templates bucket and invokes the Lambda function automatically.
    // This eliminates any manual trigger step in the deployment workflow —
    // every template upload triggers a review with no human action required.
    // (decisions.md Task 3, "Why I did it")
    //
    // S3 event notifications require EventBridge to be enabled on the bucket.
    // addEventNotification below does this automatically.
    //
    // The rule filters on:
    //   - source: aws.s3
    //   - detail-type: Object Created
    //   - bucket name: templatesBucket
    // This ensures only uploads to the templates bucket trigger the function,
    // not uploads to the findings bucket or any other bucket.
    const reviewTriggerRule = new events.Rule(this, 'TemplateUploadRule', {
      ruleName: 'techhealth-template-upload-trigger',
      description: 'Triggers security reviewer Lambda when a new CDK template is uploaded',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [templatesBucket.bucketName],
          },
        },
      },
    });

    // Wire the EventBridge rule to invoke the Lambda function.
    // addTarget grants EventBridge the necessary lambda:InvokeFunction permission
    // on the function automatically — no manual resource policy needed.
    reviewTriggerRule.addTarget(new targets.LambdaFunction(securityReviewerFn));

    // Enable EventBridge notifications on the templates bucket.
    // Without this, S3 will not emit Object Created events to EventBridge
    // even if the rule above is in place.
    templatesBucket.enableEventBridgeNotification();

    // -------------------------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------------------------

    new cdk.CfnOutput(this, 'TemplatesBucketName', {
      value: templatesBucket.bucketName,
      description: 'S3 bucket — upload synthesized CDK templates here before deploying',
    });

    new cdk.CfnOutput(this, 'FindingsBucketName', {
      value: findingsBucket.bucketName,
      description: 'S3 bucket — security review findings and audit reports are written here',
    });

    new cdk.CfnOutput(this, 'SecurityReviewerFunctionArn', {
      value: securityReviewerFn.functionArn,
      description: 'ARN of the security reviewer Lambda function',
    });

    new cdk.CfnOutput(this, 'LambdaLogGroupName', {
      value: lambdaLogGroup.logGroupName,
      description: 'CloudWatch log group for security reviewer Lambda execution logs',
    });
  }
}
