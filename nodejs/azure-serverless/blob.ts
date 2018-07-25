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

import * as subscription from "./subscription";

interface BlobBinding extends subscription.Binding {
    /**
     * The name of the property in the context object to bind the actual blob value to. Not really
     * important in our implementation as the blob value will be passed as the second argument to
     * the callback function.
     */
    name: string;

    /**
     * The type of a blob binding.  Must be 'blobTrigger'.
     */
    type: "blobTrigger";

    /**
     * The direction of the binding.  We only 'support' blobs being inputs to functions.
     */
    direction: "in";

    /**
     * How we want the blob represented when passed into the callback.  We specify 'binary'
     * so that all data is passed in as a buffer.  Otherwise, Azure will attempt to sniff
     * the content and convert it accordingly.  This gives us a consistent way to know what
     * data will be passed into the function.
     */
    dataType: "binary";

    /**
     * The path to the blob we want to create a trigger for.
     */
    path: string;

    /**
     * The storage connection string for the storage account containing the blob.
     */
    connection: string;
}

/**
 * Data that will be passed along in the context object to the BlobCallback.
 */
export interface BlobContext extends azurefunctions.Context {
    "executionContext": {
        "invocationId": string;
        "functionName": string;
        "functionDirectory": string;
    };

    "bindingData": {
        "blobTrigger": string;
        "uri": string;
        "properties": {
            "cacheControl": any,
            "contentDisposition": any,
            "contentEncoding": any,
            "contentLanguage": any,
            "length": number,
            "contentMD5": any,
            "contentType": string,
            "eTag": string,
            "lastModified": string,
            "blobType": string,
            "leaseStatus": string,
            "leaseState": string,
            "leaseDuration": string,
            "pageBlobSequenceNumber": any,
            "appendBlobCommittedBlockCount": any,
            "isServerEncrypted": boolean,
        },
        "metadata": Record<string, string>,
        "sys": {
            "methodName": string,
            "utcNow": string,
        },
        "invocationId": string,
    };
}

/**
 * Signature of the callback that can receive blob notifications.
 */
export type BlobCallback = subscription.Callback<BlobContext, Buffer>;

export interface BlobEventSubscriptionArgs extends subscription.EventSubscriptionArgs {
    /**
     * An optional prefix or suffix to filter down notifications.  See
     * https://docs.microsoft.com/en-us/azure/azure-functions/functions-bindings-storage-blob#trigger---blob-name-patterns
     * for more details.
     */
    filterPrefix?: string;
    filterSuffix?: string;
}

/**
 * Creates a new subscription to the given blob using the callback provided, along with optional
 * options to control the behavior of the subscription.
 */
export async function onBlobEvent(
    name: string, container: azure.storage.Container, callback: BlobCallback,
    args: BlobEventSubscriptionArgs, opts?: pulumi.ResourceOptions): Promise<BlobEventSubscription> {

    const account = await azure.storage.getAccount({ name: container.storageAccountName, resourceGroupName: container.resourceGroupName });

    args = args || {};
    const prefix = args.filterPrefix || "";
    const suffix = args.filterSuffix || "";
    const pathOutput = container.name.apply(n => n + `/${prefix}{blobName}${suffix}`);

    // The blob binding does not store the storage connection string directly.  Instead, the
    // connection string is put into the app settings (under whatever key we want). Then, the
    // .connection property of the binding contains the *name* of that app setting key.
    const bindingConnectionKey = "BindingConnectionAppSettingsKey";

    const bindingOutput = pathOutput.apply(path => {
        const binding: BlobBinding = {
            name: "blob",
            type: "blobTrigger",
            direction: "in",
            dataType: "binary",
            path: path,
            connection: bindingConnectionKey,
        };

        return binding;
    });

    const appSettingsOutput = args.appSettings || pulumi.output({});

    args.appSettings = pulumi.all([appSettingsOutput, account.primaryConnectionString]).apply(
        ([appSettings, connectionString]) => {
            appSettings[bindingConnectionKey] = connectionString;
            return appSettings;
        });

    return new BlobEventSubscription(name, container, callback, bindingOutput, args, opts);
}

export class BlobEventSubscription extends subscription.EventSubscription<BlobContext, Buffer> {
    readonly container: azure.storage.Container;

    constructor(
        name: string, container: azure.storage.Container, callback: BlobCallback, binding: pulumi.Output<BlobBinding>,
        args: subscription.EventSubscriptionArgs, options?: pulumi.ResourceOptions) {

        super("azure-serverless:blob:BlobEventSubscription", name, callback,
              binding.apply(b => [b]), args, options);

        this.container = container;
    }
}
