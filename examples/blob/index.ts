// Copyright 2016-2017, Pulumi Corporation.  All rights reserved.

import * as azure from "@pulumi/azure";
import * as serverless from "@pulumi/azure-serverless";

const resourceGroup = new azure.core.ResourceGroup("resourcegroup", {
    location: "West US 2",
});

const containerGroup = new azure.containerservice.Group("containergroup", {
    location: resourceGroup.location,
    resourceGroupName: resourceGroup.name,
    ipAddressType: "public",
    osType: "linux",
    containers: [
        {
            name: "hw",
            image: "microsoft/aci-helloworld:latest",
            cpu: 0.5,
            memory: 1.5,
            port: 80
        },
        {
            name: "sidecar",
            image: "microsoft/aci-tutorial-sidecar",
            cpu: 0.5,
            memory: 1.5,
        },
    ],
    tags: {
        "environment": "testing",
    },
});

// Create a storage account for our images
const storageAccount = new azure.storage.Account("storage", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    accountReplicationType: "LRS",
    accountTier: "Standard",
});

// And a container to use to upload images into
const storageContainer = new azure.storage.Container("images-container", {
   resourceGroupName: resourceGroup.name,
   storageAccountName: storageAccount.name,
   name: "images",
});

// When a new PNG image is added, fire an event
serverless.blob.onEvent("newImage", storageAccount, "images/{name}.png", (context, blob) => {
    context.log!(context);
    context.log!(blob);
    context.done();
}, {resourceGroup: resourceGroup});

// Export the IP address of the container
export let ipAddress = containerGroup.ipAddress;
