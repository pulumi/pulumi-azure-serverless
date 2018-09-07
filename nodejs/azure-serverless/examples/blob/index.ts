// Copyright 2016-2017, Pulumi Corporation.  All rights reserved.

import * as azure from "@pulumi/azure";
import * as serverless from "@pulumi/azure-serverless";

const resourceGroup = new azure.core.ResourceGroup("resourcegroup", {
    location: "West US 2",
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
serverless.storage.onBlobEvent("newImage", storageAccount, {
    func: (context, blob) => {
        console.log(context);
        console.log(blob);
        context.done();
    },
    containerName: storageContainer.name,
    filterSuffix: ".png",
    resourceGroup: resourceGroup,
});

// The storage account where images should be uploaded
export let storageAccountName = storageAccount.name;
