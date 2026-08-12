# TechHealth AWS CDK Project

This directory contains the AWS CDK implementation for the TechHealth Inc. infrastructure migration.

The project contains two CDK stacks:

- `TechHealthInfrastructureStack`: target-state AWS infrastructure.
- `TechHealthPipelineStack`: automated AI security review pipeline.

The application obtains the AWS account from the active CDK/AWS credentials and uses the configured AWS region. Replace `YOUR_AWS_PROFILE` below with your local AWS CLI profile.

The root repository README documents the full project story, architecture decisions, evidence, and lessons learned. This README focuses on operating the CDK project.

## Project structure

```text
IaC/
├── bin/
│   └── app.ts                         CDK app entry point
├── lib/
│   ├── infrastructure-stack.ts        VPC, EC2, ALB, ASGs, RDS, IAM, and security groups
│   └── pipeline-stack.ts              S3, EventBridge, Lambda, Bedrock, and CloudWatch
├── lambda/
│   └── security-reviewer/
│       └── index.py                   Python security reviewer Lambda
├── cdk.json                           CDK app configuration
├── package.json                       Node.js dependencies and scripts
├── tsconfig.json                      TypeScript configuration
└── README.md                          This file
```

## Prerequisites

Install or configure the following before working in this directory:

- Node.js and npm
- AWS CLI
- AWS CDK CLI
- An authenticated AWS profile named `YOUR_AWS_PROFILE`
- Access to the AWS account associated with that profile
- Permission to use the `af-south-1` region
- Permission to deploy CloudFormation, EC2, VPC, RDS, S3, Lambda, EventBridge, IAM, Secrets Manager, CloudWatch, and Bedrock resources

Confirm the AWS identity before deploying:

```powershell
aws sts get-caller-identity --profile YOUR_AWS_PROFILE
```

The account should be the account associated with your active profile:

```text
YOUR_AWS_ACCOUNT_ID
```

All commands in this README assume that the current directory is `IaC`:

```powershell
cd "C:\PROJECTS (Temp Local Storage)\02-TechHealth-Inc-AWS-Migration\IaC"
```

On this Windows environment, use `cdk.cmd` if PowerShell blocks the `cdk.ps1` launcher because of its execution policy.

## Install dependencies

From the `IaC` directory:

```powershell
npm install
```

Compile the TypeScript project:

```powershell
npm run build
```

Run the unit tests:

```powershell
npm run test
```

## Bootstrap the CDK environment

CDK bootstrap is performed once per AWS account and region. It creates the shared `CDKToolkit` CloudFormation stack used by CDK deployments.

```powershell
cdk.cmd bootstrap aws://YOUR_AWS_ACCOUNT_ID/af-south-1 `
  --profile YOUR_AWS_PROFILE
```

The command can be run from the repository root or from the `IaC` directory because bootstrap targets the AWS account and region rather than this project. The `CDKToolkit` stack is separate from the two TechHealth application stacks and should normally remain in CloudFormation.

## Synthesize the stacks

Synthesis converts the TypeScript CDK application into CloudFormation templates. It does not deploy resources.

Synthesize both stacks:

```powershell
cdk.cmd synth --all `
  --profile YOUR_AWS_PROFILE
```

Synthesize one stack:

```powershell
cdk.cmd synth TechHealthInfrastructureStack `
  --profile YOUR_AWS_PROFILE
```

The generated templates are written to:

```text
cdk.out/
```

The infrastructure template is normally:

```text
cdk.out/TechHealthInfrastructureStack.template.json
```

## Stack overview

### TechHealthInfrastructureStack

This stack contains the target-state three-tier infrastructure:

- VPC spanning two Availability Zones
- Public and private subnets
- Internet Gateway
- NAT Gateway for private subnet egress
- Internet-facing Application Load Balancer
- Web-layer EC2 Auto Scaling Group
- App-layer EC2 Auto Scaling Group in private subnets
- Multi-AZ MySQL RDS instance in private subnets
- Secrets Manager database credentials
- ALB, web, app, and RDS security groups
- EC2 IAM role and instance profiles

The intended security-group path is:

```text
Internet → ALB SG → Web SG → App SG → RDS SG
```

The web instances are currently in public subnets. This is a documented security-review finding retained to demonstrate that the Bedrock pipeline identifies real misconfigurations. In a production environment, only the ALB should remain in public subnets.

### TechHealthPipelineStack

This stack contains the automated security review pipeline:

- S3 bucket for synthesized CloudFormation templates
- S3 bucket for security findings and audit reports
- EventBridge rule for S3 Object Created events
- Python 3.12 security reviewer Lambda
- Bedrock model invocation permissions
- AWS Marketplace permissions required for initial Anthropic model activation
- CloudWatch log group

The pipeline flow is:

```text
S3 template upload
        ↓
EventBridge Object Created event
        ↓
Security reviewer Lambda
        ↓
Amazon Bedrock security review
        ↓
Findings report written to S3
        ↓
CloudWatch execution logs
```

The pipeline surfaces findings for human review. It does not automatically approve or block deployments.

## Deploy the infrastructure

Deploy the infrastructure stack first:

```powershell
cdk.cmd deploy TechHealthInfrastructureStack `
  --profile YOUR_AWS_PROFILE `
  --require-approval never
