# Decisions Log: TechHealth Inc. AWS Infrastructure Migration

---

## First-off Decisions

### 1. Infrastructure as Code Over Console

The existing infrastructure was built manually through the AWS Console. This project will not replicate that approach. All infrastructure will be implemented as code using AWS CDK with TypeScript from the outset.

This decision is driven by the following best practice considerations:

- Version control of all infrastructure changes
- Ability to replicate environments consistently
- A clear audit trail of who changed what and when
- Automated testing of infrastructure

### 2. Network Architecture: Three-Tier Design

The web application runs on EC2 instances. Rather than placing all resources in a flat public subnet (the current state), the target architecture separates concerns across layers:

- A **web layer** in the public subnet, accessed by customers via an Application Load Balancer (ALB)
- An **app layer** in a private subnet, hosting the application EC2 instances, accessible only from the web layer
- A **data layer** in a private subnet, hosting the RDS instance, accessible only from the app layer

This enforces least-privilege network access and eliminates direct public exposure of application and database resources.

### 3. NAT Gateway for Private Subnet Outbound Access

The original project brief assumed all EC2 instances would sit in a public subnet, so no NAT Gateway was required. With the move to a three-tier architecture, the app and database layers are in private subnets with no direct route to the internet.

A NAT Gateway will be deployed in the public subnet to provide outbound internet access for instances in the private subnets — for example, to pull software updates or reach AWS service endpoints — without exposing them to inbound traffic from the internet. This is a direct consequence of the three-tier network decision above, not an optional addition.

### 4. Auto-Scaling Groups for Web and App Layers

EC2 instances at both the web and app layer will be deployed inside Auto Scaling Groups (ASGs) rather than as standalone instances.

This supports the target-state goals of High Availability and Scalability. With ASGs, the environment can automatically adjust capacity in response to demand and replace unhealthy instances without manual intervention. Combined with the multi-AZ VPC design, ASGs ensure no single instance is a point of failure at either layer.

### 5. RDS Deployed in Multi-AZ Mode

The RDS instance will be deployed in Multi-AZ mode, with a standby replica in a separate Availability Zone.

In the event of an infrastructure failure, scheduled maintenance, or AZ disruption, RDS will automatically fail over to the standby with no manual intervention required. This directly addresses the Disaster Recovery and Redundancy goals in the problem statement, and is particularly important given TechHealth Inc. stores patient data where availability and durability are critical.

The app layer in AZ 2 communicates with the primary RDS instance in AZ 1, incurring a very small cross-AZ data transfer charge. A read replica in AZ 2 was considered but rejected — the added cost and operational overhead of maintaining a replica is not justified at this scale, and the cross-AZ charge remains negligible for the volume of traffic expected in this environment.

### 6. Consultant-Initiated Scope Addition: Automated Security Review Pipeline

This addition falls outside the original project brief. It was identified and proposed during project execution and is documented here to preserve a clear record of what was client-specified versus consultant-initiated.

**Rationale**

TechHealth Inc. handles patient data, which places elevated importance on network isolation, least-privilege access, and security group correctness. Manual review of infrastructure-as-code changes is error-prone and does not scale — particularly in a healthcare context where a misconfiguration (e.g. an overly permissive security group rule) carries outsized risk.

**What was added**

An automated, AWS-native security review pipeline that runs against every synthesized CDK template prior to deployment:

- Synthesized CDK templates are uploaded to Amazon S3
- An EventBridge rule detects new uploads and invokes a Lambda function
- Lambda submits the template to Amazon Bedrock (Claude) for review against the security checks defined in the project brief (no public RDS access, SSH restricted to a single IP, least-privilege IAM, proper network segmentation)
- Findings are written to S3 and logged via CloudWatch, producing a durable, timestamped audit trail

**Scope boundary**

This pipeline surfaces findings for human review — it does not autonomously block or approve deployments. All accept/reject decisions on flagged findings remain with the consultant and are logged in this decisions record. Automation eliminates the manual effort of running a review, not the human judgment of interpreting one.

This addition is treated as a first-class part of the target-state architecture and CDK deliverables, not a separate or optional add-on.

---

## Problem Statement

TechHealth Inc. built their AWS infrastructure manually through the console 5 years ago. This is a long time in the technology industry, and the approach introduces a range of compounding problems over time.

The current infrastructure does not comply with AWS best practices, and the documentation is outdated. Specifically, the absence of an IaC approach means the environment suffers from:

- No version control of infrastructure changes
- No reliable way to replicate environments
- No audit trail of changes
- No automated testing of infrastructure

Migrating to Infrastructure as Code directly addresses each of these. Beyond resolving the process failures, the target architecture also needs to achieve:

- Efficiency
- High Availability
- Scalability
- Redundancy
- Disaster Recovery

---

## Tasks

### 1. Create the Current Architecture

**What this task is solving**

Establishing a clear visual representation of the current infrastructure to understand what exists, identify flaws, and create a baseline to work from before making any changes.

**What I did**
- Created the current infrastructure as a diagram to get a visual overview and spot security risks.
- No corrections were made to the current infrastructure, the goal was to accurately represent the existing situation before addressing it.

**Why I did it**
- Without a clear picture of the current state, it is difficult to identify risks or plan improvements. The diagram serves as the starting point for all subsequent tasks.

**What I rejected**
- Making corrections to the infrastructure at this stage, doing so would misrepresent the actual current state and undermine the purpose of the diagram.

---

### 2. Create the Target-State Architecture

