// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as azure from "@pulumi/azure";
import * as pulumi from "@pulumi/pulumi";

import * as azurefunctions from "azure-functions-ts-essentials";
import * as azurestorage from "azure-storage";

export type Context = azurefunctions.Context;
export type HttpRequest = azurefunctions.HttpRequest;
export * from "azure-functions-ts-essentials";

export type AzureFunctionHandler = (context: Context, request: HttpRequest) => void;

function signedBlobReadUrl(
    blob: azure.storage.Blob | azure.storage.ZipBlob,
    account: azure.storage.Account,
    container: azure.storage.Container,
): pulumi.Output<string> {
    // Choose a fixed, far-future expiration date for signed blob URLs.
    // The shared access signature (SAS) we generate for the Azure storage blob must remain valid for as long as the
    // Function App is deployed, since new instances will download the code on startup. By using a fixed date, rather
    // than (e.g.) "today plus ten years", the signing operation is idempotent.
    const signatureExpiration = new Date(2100, 1);

    return pulumi.all([
        account.primaryConnectionString,
        container.name,
        blob.name,
    ]).apply(([connectionString, containerName, blobName]) => {
        const blobService = new azurestorage.BlobService(connectionString);
        const signature = blobService.generateSharedAccessSignature(
            containerName,
            blobName,
            {
                AccessPolicy: {
                    Expiry: signatureExpiration,
                    Permissions: azurestorage.BlobUtilities.SharedAccessPermissions.READ,
                },
            },
        );

        return blobService.getUrl(containerName, blobName, signature);
    });
}

async function blobContent(name: string, handler: AzureFunctionHandler): Promise<pulumi.asset.AssetMap> {
    const serializedHandler = await pulumi.runtime.serializeFunction(handler);
    const map: pulumi.asset.AssetMap = {};

    map["host.json"] = new pulumi.asset.StringAsset(JSON.stringify({}));
    map[`${name}/function.json`] = new pulumi.asset.StringAsset(JSON.stringify({
        "disabled": false,
        "bindings": [
            {
                "authLevel": "anonymous",
                "type": "httpTrigger",
                "direction": "in",
                "name": "req",
            },
            {
                "type": "http",
                "direction": "out",
                "name": "$return",
            },
        ],
    }));
    map[`${name}/index.js`] = new pulumi.asset.StringAsset(`module.exports = require("./handler").handler`),
    map[`${name}/handler.js`] = new pulumi.asset.StringAsset(serializedHandler.text);

    return map;
}


// An Azure function exposed via an HTTP endpoint.
export class HttpFunction extends pulumi.ComponentResource {
    readonly resourceGroup: azure.core.ResourceGroup;

    readonly storageAccount: azure.storage.Account;
    readonly storageContainer: azure.storage.Container;
    readonly blob: azure.storage.ZipBlob;

    readonly appServicePlan: azure.appservice.Plan;
    readonly functionApp: azure.appservice.FunctionApp;

    readonly codeBlobUrl: pulumi.Output<string>;
    readonly endpoint: pulumi.Output<string>;

    constructor(name: string, handler: AzureFunctionHandler, options?: pulumi.ResourceOptions) {
        super("azure:HttpFunction", name, {}, options);

        const parentArgs = { parent: this };

        this.resourceGroup = new azure.core.ResourceGroup(`${name}-rg`, {
            location: "West US 2",
        }, parentArgs);

        const resourceGroupArgs = {
            resourceGroupName: this.resourceGroup.name,
            location: this.resourceGroup.location,
        };

        this.storageAccount = new azure.storage.Account(`${name}sa`, {
            ...resourceGroupArgs,

            accountKind: "StorageV2",
            accountTier: "Standard",
            accountReplicationType: "LRS",
        }, parentArgs);

        this.storageContainer = new azure.storage.Container(`${name}-c`, {
            resourceGroupName: this.resourceGroup.name,
            storageAccountName: this.storageAccount.name,
            containerAccessType: "private",
        }, parentArgs);

        this.blob = new azure.storage.ZipBlob(`${name}-b`, {
            resourceGroupName: this.resourceGroup.name,
            storageAccountName: this.storageAccount.name,
            storageContainerName: this.storageContainer.name,
            type: "block",

            content: new pulumi.asset.AssetArchive(blobContent(name, handler)),
        }, parentArgs);

        this.codeBlobUrl = signedBlobReadUrl(this.blob, this.storageAccount, this.storageContainer);

        this.appServicePlan = new azure.appservice.Plan(`${name}-p`, {
            ...resourceGroupArgs,

            kind: "FunctionApp",

            // https://social.msdn.microsoft.com/Forums/azure/en-US/665c365d-2b86-4a77-8cea-72ccffef216c
            sku: {
                tier: "Dynamic",
                size: "Y1",
            },
        }, parentArgs);

        this.functionApp = new azure.appservice.FunctionApp(`${name}-app`, {
            ...resourceGroupArgs,

            appServicePlanId: this.appServicePlan.id,
            storageConnectionString: this.storageAccount.primaryConnectionString,

            appSettings: {
                "WEBSITE_RUN_FROM_ZIP": this.codeBlobUrl,
            },
        }, parentArgs);

        this.endpoint = this.functionApp.defaultHostname.apply(h => {
            return `https://${h}/api/${name}`;
        });
    }
}