```

The deployment creates the VPC, network layers, ALB, Auto Scaling Groups, RDS, security groups, IAM resources, and Secrets Manager secret.

## Deploy the security review pipeline

Deploy the pipeline stack after the infrastructure stack:

```powershell
cdk.cmd deploy TechHealthPipelineStack `
  --profile YOUR_AWS_PROFILE `
  --require-approval never
```

The pipeline stack is independent of the infrastructure stack and can also be deployed on its own when only the security review pipeline is being tested.

## Review deployed changes

Compare the local CDK application with the deployed CloudFormation stack:

```powershell
cdk.cmd diff TechHealthInfrastructureStack `
  --profile YOUR_AWS_PROFILE
```

```powershell
cdk.cmd diff TechHealthPipelineStack `
  --profile YOUR_AWS_PROFILE
```

Use `cdk.cmd synth` before `cdk.cmd diff` when you want to confirm that recent source changes are present in the generated template.

## Stack outputs

Display the infrastructure stack outputs:

```powershell
aws cloudformation describe-stacks `
  --stack-name TechHealthInfrastructureStack `
  --profile YOUR_AWS_PROFILE `
  --region af-south-1 `
  --query "Stacks[0].Outputs"
```

Important outputs include:

- VPC ID
- ALB DNS name
- RDS endpoint
- RDS Secrets Manager ARN

Display the pipeline stack outputs:

```powershell
aws cloudformation describe-stacks `
  --stack-name TechHealthPipelineStack `
  --profile YOUR_AWS_PROFILE `
  --region af-south-1 `
  --query "Stacks[0].Outputs"
```

Important pipeline outputs include:

- Templates bucket name
- Findings bucket name
- Security reviewer Lambda ARN
- Lambda CloudWatch log group

## Test the security review pipeline

The pipeline is triggered by uploading a synthesized CloudFormation template to the templates bucket.

First, confirm the generated template exists:

```powershell
Get-ChildItem .\cdk.out -Filter "*.template.json"
```

Then upload the infrastructure template using a unique object key:

```powershell
aws s3 cp `
  cdk.out/TechHealthInfrastructureStack.template.json `
  s3://techhealth-cdk-templates-YOUR_AWS_ACCOUNT_ID/test/TechHealthInfrastructureStack-test-1.json `
  --profile YOUR_AWS_PROFILE `
  --region af-south-1
```

The upload should trigger:

1. An S3 Object Created event.
2. The `techhealth-template-upload-trigger` EventBridge rule.
3. The `techhealth-security-reviewer` Lambda.
4. A Bedrock review using Claude.
5. A JSON findings report under the `findings/` prefix.
6. CloudWatch execution logs.

List the generated findings:

```powershell
aws s3 ls `
  s3://techhealth-security-findings-YOUR_AWS_ACCOUNT_ID/findings/ `
  --profile YOUR_AWS_PROFILE `
  --region af-south-1
```

The current implementation writes structured JSON reports. The JSON can be converted to Markdown for easier human reading. A future implementation may write Markdown directly from the Lambda.

View the Lambda logs in the AWS console at:

```text
/aws/lambda/techhealth-security-reviewer
```

The repository contains pipeline screenshots under:

```text
../screenshots/AI-Security-Review-Pipeline/
```

A generated report is retained under:

```text
../AI-Security-Review-Pipeline-Reports/
```

## Test EC2-to-RDS connectivity

The project uses SSM Session Manager rather than SSH for EC2 administration.

1. Deploy `TechHealthInfrastructureStack`.
2. Identify a running app-layer EC2 instance.
3. Connect through Systems Manager Session Manager.
4. Retrieve the current `RdsSecretArn` output from CloudFormation.
5. Use the AWS CLI on the instance to retrieve the secret without displaying it in evidence.
6. Install a MySQL-compatible client if necessary.
7. Connect to the RDS endpoint on TCP port 3306.
8. Run a read-only query such as:

```sql
SELECT @@hostname, DATABASE(), VERSION();
```

Do not expose the database password in terminal output or screenshots. The detailed evidence procedure is in:

```text
../docs/pipeline-evidence-guide.md
```

## Destroy the stacks

Destroy the pipeline stack first:

```powershell
cdk.cmd destroy TechHealthPipelineStack `
  --profile YOUR_AWS_PROFILE `
  --force
```

Then destroy the infrastructure stack:

```powershell
cdk.cmd destroy TechHealthInfrastructureStack `
  --profile YOUR_AWS_PROFILE `
  --force
```

Alternatively, destroy all stacks defined by this CDK application:

```powershell
cdk.cmd destroy --all `
  --profile YOUR_AWS_PROFILE `
  --force
```

If a stack was never deployed, CDK may report that the CloudFormation stack does not exist. That is not an error affecting deployed resources.

Destroying the infrastructure stack removes the RDS instance, NAT Gateway, ALB, Auto Scaling Groups, VPC, subnets, security groups, and related IAM resources. Destroying the pipeline stack removes the S3 buckets, Lambda, EventBridge rule, CloudWatch log group, and related IAM resources.

The `CDKToolkit` bootstrap stack is not part of these application stacks and should not be destroyed as part of normal project cleanup.

## Cost warning

The environment contains cost-generating resources, especially:

- NAT Gateway
- Multi-AZ RDS
- Application Load Balancer
- EC2 instances

Destroy the application stacks after testing is complete. Confirm that both stacks reach `DELETE_COMPLETE` in CloudFormation before ending the session.
