const pulumi = require('@pulumi/pulumi');

const aws = require('@pulumi/aws');

 

const config = new pulumi.Config();

 

//console.log(config,"this is config");

 

const awsRegion = config.require('region');

const vpcCIDR = config.require('cidrBlock');

const availabilityZones = config.getObject('availabilityZones');

const privateCIDR = config.getObject('privateSubnetCIDR');

const publicCIDR = config.getObject('publicSubnetCIDR');

const tags = config.getObject('tags');

 

//let availabilityZones;

 

/*aws.getAvailabilityZones().then(availableZones => {

    availabilityZones = availableZones.names.slice(0,3);

    console.log(availabilityZones, "these are available");

});*/

 

 

// Define the VPC

const vpc = new aws.ec2.Vpc('my-vpc', {

    cidrBlock: vpcCIDR,

    enableDnsSupport: true,

    enableDnsHostnames: true,

    tags : {

        "Name" : "VPC CREATED FROM Script"

    }

});

 

const internetGw = new aws.ec2.InternetGateway("internetGw", {

    vpcId: vpc.id,

    tags: {

        Name: "createdGateway",

    },

});

 

 

 

const publicRouteTable = new aws.ec2.RouteTable('publicRouteTable', {

    vpcId: vpc.id,

    routes: [

        {

            cidrBlock: "0.0.0.0/0",

            gatewayId: internetGw.id,

        }],

    tags: {

        "Name" : "PublicRouteTable"

    },

  });

 

const privateRouteTable = new aws.ec2.RouteTable('privateRouteTable', {

    vpcId: vpc.id, // Replace with your VPC ID

    tags: {

        "Name" : "PrivateRouteTable"

    },

  });

 

 

var i=0

 

availabilityZones.forEach((az, index) => {

    const publicSubnet = new aws.ec2.Subnet(`public-subnet-${az}`, {

        vpcId: vpc.id,

        cidrBlock: publicCIDR[i],

        availabilityZone: az,

        mapPublicIpOnLaunch: true,

        tags: {

            "Name" : `publicSubnet-${i}`

        },

    });

 

    const publicRouteTableAssociation = new aws.ec2.RouteTableAssociation(`publicRouteTableAssociation-${az}`, {

        subnetId: publicSubnet.id,

        routeTableId: publicRouteTable.id,

    });

 

 

    // Create private subnet

    const privateSubnet = new aws.ec2.Subnet(`private-subnet-${az}`, {

        vpcId: vpc.id,

        cidrBlock: privateCIDR[i],

        availabilityZone: az,

        tags: {

            "Name" : `privateSubnet-${i}`

        },

    });

 

    const privateRouteTableAssociation = new aws.ec2.RouteTableAssociation(`privateRouteTableAssociation-${az}`, {

        subnetId: privateSubnet.id,

        routeTableId: privateRouteTable.id,

    });

    i=i+1;

});