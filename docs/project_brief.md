# TechHealth Inc. AWS Infrastructure Migration

## Public project brief

TechHealth Inc. is a healthcare technology company modernising the AWS platform behind its patient portal. The original environment had been created manually through the AWS Console several years earlier. As the environment grew, the lack of Infrastructure as Code, network segmentation, and reliable security review made change increasingly difficult to manage with confidence.

This project defines the challenge, the target direction, and the outcomes expected from the migration. The implementation history, detailed design reasoning, troubleshooting record, and evidence are documented separately in [`README.md`](../README.md) and [`decisions.md`](decisions.md).

## The challenge

The starting environment had several characteristics that created operational and security risk:

- Infrastructure changes were not managed through version control.
- Environments were difficult to reproduce consistently.
- Changes were difficult to trace and audit.
- Documentation no longer reflected the deployed environment.
- Web, application, and database resources lacked clear network boundaries.
- Resources were placed in public subnets without an intentional tiered design.
- Security groups were managed manually and could become overly permissive.
- Infrastructure templates had no repeatable automated security review.

These issues are especially important for a healthcare workload handling patient data. The target environment therefore needed to improve both the delivery process and the technical architecture.

## Project objectives

The migration was designed to achieve the following outcomes:

- Manage AWS infrastructure as code using AWS CDK and TypeScript.
- Create a reproducible multi-AZ environment.
- Separate internet-facing, application, and data responsibilities.
- Remove direct public access to the database.
- Apply least-privilege security-group and IAM controls.
- Improve availability, scalability, redundancy, and disaster recovery.
- Store database credentials securely.
- Test the infrastructure through real connectivity and configuration checks.
- Produce an auditable record of infrastructure reviews and decisions.

## Target-state direction

The final design uses a two-AZ, three-tier architecture:

```text
Internet
   ↓
Application Load Balancer in public subnets
   ↓
Web Auto Scaling Group
   ↓
App Auto Scaling Group in private subnets
   ↓
Multi-AZ MySQL RDS in private subnets
```

The target environment includes:

- One public and one private subnet in each of two Availability Zones.
- An Internet Gateway for public subnet traffic.
- A NAT Gateway for controlled outbound traffic from private subnets.
- A single internet-facing Application Load Balancer.
- Web and app EC2 Auto Scaling Groups.
- Multi-AZ MySQL RDS in private subnets.
- Secrets Manager for database credentials.
- Layered security groups that permit traffic only between intended tiers.
- Systems Manager Session Manager for EC2 administration instead of SSH.

The final design evolved from the original brief as the architecture was examined in more detail. The web tier remains in public subnets in the implemented demonstration environment, while the app and data layers are private. The security review pipeline identified the web-tier placement as a genuine risk. In a production environment, only the ALB would remain in public subnets.

## Security principles

The target architecture is based on the following controls:

### Network isolation

- The ALB is the public entry point.
- The app layer is placed in private subnets.
- RDS is placed in private subnets.
- RDS is not publicly accessible.
- Private resources use controlled outbound access through the NAT Gateway where required.

### Layered security groups

| Layer | Intended inbound access |
|---|---|
| ALB | HTTP and HTTPS from the internet |
| Web | HTTP and HTTPS from the ALB security group |
| App | Application traffic from the web security group |
| RDS | MySQL on port 3306 from the app security group |

### Identity and secrets

- EC2 instances use IAM roles rather than embedded credentials.
- Database credentials are generated and stored in Secrets Manager.
- The app layer reads the database secret at runtime.
- Systems Manager Session Manager provides administrative access without opening SSH to the internet.

### Availability and resilience

- The VPC spans two Availability Zones.
- Web and app capacity is managed through Auto Scaling Groups.
- RDS uses Multi-AZ deployment with a standby instance in a separate Availability Zone.
- Resources can be recreated from the CDK application rather than manually rebuilt through the console.

## Automated security review capability

A consultant-initiated addition to the project is an AWS-native security review pipeline for synthesized CloudFormation templates.

```text
Synthesized CloudFormation template
              ↓
S3 template bucket
              ↓
EventBridge Object Created event
              ↓
Security reviewer Lambda
              ↓
Amazon Bedrock Claude review
              ↓
Findings report written to S3
              ↓
CloudWatch execution logs
```

The reviewer evaluates four checks derived from the project’s security objectives:

1. RDS public access.
2. SSH access restriction.
3. Least-privilege IAM.
4. Network segmentation.

The pipeline is intentionally advisory. It automatically performs the review and creates an audit trail, but it does not autonomously approve or block a deployment. Interpretation and acceptance of findings remain a human responsibility.

## Design trade-offs

The project includes several deliberate trade-offs:

- A NAT Gateway was introduced despite the original cost-saving preference to avoid NAT Gateways, because private application resources require controlled outbound access.
- A read replica was rejected because the additional cost and operational overhead were not justified at this scale.
- The web tier was retained in public subnets for the demonstration environment so the security review pipeline could identify and report a real network-segmentation issue.
- SSM Session Manager was chosen instead of SSH, removing the need for an inbound port 22 rule.
- The AI pipeline was added as a consultant-led enhancement because healthcare infrastructure benefits from consistent automated review.

The full rationale and alternatives considered are recorded in [`docs/decisions.md`](decisions.md).

## What success looks like

A successful outcome for this project means that the environment can be:

- Defined in version-controlled CDK code.
- Synthesized into CloudFormation templates.
- Deployed consistently across the intended account and region.
- Reviewed automatically for important security conditions.
- Tested through real EC2-to-RDS connectivity.
- Inspected through security-group and network-isolation evidence.
- Destroyed after testing to avoid unnecessary cloud cost.
- Recreated from the code when work resumes or another environment is required.

The project achieved these outcomes through the deployed CDK stacks, successful pipeline execution, infrastructure testing, captured evidence, and documented engineering decisions.

## Scope boundary

The project focuses on infrastructure migration, security posture, review automation, and evidence. It does not implement a full application deployment, CI/CD approval gate, production data migration, or autonomous remediation of security findings.

The automated reviewer is a decision-support capability. It identifies risks and recommendations, while deployment decisions remain with the responsible engineer or organisation.

## Further information

For the complete project narrative, see the root [`README.md`](../README.md).

For the full architectural decisions, implementation issues, security findings, and evidence record, see [`docs/decisions.md`](decisions.md).

For CDK setup, deployment, testing, and teardown instructions, see [`IaC/README.md`](../IaC/README.md).

For architecture diagrams and testing evidence, see:

- [`architecture/`](../architecture/)
- [`screenshots/Diagrams/`](../screenshots/Diagrams/)
- [`screenshots/Infrastructure/`](../screenshots/Infrastructure/)
- [`screenshots/AI-Security-Review-Pipeline/`](../screenshots/AI-Security-Review-Pipeline/)
- [`AI-Security-Review-Pipeline-Reports/`](../AI-Security-Review-Pipeline-Reports/)
