import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as ipModule from "ip";

const projectConfig = new pulumi.Config("proj-aws-setup");

console.log(projectConfig);

const primaryVpcName = projectConfig.require("primary_vpc_name");
const primaryVpcCidr = projectConfig.require("primary_vpc_cidr");
const primaryVpcInstanceTenancy = projectConfig.require("primary_vpc_instance_tenancy");
const gatewayName = projectConfig.require("gateway_name");
const gatewayAttachName = projectConfig.require("gateway_attach_name");
const pubRouteTableName = projectConfig.require("pub_route_table_name");
const privRouteTableName = projectConfig.require("priv_route_table_name");
const maxZones = projectConfig.getNumber("max_zones");
const subnetBits = projectConfig.getNumber("subnet_bits");

const mainRouteName = projectConfig.require("main_route_name");
const mainDestCidr = projectConfig.require("main_dest_cidr");
const pubSubnetsPrefix = projectConfig.require("pub_subnets_prefix");
const privSubnetsPrefix = projectConfig.require("priv_subnets_prefix");
const pubRtSubnetsAssocPrefix = projectConfig.require("pub_rt_subnets_assoc_prefix");
const privRtSubnetsAssocPrefix = projectConfig.require("priv_rt_subnets_assoc_prefix");

const sgDescription = projectConfig.require("sgDescription");
const sgName = projectConfig.require("sgName");
const allowedPorts = projectConfig.require("allowedPorts").split(",");
const allowedCIDRs = projectConfig.require("allowedCIDRs").split(",");

// VPC Creation
const primaryVpc = new aws.ec2.Vpc(primaryVpcName, {
    cidrBlock: primaryVpcCidr,
    instanceTenancy: primaryVpcInstanceTenancy,
    tags: {
        Name: primaryVpcName,
    },
});

const ingressConfig = allowedPorts.map(port => ({
    protocol: "tcp",
    fromPort: parseInt(port, 10),
    toPort: parseInt(port, 10),
    cidrBlocks: allowedCIDRs,
}));

const appSg = new aws.ec2.SecurityGroup(sgName, {
    vpcId: primaryVpc.id,
    description: sgDescription,
    tags: {
        Name: sgName,
    },
    ingress: ingressConfig,
});

const ec2Config = {
    type: projectConfig.require("instanceType"),
    ami: projectConfig.require("imageId"),
    key: projectConfig.require("keyName"),
    volumeSize: projectConfig.getNumber("volumeSize"),
    volumeType: projectConfig.require("volumeType"),
    onDelete: projectConfig.getBoolean("deleteOnTermination"),
    ec2TagName: projectConfig.require("ec2TagName"),
};

async function setupInfrastructure() {
    try {
        const availableZones = await aws.getAvailabilityZones();
        const zones = availableZones.names.slice(0, maxZones!);
        const totalSubnets = zones.length * 2;
        const subnetRanges = getSubnetRanges(primaryVpcCidr, totalSubnets, subnetBits!);

        if (subnetRanges instanceof Error) {
            throw new pulumi.RunError("Failed to determine subnet ranges: " + subnetRanges.message);
        }

        let pubSubnets: aws.ec2.Subnet[] = [];
        let privSubnets: aws.ec2.Subnet[] = [];

        const internetGw = new aws.ec2.InternetGateway(gatewayName, {
            tags: {
                Name: gatewayName,
            },
        });

        const igAttach = new aws.ec2.InternetGatewayAttachment(gatewayAttachName, {
            vpcId: primaryVpc.id,
            internetGatewayId: internetGw.id,
        });

        const publicRt = new aws.ec2.RouteTable(pubRouteTableName, {
            vpcId: primaryVpc.id,
            tags: {
                Name: pubRouteTableName,
            },
        });

        const publicRoute = new aws.ec2.Route(mainRouteName, {
            routeTableId: publicRt.id,
            destinationCidrBlock: mainDestCidr,
            gatewayId: internetGw.id,
        });

        const privateRt = new aws.ec2.RouteTable(privRouteTableName, {
            vpcId: primaryVpc.id,
            tags: {
                Name: privRouteTableName,
            },
        });

        zones.forEach((zone, idx) => {
            const pubSubnet = new aws.ec2.Subnet(`${pubSubnetsPrefix}-${idx}`, {
                vpcId: primaryVpc.id,
                availabilityZone: zone,
                cidrBlock: subnetRanges[idx],
                mapPublicIpOnLaunch: true,
                tags: {
                    Name: `${pubSubnetsPrefix}-${idx}`,
                },
            });

            pubSubnets.push(pubSubnet);

            const privSubnet = new aws.ec2.Subnet(`${privSubnetsPrefix}-${idx}`, {
                vpcId: primaryVpc.id,
                availabilityZone: zone,
                cidrBlock: subnetRanges[zones.length + idx],
                tags: {
                    Name: `${privSubnetsPrefix}-${idx}`,
                },
            });

            privSubnets.push(privSubnet);
        });

        pubSubnets.forEach((subnet, idx) => {
            new aws.ec2.RouteTableAssociation(`${pubRtSubnetsAssocPrefix}-${idx}`, {
                subnetId: subnet.id,
                routeTableId: publicRt.id,
            });
        });

        privSubnets.forEach((subnet, idx) => {
            new aws.ec2.RouteTableAssociation(`${privRtSubnetsAssocPrefix}-${idx}`, {
                subnetId: subnet.id,
                routeTableId: privateRt.id,
            });
        });

        const ec2Instance = new aws.ec2.Instance(ec2Config.ec2TagName, {
            instanceType: ec2Config.type,
            ami: ec2Config.ami,
            keyName: ec2Config.key,
            subnetId: pubSubnets[0]?.id,
            vpcSecurityGroupIds: [appSg.id],
            disableApiTermination: projectConfig.getBoolean("disableApiTerm"),
            rootBlockDevice: {
                volumeSize: ec2Config.volumeSize!,
                volumeType: ec2Config.volumeType,
                deleteOnTermination: ec2Config.onDelete!,
            },
            tags: {
                Name: ec2Config.ec2TagName,
            },
        });

    } catch (error) {
        console.error("An error occurred:", error);
    }
}

function getSubnetRanges(cidr: string, subnetsCount: number, bits: number): string[] | Error {
    try {
        if (bits > 32) {
            throw new Error("Bits provided exceeds the limit of the CIDR notation.");
        }

        function convertIpToInt(ip: string): number {
            return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
        }

        function convertIntToIp(int: number): string {
            return [(int >>> 24) & 0xFF, (int >>> 16) & 0xFF, (int >>> 8) & 0xFF, int & 0xFF].join('.');
        }

        const subnetMask = 1 << (32 - bits);
        const ipRange = ipModule.cidrSubnet(cidr);
        let baseIp = convertIpToInt(ipRange.networkAddress);

        const subnetList: string[] = [];

        for (let i = 0; i < subnetsCount; i++) {
            const subnetRange = convertIntToIp(baseIp) + "/" + bits;
            subnetList.push(subnetRange);
            baseIp += subnetMask;
        }

        return subnetList;
    } catch (error) {
        return error as Error;
    }
}

setupInfrastructure();