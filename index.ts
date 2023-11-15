import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as ip from "ip";
 
const config = new pulumi.Config("iac-aws");
 
const vpcName = config.require("vpc_name");
const vpcCidr = config.require("vpc_cidr");
const vpcInstanceTenancy = config.require("vpc_instance_tenancy");
const internetGatewayName = config.require("internet_gateway_name");
const internetGatewayAttachmentName = config.require("internet_gateway_attachment_name");
const publicRouteTableName = config.require("public_route_table_name");
const privateRouteTableName = config.require("private_route_table_name");
const maxAvailabilityZones = config.getNumber("max_availability_zones");
const bitsForEachSubnet = config.getNumber("bits_for_each_subnet");
 
const publicRouteName = config.require("public_route_name");
const publicDestinationCidr = config.require("public_destination_cidr");
const publicSubnetsPrefix = config.require("public_subnets_prefix");
const privateSubnetsPrefix = config.require("private_subnets_prefix");
const publicRouteTableSubnetsAssociationPrefix = config.require("public_route_table_subnets_association_prefix");
const privateRouteTableSubnetsAssociationPrefix = config.require("private_route_table_subnets_association_prefix");
 
const securityGroupDescription = config.require("securityGroupDescription");
const securityGroupName = config.require("securityGroupName");
const allowedIngressPorts = config.require("allowedIngressPorts").split(",");
const allowedEgressPorts = config.require("allowedEgressPorts").split(",");
const allowedIngressCIDRs = config.require("allowedIngressCIDRs").split(",");
const allowedEgressCIDRs = config.require("allowedEgressCIDRs").split(",");
const dbPort = config.requireNumber("dbPort");
 
 
const domainName = config.require("domainName");
const applicationPort = config.require("applicationPort");
const hostedZoneId = config.require("hostedZoneId");
const ttl = config.requireNumber("ttl");
const route53ARecordName = config.require("route53ARecordName");
 
const cloudWatchPolicyName = config.require("cloudWatchAgentServerPolicyName");
const ec2RoleName = config.require("ec2RoleName");
const policyAttachmentName = config.require("cloudWatchAgentPolicyAttachmentName");
const instanceProfileName = config.require("instanceProfileName");
 
const launchConfigurationName = config.require("launchConfigurationName");
const autoScalingGroupName = config.require("autoScalingGroupName");
const loadBalancerSecurityGroupName = config.require("loadBalancerSecurityGroupName");
 
const autoScalingCooldown = config.getNumber("autoScalingCooldown");
const autoScalingMinSize = config.getNumber("autoScalingMinSize") || 1;
const autoScalingMaxSize = config.getNumber("autoScalingMaxSize") || 3;
const autoScalingDesiredCapacity = config.getNumber("autoScalingDesiredCapacity") || 1;
const loadBalancerAllowedIngressPorts = config.require("loadBalancerAllowedIngressPorts").split(",");
 
// Create VPC
const vpc = new aws.ec2.Vpc(vpcName, {
    cidrBlock: vpcCidr,
    instanceTenancy: vpcInstanceTenancy,
    tags: {
        Name: vpcName,
    },
});
 
// Create Load Balancer Security Group
const lbSecurityGroup = new aws.ec2.SecurityGroup(loadBalancerSecurityGroupName, {
    vpcId: vpc.id,
    ingress: loadBalancerAllowedIngressPorts.map(port => ({
        protocol: "tcp",
        fromPort: parseInt(port.trim(), 10),
        toPort: parseInt(port.trim(), 10),
        cidrBlocks: ["0.0.0.0/0"]
    })),
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { Name: loadBalancerSecurityGroupName },
});
 
const egressRules = allowedEgressPorts.map(port => ({
    protocol: "tcp",
    fromPort: parseInt(port, 10),
    toPort: parseInt(port, 10),
    cidrBlocks: allowedEgressCIDRs
}));
 
const ingressRules = [
    { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] },
    { protocol: "tcp", fromPort: 8080, toPort: 8080, securityGroups: [lbSecurityGroup.id] },
];
 
const appSecurityGroup = new aws.ec2.SecurityGroup(securityGroupName, {
    vpcId: vpc.id,
    description: securityGroupDescription,
    tags: {
        Name: securityGroupName,
    },
    ingress: ingressRules,
    egress: egressRules
});
 
const instanceType = config.require("instanceType");
const imageId = config.require("imageId");
const keyName = config.require("keyName");
const volumeSize = config.getNumber("volumeSize");
const volumeType = config.require("volumeType");
const deleteOnTermination = config.getBoolean("deleteOnTermination");
const ec2Name = config.require("ec2Name");
const ENV_TYPE = config.require("envType");
 
