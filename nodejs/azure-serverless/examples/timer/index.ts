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

// Fire an event once per minute
serverless.timer.onTimer("tick", storageAccount, {
    func: (context, msg) => {
        console.log(context);
        console.log(msg);
        context.done();
    },
    schedule: "0 * * * * *",
    resourceGroup: resourceGroup,
});

// The storage account of the queue
export let storageAccountName = storageAccount.name;
