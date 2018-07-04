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
     * The name of the property in the context object to bind the actual blob value to.
     * Note really important in our implementation as the blob value will be passed as
     * the second argument to the callback function.
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

/**
 * Creates a new subscription to the given blob using the callback provided, along with optional
 * options to control the behavior of the subscription.
 */
export async function onEvent(
    name: string, account: azure.storage.Account, path: string, callback: BlobCallback,
    args: subscription.EventSubscriptionArgs, opts?: pulumi.ResourceOptions): Promise<BlobEventSubscription> {

    const bindingOutput = account.primaryConnectionString.apply(connectionString => {
        const binding: BlobBinding = {
            name: "blob",
            type: "blobTrigger",
            direction: "in",
            dataType: "binary",
            path: path,
            connection: connectionString,
        };

        return binding;
    });

    return new BlobEventSubscription(name, account, callback, bindingOutput, args, opts);
}

export class BlobEventSubscription extends subscription.EventSubscription<BlobContext, Buffer> {
    readonly account: azure.storage.Account;

    constructor(
        name: string, account: azure.storage.Account, callback: BlobCallback, binding: pulumi.Output<BlobBinding>,
        args?: subscription.EventSubscriptionArgs, options?: pulumi.ResourceOptions) {

        super("azure-serverless:blob:BlobEventSubscription", name, callback,
              binding.apply(b => [b]), args, options);

        this.account = account;
    }
}