const multiAZDeployment = config.requireBoolean("multiAZDeployment");
const dbSecurityGroupName = config.require("dbSecurityGroupName");
const dbParameterGroupName = config.require("dbParameterGroupName");
const dbInstanceIdentifier = config.require("dbInstanceIdentifier");
const allocatedStorage = parseInt(config.require("allocatedStorage"));
const dbSubnetGroupName = config.require("dbSubnetGroupName");
const dbName = config.require("dbName");
const dbUser = config.require("dbUser");
const dbPassword = config.require("dbPassword");
const dbDialect = config.get("dbDialect") || "postgres";
 
 
const dbSecurityGroup = new aws.ec2.SecurityGroup(dbSecurityGroupName, {
    vpcId: vpc.id,
    description: "Database security group for RDS",
    tags: {
        Name: dbSecurityGroupName,
    },
    ingress: [{
        protocol: "tcp",
        fromPort: dbPort,
        toPort: dbPort,
        securityGroups: [appSecurityGroup.id]
    }]
});
 
const dbParameterGroup = new aws.rds.ParameterGroup(dbParameterGroupName, {
    family: "postgres15",
    description: "Custom parameter group",
});
 
 
async function provisioner() {
    try {
        const azs = await aws.getAvailabilityZones();
        const azsToUse = azs.names.slice(0, maxAvailabilityZones!);
        const totalSubnets = azsToUse.length * 2;
        const subnetCIDRs = calculateCIDRSubnets(vpcCidr, totalSubnets, bitsForEachSubnet!);
 
        if (subnetCIDRs instanceof Error) {
            throw new pulumi.RunError("Failed to calculate subnet CIDRs: " + subnetCIDRs.message);
        }
 
 
        let publicSubnets: aws.ec2.Subnet[] = [];
        let privateSubnets: aws.ec2.Subnet[] = [];
 
        const internetGateway = new aws.ec2.InternetGateway(internetGatewayName, {
            tags: {
                Name: internetGatewayName,
            },
        });
 
        const igAttachment = await new aws.ec2.InternetGatewayAttachment(internetGatewayAttachmentName, {
            vpcId: vpc.id,
            internetGatewayId: internetGateway.id,
        });
 
        const publicRouteTable = await new aws.ec2.RouteTable(publicRouteTableName, {
            vpcId: vpc.id,
            tags: {
                Name: publicRouteTableName,
            },
        });
 
        const publicRoute = new aws.ec2.Route(publicRouteName, {
            routeTableId: publicRouteTable.id,
            destinationCidrBlock: publicDestinationCidr,
            gatewayId: internetGateway.id,
        });
 
        const privateRouteTable = new aws.ec2.RouteTable(privateRouteTableName, {
            vpcId: vpc.id,
            tags: {
                Name: privateRouteTableName,
            },
        });
 
        for (let i = 0; i < azsToUse.length; i++) {
            const publicSubnet = new aws.ec2.Subnet(`${publicSubnetsPrefix}-${i}`, {
                vpcId: vpc.id,
                availabilityZone: azsToUse[i],
                cidrBlock: subnetCIDRs[i],
                mapPublicIpOnLaunch: true,
                tags: {
                    Name: `${publicSubnetsPrefix}-${i}`,
                },
            });
 
            publicSubnets.push(publicSubnet);
 
            const privateSubnet = new aws.ec2.Subnet(`${privateSubnetsPrefix}-${i}`, {
                vpcId: vpc.id,
                availabilityZone: azsToUse[i],
                cidrBlock: subnetCIDRs[azsToUse.length + i],
                tags: {
                    Name: `${privateSubnetsPrefix}-${i}`,
                },
            });
 
            privateSubnets.push(privateSubnet);
        }
 
        publicSubnets.forEach((subnet, i) => {
            new aws.ec2.RouteTableAssociation(`${publicRouteTableSubnetsAssociationPrefix}-${i}`, {
                subnetId: subnet.id,
                routeTableId: publicRouteTable.id,
            });
        });
 
        privateSubnets.forEach((subnet, i) => {
            new aws.ec2.RouteTableAssociation(`${privateRouteTableSubnetsAssociationPrefix}-${i}`, {
                subnetId: subnet.id,
                routeTableId: privateRouteTable.id,
            });
        });
 
        // console.log(`VPC ID: ${vpc.id}`);
        // console.log(`Security Group VPC ID: ${appSecurityGroup.vpcId}`);
        // console.log(`Public Subnet VPC ID: ${publicSubnets[0]?.vpcId}`);
        const dbSubnetGroupResource = await new aws.rds.SubnetGroup(dbSubnetGroupName, {
            subnetIds: privateSubnets.map(subnet => subnet.id),
            tags: {
                Name: dbSubnetGroupName,
            },
        });
 
        const rdsInstance = await new aws.rds.Instance(dbInstanceIdentifier, {
            engine: "postgres",
            instanceClass: "db.t3.micro",
            allocatedStorage: allocatedStorage,
            dbSubnetGroupName: dbSubnetGroupResource.name,
            multiAz: multiAZDeployment,
            vpcSecurityGroupIds: [dbSecurityGroup.id],
            name: dbName,
            username: dbUser,
            password: dbPassword,
            parameterGroupName: dbParameterGroup.name,
            skipFinalSnapshot: true,
            publiclyAccessible: false,
        });
 
        const endpoint = rdsInstance.endpoint;
        const rdsHost = endpoint.apply(ep => ep.split(':')[0]);
        const rdsUser = dbUser;
        const rdsPassword = dbPassword;
 
        const userDataScript = pulumi.interpolate`#!/bin/bash
# Define your environment variables in a .env file
echo "DB_HOST=${rdsHost}" > /home/webapp_user/webapp/.env
echo "DB_DIALECT=${dbDialect}" >> /home/webapp_user/webapp/.env
echo "DB_USERNAME=${rdsUser}" >> /home/webapp_user/webapp/.env
echo "DB_PASSWORD=${rdsPassword}" >> /home/webapp_user/webapp/.env
echo "DB_NAME=${dbName}" >> /home/webapp_user/webapp/.env
echo "DB_PORT=${dbPort}" >> /home/webapp_user/webapp/.env
echo "ENV_TYPE=${ENV_TYPE}" >> /home/webapp_user/webapp/.env
 
# Configure the CloudWatch Agent
sudo /usr/bin/amazon-cloudwatch-agent-ctl \\
    -a fetch-config \\
    -m ec2 \\
    -c file:/opt/cloudwatch-config.json \\
    -s
# Restart the CloudWatch Agent to apply any updates
sudo systemctl restart amazon-cloudwatch-agent
sudo systemctl restart csye6225_webapp
`;
 
        const cloudWatchAgentServerPolicy = new aws.iam.Policy(cloudWatchPolicyName, {
            description: "Allows EC2 instances to report metrics to CloudWatch",
            policy: {
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Action: [
                            "cloudwatch:PutMetricData",
                            "ec2:DescribeVolumes",
                            "ec2:DescribeTags",
                            "logs:PutLogEvents",
                            "logs:DescribeLogStreams",
                            "logs:DescribeLogGroups",
                            "logs:CreateLogStream",
                            "logs:CreateLogGroup"
                        ],
                        Resource: "*",
                    },
                    {
                        Effect: "Allow",
                        Action: "ssm:GetParameter",
                        Resource: "arn:aws:ssm:::parameter/AmazonCloudWatch-*",
                    },
                ],
            },
        });
 
 
        // Create an IAM Role for the EC2 instance
        const ec2Role = new aws.iam.Role(ec2RoleName, {
            assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
                Service: "ec2.amazonaws.com",
            }),
        });
 
        // Attach the IAM Policy to the Role
        const rolePolicyAttachment = new aws.iam.RolePolicyAttachment(policyAttachmentName, {
            role: ec2Role.name,
            policyArn: cloudWatchAgentServerPolicy.arn,
        });
 
        // Create the Instance Profile for the Role
        const instanceProfile = new aws.iam.InstanceProfile(instanceProfileName, {
            role: ec2Role.name,
        });
        const ec2Instance = await new aws.ec2.Instance(ec2Name, {
            instanceType: instanceType,
            ami: imageId,
            keyName: keyName,
            subnetId: publicSubnets[0]?.id,
            vpcSecurityGroupIds: [appSecurityGroup.id],
            userData: userDataScript,
            iamInstanceProfile: instanceProfile.name,
            disableApiTermination: config.getBoolean("disableApiTermination"),
            rootBlockDevice: {
                volumeSize: volumeSize!,
                volumeType: volumeType,
                deleteOnTermination: deleteOnTermination!,
            },
            tags: {
                Name: ec2Name,
            },
        });
 
        const userDataEncoded = userDataScript.apply(ud => Buffer.from(ud).toString('base64'));
 
        const launchTemplate = new aws.ec2.LaunchTemplate(launchConfigurationName, {
            imageId: imageId,
            instanceType: instanceType,
            keyName: keyName,
            networkInterfaces: [{
                associatePublicIpAddress: "true",
                securityGroups: [appSecurityGroup.id],
            }],
            userData: userDataEncoded,
            iamInstanceProfile: {
                name: instanceProfile.name,
            },
            tagSpecifications: [{
                resourceType: "instance",
                tags: {
                    Name: "autoscale-ec2",
                }
            }],
        });
 
        const targetGroup = new aws.lb.TargetGroup("targetGroup", {
            port: 8080,  // The port your application listens on
            protocol: "HTTP",
            vpcId: vpc.id,
            targetType: "instance",
            healthCheck: {
                enabled: true,
                path: "/healthz", // Assuming the root path for health checks
                protocol: "HTTP",
            },
        });
 
        const autoScalingGroup = new aws.autoscaling.Group(autoScalingGroupName, {
            vpcZoneIdentifiers: publicSubnets.map(subnet => subnet.id),
            maxSize: autoScalingMaxSize,
            minSize: autoScalingMinSize,
            desiredCapacity: autoScalingDesiredCapacity,
            launchTemplate: {
                id: launchTemplate.id,
                version: "$Latest",
            },
            tags: [
                {
                    key: "AutoScalingGroup",
                    value: "autoscale-ec2",
                    propagateAtLaunch: true,
                },
            ],
            targetGroupArns: [targetGroup.arn]
        });
 
 
        // Scale Up Policy
        const scaleUpPolicy = new aws.autoscaling.Policy("scaleUpPolicy", {
            autoscalingGroupName: autoScalingGroup.name,
            adjustmentType: "ChangeInCapacity",
            scalingAdjustment: 1,
            cooldown: autoScalingCooldown,
            policyType: "SimpleScaling",
        });
 
        // Scale Down Policy
        const scaleDownPolicy = new aws.autoscaling.Policy("scaleDownPolicy", {
            autoscalingGroupName: autoScalingGroup.name,
            adjustmentType: "ChangeInCapacity",
            scalingAdjustment: -1,
            cooldown: autoScalingCooldown,
            policyType: "SimpleScaling",
        });
 
        // High CPU Utilization Alarm (for Scale Up)
        const highCpuAlarm = new aws.cloudwatch.MetricAlarm("highCpuAlarm", {
            comparisonOperator: "GreaterThanThreshold",
            evaluationPeriods: 2,
            metricName: "CPUUtilization",
            namespace: "AWS/EC2",
            period: 60,
            statistic: "Average",
            threshold: 5,
            alarmActions: [scaleUpPolicy.arn], // Link to scale up policy
            dimensions: {
                AutoScalingGroupName: autoScalingGroup.name,
            },
            actionsEnabled: true
        });
 
        // Low CPU Utilization Alarm (for Scale Down)
        const lowCpuAlarm = new aws.cloudwatch.MetricAlarm("lowCpuAlarm", {
            comparisonOperator: "LessThanThreshold",
            evaluationPeriods: 2,
            metricName: "CPUUtilization",
            namespace: "AWS/EC2",
            period: 60,
            statistic: "Average",
            threshold: 3,
            alarmActions: [scaleDownPolicy.arn], // Link to scale down policy
            dimensions: {
                AutoScalingGroupName: autoScalingGroup.name,
            },
            actionsEnabled: true
        });
 
        const publicIp = ec2Instance.publicIp;
 
        // Application Load Balancer
        const alb = new aws.lb.LoadBalancer("appLoadBalancer", {
            internal: false,
            loadBalancerType: "application",
            securityGroups: [lbSecurityGroup.id],
            subnets: publicSubnets.map(subnet => subnet.id),
            enableHttp2: true,
            tags: { Name: "appLoadBalancer" },
        });
        
        const listener = new aws.lb.Listener("listener", {
            loadBalancerArn: alb.arn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [{
                type: "forward",
                targetGroupArn: targetGroup.arn,
            }],
        });
        
 
        const aRecord = new aws.route53.Record(route53ARecordName, {
            zoneId: hostedZoneId,
            name: domainName,
            type: "A",
            // ttl: ttl,
            // records: [publicIp],
            aliases: [{ name: alb.dnsName, zoneId: alb.zoneId, evaluateTargetHealth: true }],
        });
 
 
    } catch (error) {
        console.error("Error:", error);
    }
}
 
function calculateCIDRSubnets(parentCIDR: string, numSubnets: number, bitsToMask: number): string[] | Error {
    try {
        if (bitsToMask > 32) {
            throw new Error("Bits to mask exceeds the available bits in the parent CIDR");
        }
 
        function ipToInt(ip: string): number {
            return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
        }
 
        function intToIp(int: number): string {
            return [(int >>> 24) & 0xFF, (int >>> 16) & 0xFF, (int >>> 8) & 0xFF, int & 0xFF].join('.');
        }
 
        const subnetSize = 1 << (32 - bitsToMask);
        const ipRange = ip.cidrSubnet(parentCIDR);
        let baseIpInt = ipToInt(ipRange.networkAddress);
 
        const subnets: string[] = [];
 
        for (let i = 0; i < numSubnets; i++) {
            const subnetCIDR = intToIp(baseIpInt) + "/" + bitsToMask;
            subnets.push(subnetCIDR);
            baseIpInt += subnetSize;
        }
 
        return subnets;
    } catch (error) {
        return error as Error;
    }
}
 
provisioner()