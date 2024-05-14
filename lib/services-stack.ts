import * as cdk from "aws-cdk-lib";
import { AutoScalingGroup } from "aws-cdk-lib/aws-autoscaling";
import {
  LoadBalancer,
  MinimumHealthyHosts,
  ServerApplication,
  ServerDeploymentConfig,
  ServerDeploymentGroup,
} from "aws-cdk-lib/aws-codedeploy";
import {
  AmazonLinuxGeneration,
  AmazonLinuxImage,
  GatewayVpcEndpointAwsService,
  InstanceClass,
  InstanceSize,
  InstanceType,
  IpAddresses,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { ApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  ManagedPolicy,
  OpenIdConnectPrincipal,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { readFileSync } from "fs";

export class ServicesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, "VPC", {
      ipAddresses: IpAddresses.cidr("10.0.0.0/20"), // you can make all the address a variable to handle multiple environments
      subnetConfiguration: [
        {
          name: "public",
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "application",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "data",
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
          reserved: true, // change to false (default value) for postgres server
        },
      ],
      maxAzs: 2,
      natGateways: 1, // should be increased to 1 per AZ - just did this to keep cost down
      reservedAzs: 2,
    });

    const asg = new AutoScalingGroup(this, "AutoScalingGroup", {
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.SMALL),
      machineImage: new AmazonLinuxImage({
        generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      minCapacity: 1,
      //maxInstanceLifetime: Duration.hours(1),
    });

    const userDataScript = readFileSync("./lib/user-data.sh", "utf8");
    asg.addUserData(userDataScript);

    const alb = new ApplicationLoadBalancer(this, "LB", {
      loadBalancerName: "api-load-balancer",
      vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      internetFacing: true,
    });

    const listener = alb.addListener("Listener", {
      port: 80,
      open: true,
    });

    const albTargetGroup = listener.addTargets("default-target", {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: "/",
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 5,
        interval: cdk.Duration.seconds(10),
      },
      deregistrationDelay: cdk.Duration.seconds(10), // default is 5 mins to drain when updating - increase for prod
    });

    const application = new ServerApplication(this, "CodeDeployApplication", {
      applicationName: "your-api",
    });

    const deploymentConfig = new ServerDeploymentConfig(
      this,
      "DeploymentConfiguration",
      {
        minimumHealthyHosts: MinimumHealthyHosts.count(1),
      }
    );

    // configure GitHub
    const gitHubProvider = new OpenIdConnectProvider(this, "githubProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
      thumbprints: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
    });

    const gitHubRole = new Role(this, "GitHubRole", {
      roleName: "githubactions-ec2-codedeploy-role",
      assumedBy: new OpenIdConnectPrincipal(gitHubProvider).withConditions({
        StringLike: {
          "token.actions.githubusercontent.com:sub":
            "repo:xxxxxxxxxxxxxxxxxxx/services:*", //`${githubRepoPath}` repo:{path-to-your-repository-without-https://}:*
        },
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
      }),
    });

    gitHubRole.addToPolicy(
      new PolicyStatement({
        actions: [
          "codedeploy:CreateDeployment",
          "codedeploy:GetApplication",
          "codedeploy:GetApplicationRevision",
          "codedeploy:GetDeployment",
          "codedeploy:GetDeploymentConfig",
          "codedeploy:RegisterApplicationRevision",
        ],
        resources: ["*"],
      })
    );

    const codedeployRole = new Role(this, "CodeDeployRole", {
      roleName: "ec2-codedeploy-role",
      assumedBy: new ServicePrincipal("codedeploy.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSCodeDeployRole"
        ),
      ],
    });

    const deploymentGroup = new ServerDeploymentGroup(this, "DeploymentGroup", {
      application,
      role: codedeployRole,
      autoScalingGroups: [asg],
      installAgent: true, // this installs CodeDeploy
      loadBalancers: [LoadBalancer.application(albTargetGroup)],
    });

    const deploymentBucket = new Bucket(this, "DeploymentBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.KMS_MANAGED,
      enforceSSL: true,
      //removalPolicy: RemovalPolicy.RETAIN,
    });

    //deploymentBucket.grantPut(gitHubRole);
    deploymentBucket.grantReadWrite(gitHubRole);
    deploymentBucket.grantRead(asg);

    // these endpoints stop traffic going out the internet and using natgateway which is faster and also cheaper
    vpc.addGatewayEndpoint("dynamoEndPoint", {
      service: GatewayVpcEndpointAwsService.DYNAMODB,
    });

    vpc.addGatewayEndpoint("s3EndPoint", {
      service: GatewayVpcEndpointAwsService.S3,
    });

    new cdk.CfnOutput(this, "loadBalancerDNS", {
      value: alb.loadBalancerDnsName,
    });
  }
}
