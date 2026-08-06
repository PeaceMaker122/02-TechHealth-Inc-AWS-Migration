#!/usr/bin/env node

// CDK app entry point.
// This file is the equivalent of a Terraform root module — it instantiates every
// stack and wires them together. The env block pins deployment to the specific
// AWS account and region rather than relying on whatever the CLI is currently
// configured to, which avoids accidental cross-account or cross-region deploys.

import * as cdk from 'aws-cdk-lib';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

// Shared environment config — account and region are hardcoded here rather than
// using CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION so that cdk synth resolves
// AZ lookups and other context queries correctly without needing AWS credentials.
const env = {
  account: '292133967819',
  region: 'af-south-1',
};

// Target-state three-tier infrastructure (VPC, ALB, ASGs, RDS).
// See lib/infrastructure-stack.ts for full resource definitions.
new InfrastructureStack(app, 'TechHealthInfrastructureStack', { env });

// Automated AI security review pipeline (S3, EventBridge, Lambda, Bedrock).
// See lib/pipeline-stack.ts for full resource definitions.
new PipelineStack(app, 'TechHealthPipelineStack', { env });
