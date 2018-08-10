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

export function signedBlobReadUrl(
    blob: azure.storage.Blob | azure.storage.ZipBlob,
    account: azure.storage.Account,
    container: azure.storage.Container,
): pulumi.Output<string> {
    // Choose a fixed, far-past and far-future expiration date for signed blob URLs.
    // The shared access signature (SAS) we generate for the Azure storage blob must remain valid for as long as the
    // Function App is deployed, since new instances will download the code on startup. By using a fixed date, rather
    // than (e.g.) "today plus ten years", the signing operation is idempotent.
    const signatureStart = new Date(0);
    const signatureExpiration = new Date(2100, 1);

    return pulumi.all([blob.url, account.primaryConnectionString]).apply(async ([blobUrl, connectionString]) => {
        const accountSAS = await azure.storage.getAccountSAS({
            connectionString: connectionString,
            start: signatureStart.toISOString(),
            expiry: signatureExpiration.toISOString(),
            permissions: {
                read: true,
                write: false,
                create: false,
                add: false,
                list: false,
                delete: false,
                update: false,
                process: false,
            },
            services: {
                blob: true,
                file: false,
                queue: false,
                table: false,
            },
            resourceTypes: {
                object: true,
                container: false,
                service: false,
            },
        });
        return blobUrl + accountSAS.sas;
    });
}
