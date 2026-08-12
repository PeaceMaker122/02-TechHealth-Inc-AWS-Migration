#!/usr/bin/env node

// CDK app entry point.
// This file is the equivalent of a Terraform root module, instantiating every
// stack and wiring them together. The account and region are obtained from the
// active CDK/AWS environment so this public repository contains no account ID.

import * as cdk from 'aws-cdk-lib';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

// Shared environment config. CDK sets these values from the active AWS profile
// when a command is run with --profile. A default region is retained for local
// convenience, while the account must always come from the active credentials.
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account) {
  throw new Error('CDK_DEFAULT_ACCOUNT is not set. Run the CDK command with an authenticated AWS profile.');
}

const env = {
  account,
  region: process.env.CDK_DEFAULT_REGION ?? 'af-south-1',
};

// Target-state three-tier infrastructure (VPC, ALB, ASGs, RDS).
// See lib/infrastructure-stack.ts for full resource definitions.
new InfrastructureStack(app, 'TechHealthInfrastructureStack', { env });

// Automated AI security review pipeline (S3, EventBridge, Lambda, Bedrock).
// See lib/pipeline-stack.ts for full resource definitions.
new PipelineStack(app, 'TechHealthPipelineStack', { env });
