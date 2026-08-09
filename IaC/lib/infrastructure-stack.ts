import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';

// InfrastructureStack — target-state three-tier architecture for TechHealth Inc.
//
// Layer summary (mirrors decisions.md Tasks 1 and 2):
//   Web layer   — public subnets, ALB + Web ASG (EC2 t3.micro)
//   App layer   — private subnets, App ASG (EC2 t3.micro)
//   Data layer  — private subnets, RDS MySQL Multi-AZ
//
// Security group chain (least-privilege, per decisions.md First-off Decisions):
//   Internet → ALB SG → Web SG → App SG → RDS SG
//
// Deployment target: af-south-1 (Cape Town), AZs af-south-1a and af-south-1b.

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // VPC
    // -------------------------------------------------------------------------
    // 10.0.0.0/16 across two AZs (af-south-1a, af-south-1b).
    // maxAzs: 2 — CDK will pick the first two AZs in the region alphabetically,
    // which resolves to af-south-1a and af-south-1b.
    //
    // SubnetConfiguration replaces the CDK default of creating public + private
    // + isolated subnets. We want exactly:
    //   - One PUBLIC subnet per AZ  (web layer and ALB)
    //   - One PRIVATE subnet per AZ (app and data layers)
    //
    // natGateways: 1 — a single NAT Gateway in the public subnet of AZ1.
    // Decision rationale: NAT is required because the private subnets have no
    // direct internet route. A single NAT covers both AZs at lower cost; HA
    // for the NAT itself is acceptable given project scale (decisions.md #3).
    const vpc = new ec2.Vpc(this, 'TechHealthVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1, // Placed in the public subnet of the first AZ (af-south-1a)
      subnetConfiguration: [
        {
          // Public subnets — host the ALB and the web-layer EC2 instances.
          // Internet Gateway is attached automatically by CDK for PUBLIC subnets.
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          // Private subnets — host the app-layer EC2 instances and RDS.
          // Outbound internet access routes via the NAT Gateway above.
          // No inbound route from the internet exists.
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // -------------------------------------------------------------------------
    // Security Groups
    // -------------------------------------------------------------------------
    // Four groups chained in a strict least-privilege chain.
    // Each group allows inbound only from the layer directly above it.
    // No SSH from 0.0.0.0/0 — that was one of the critical misconfigurations
    // in the current state (decisions.md Task 2, "What I rejected").

    // ALB Security Group — internet-facing, accepts HTTP and HTTPS from anywhere.
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'ALB SG - inbound 80 and 443 from internet',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');

    // Web Security Group — accepts HTTP and HTTPS from the ALB only.
    // The ALB forwards traffic to the web instances; no direct internet path.
    const webSg = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc,
      description: 'Web SG - inbound 80 and 443 from ALB SG only',
      allowAllOutbound: true,
    });
    webSg.addIngressRule(albSg, ec2.Port.tcp(80), 'HTTP from ALB SG');
    webSg.addIngressRule(albSg, ec2.Port.tcp(443), 'HTTPS from ALB SG');

    // App Security Group — accepts traffic on 80 and 8080 from the web layer only.
    // 8080 is the internal app server port; 80 provides a fallback path.
    const appSg = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc,
      description: 'App SG - inbound 80 and 8080 from Web SG only',
      allowAllOutbound: true,
    });
    appSg.addIngressRule(webSg, ec2.Port.tcp(80), 'HTTP from Web SG');
    appSg.addIngressRule(webSg, ec2.Port.tcp(8080), 'App port from Web SG');

    // RDS Security Group — accepts MySQL (3306) from the app layer only.
    // No public access to the database — this was the most critical
    // misconfiguration in the current state (decisions.md Task 2).
    const rdsSg = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      vpc,
      description: 'RDS SG - inbound 3306 from App SG only',
      allowAllOutbound: false, // RDS does not need outbound internet access
    });
    rdsSg.addIngressRule(appSg, ec2.Port.tcp(3306), 'MySQL from App SG');

    // -------------------------------------------------------------------------
    // RDS Credentials (Secrets Manager)
    // -------------------------------------------------------------------------
    // Credentials are generated by Secrets Manager rather than hardcoded.
    // The app layer EC2 instances will retrieve the secret at runtime.
    // This satisfies the "Database credentials stored securely" requirement
    // in the project brief.
    const dbSecret = new secretsmanager.Secret(this, 'RdsMasterSecret', {
      description: 'TechHealth RDS master credentials (username and password)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true, // Avoids characters that can break MySQL connection strings
        passwordLength: 32,
      },
    });

    // -------------------------------------------------------------------------
    // RDS — MySQL, Multi-AZ
    // -------------------------------------------------------------------------
    // db.t3.micro — minimum cost instance class (decisions.md, cost considerations).
    // Multi-AZ: primary in af-south-1a, standby in af-south-1b.
    // Synchronous replication; automatic failover with no manual intervention.
    // deletionProtection: false here to allow cdk destroy during development.
    // In a real production deployment this would be true.
    const dbInstance = new rds.DatabaseInstance(this, 'TechHealthRds', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      // Place RDS in the private subnets — never in public subnets (decisions.md Task 2)
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [rdsSg],
      credentials: rds.Credentials.fromSecret(dbSecret),
      multiAz: true, // Primary in af-south-1a, standby in af-south-1b (decisions.md #5)
      allocatedStorage: 20, // GB — minimum for MySQL
      storageType: rds.StorageType.GP2,
      databaseName: 'techhealth',
      deletionProtection: false, // Set to true before any production use
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Allow cdk destroy to clean up during development
      backupRetention: cdk.Duration.days(7),
    });

    // -------------------------------------------------------------------------
    // IAM Role — Web and App EC2 instances
    // -------------------------------------------------------------------------
    // Both ASGs share a single role scoped to the minimum permissions needed:
    //   - SSM Session Manager (replaces SSH; no port 22 required on security groups)
    //   - Secrets Manager read (app layer reads the RDS credentials at startup)
    //   - CloudWatch agent (logs and metrics from EC2 instances)
    //
    // In Terraform terms, this is equivalent to an aws_iam_role with an
    // aws_iam_instance_profile attached to the EC2 resource.
    // CDK's LaunchTemplate handles the instance profile binding automatically.

    const ec2Role = new iam.Role(this, 'Ec2InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Role for TechHealth web and app layer EC2 instances',
      managedPolicies: [
        // Allows SSM Session Manager connections — no SSH key or open port 22 needed
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        // Allows the CloudWatch agent to publish logs and metrics
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // Grant read access to the RDS secret so app-layer instances can retrieve credentials.
    // grantRead generates a least-privilege IAM policy scoped to this specific secret ARN.
    dbSecret.grantRead(ec2Role);

    // -------------------------------------------------------------------------
    // Launch Templates — one per layer, each with its own security group
    // -------------------------------------------------------------------------
    // When a LaunchTemplate is used with an ASG, CDK requires the security group
    // to be set on the LaunchTemplate, not on the ASG. Because the web and app
    // layers have different security groups, two separate launch templates are
    // needed — one per layer.
    //
    // Amazon Linux 2023 is the current recommended AMI for new EC2 deployments.
    // t3.micro is the current-generation burstable instance (replaces t2.micro).
    // It runs on Nitro, costs ~10% less, earns CPU credits faster, and delivers
    // more consistent baseline performance. IMDSv2 is enforced (requireImdsv2: true)
    // to prevent credential theft via SSRF against the instance metadata service.

    // Web layer launch template — uses Web SG
    const webLaunchTemplate = new ec2.LaunchTemplate(this, 'WebLaunchTemplate', {
      instanceType: new ec2.InstanceType('t3.micro'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: ec2Role,
      securityGroup: webSg,
      requireImdsv2: true,
    });

    // App layer launch template — uses App SG
    const appLaunchTemplate = new ec2.LaunchTemplate(this, 'AppLaunchTemplate', {
      instanceType: new ec2.InstanceType('t3.micro'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: ec2Role,
      securityGroup: appSg,
      requireImdsv2: true,
    });

    // -------------------------------------------------------------------------
    // Web Layer — Auto Scaling Group
    // -------------------------------------------------------------------------
    // Sits in the PUBLIC subnets behind the ALB.
    // Min 1 instance per AZ (minCapacity: 2 for the two AZs), max 4 to cap spend.
    // The ALB Target Group (created below) registers these instances.
    const webAsg = new autoscaling.AutoScalingGroup(this, 'WebAutoScalingGroup', {
      vpc,
      launchTemplate: webLaunchTemplate,
      // Public subnets — web layer is ALB-facing and needs to be reachable by it
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minCapacity: 2, // One instance per AZ to maintain HA across both AZs
      maxCapacity: 4,
      // healthChecks uses the new HealthChecks class (not the deprecated HealthCheck singular).
      // withAdditionalChecks enables ELB health checks on top of the default EC2 check —
      // instances that the ALB marks unhealthy are replaced automatically.
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: cdk.Duration.seconds(60),
      }),
    });

    // -------------------------------------------------------------------------
    // App Layer — Auto Scaling Group
    // -------------------------------------------------------------------------
    // Sits in the PRIVATE subnets. Receives traffic from the web layer only.
    const appAsg = new autoscaling.AutoScalingGroup(this, 'AppAutoScalingGroup', {
      vpc,
      launchTemplate: appLaunchTemplate,
      // Private subnets — app layer has no direct internet exposure
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minCapacity: 2, // One instance per AZ
      maxCapacity: 4,
      // EC2-only health checks are sufficient for the app layer —
      // it does not sit behind the ALB directly, so ELB checks don't apply.
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: cdk.Duration.seconds(60),
      }),
    });

    // -------------------------------------------------------------------------
    // Application Load Balancer
    // -------------------------------------------------------------------------
    // Internet-facing, deployed across the public subnets of both AZs.
    // The ALB itself is a managed multi-AZ service — one ALB covers both AZs.
    // (Decisions.md Task 2 explicitly rejected per-AZ ALBs as incorrect.)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'TechHealthAlb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });

    // HTTP listener on port 80 — forwards all traffic to the web ASG target group.
    // In a production system this would redirect to HTTPS. For this project
    // an SSL certificate and domain are out of scope, so HTTP forwarding is used.
    const httpListener = alb.addListener('HttpListener', {
      port: 80,
      open: false, // Security group rules already control access; do not add a 0.0.0.0/0 rule
    });

    // Register the web ASG as targets for the HTTP listener.
    // CDK creates the Target Group and registers all ASG instances automatically.
    // addTargets also attaches the ELB health check to the ASG (used above).
    httpListener.addTargets('WebAsgTargets', {
      port: 80,
      targets: [webAsg],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
      },
    });

    // -------------------------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------------------------
    // Outputs are visible in the CloudFormation console and returned by
    // `cdk deploy`. Useful for quickly finding key resource identifiers
    // without digging through the console.

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS name — use this to reach the web application',
    });

    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: dbInstance.dbInstanceEndpointAddress,
      description: 'RDS endpoint — used by app layer instances to connect to MySQL',
    });

    new cdk.CfnOutput(this, 'RdsSecretArn', {
      value: dbSecret.secretArn,
      description: 'Secrets Manager ARN for RDS credentials',
    });
  }
}
