// Copyright 2016-2017, Pulumi Corporation.  All rights reserved.

import * as azure from "@pulumi/azure";
import * as serverless from "@pulumi/azure-serverless";
import * as eventhub from "@pulumi/azure/eventhub";

const location = "West US 2";

const resourceGroup = new azure.core.ResourceGroup("test", {
    location: location,
});

const namespace = new eventhub.Namespace("test", {
    location: location,
    resourceGroupName: resourceGroup.name,
    sku: "standard",
});

const topic = new eventhub.Topic("test", {
    resourceGroupName: resourceGroup.name,
    namespaceName: namespace.name,
});

export const subscription = serverless.eventhub.onTopicEvent("test", namespace, topic, {
    resourceGroup: resourceGroup,
    func: async (context, arg) => {
        console.log("arg: " + JSON.stringify(arg, null, 4));
        console.log("context: " + JSON.stringify(context, null, 4));
    },
});
