import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as ip from "ip";
 
const config = new pulumi.Config("iac-aws");
 
console.log(config);
 
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
 
// Create VPC
const vpc = new aws.ec2.Vpc(vpcName, {
    cidrBlock: vpcCidr,
    instanceTenancy: vpcInstanceTenancy,
    tags: {
        Name: vpcName,
    },
});
 
const ingressRules = allowedIngressPorts.map(port => ({
    protocol: "tcp",
    fromPort: parseInt(port, 10),
    toPort: parseInt(port, 10),
    cidrBlocks: allowedIngressCIDRs,
}));
 
const egressRules = allowedEgressPorts.map(port => ({
    protocol: "tcp",
    fromPort: parseInt(port, 10),
    toPort: parseInt(port, 10),
    cidrBlocks: allowedEgressCIDRs
}));
 
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
`;
 
        const ec2Instance = await new aws.ec2.Instance(ec2Name, {
            instanceType: instanceType,
            ami: imageId,
            keyName: keyName,
            subnetId: publicSubnets[0]?.id,
            vpcSecurityGroupIds: [appSecurityGroup.id],
            userData: userDataScript,
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