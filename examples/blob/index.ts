// Copyright 2016-2017, Pulumi Corporation.  All rights reserved.

import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";
import * as serverless from "@pulumi/azure-serverless";

const subscriptionId = pulumi.output(azure.core.getSubscription({}).then(s => s.subscriptionId));
const config = new pulumi.Config("azure-blob");
const clientId = config.require("clientId");
const clientSecret = config.require("clientSecret");
const tenant = config.require("tenant");

const resourceGroup = new azure.core.ResourceGroup("resourcegroup", {
    location: "West US 2",
});

const nginx = new azure.containerservice.Group("containergroup", {
    location: resourceGroup.location,
    resourceGroupName: resourceGroup.name,
    ipAddressType: "public",
    osType: "linux",
    containers: [{
        name: "nginx",
        image: "nginx",
        cpu: 0.5,
        memory: 1.5,
        port: 80
    }],
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
    (async () => {
        context.log!(context);
        context.log!(blob);

        const {default: fetch} = await import("node-fetch");
        const res = await fetch(`http://${nginx.ipAddress.get()}`);
        const text = await res.text()
        context.log!(text);
    })().then(_ => context.done(), context.done);
}, {resourceGroup: resourceGroup});

// Export the IP address of the container
export let ipAddress = nginx.ipAddress;
