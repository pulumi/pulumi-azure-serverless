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
import * as appservice from "@pulumi/azure/appservice";
import * as pulumi from "@pulumi/pulumi";

import * as azurefunctions from "azure-functions-ts-essentials";
import { Overwrite, signedBlobReadUrl } from "./util";

export interface Context extends azurefunctions.Context {
    log: {
        (...message: Array<any>): void;
        error(...message: Array<any>): void;
        warn(...message: Array<any>): void;
        info(...message: Array<any>): void;
        verbose(...message: Array<any>): void;
        metric(...message: Array<any>): void;
    };
}

/**
 * A synchronous function that can be converted into an Azure FunctionApp. This callback should
 * return nothing, and should signal that it is done by calling `context.Done()`. Errors can be
 * signified by calling `context.Done(err)`
 */
export type Callback<C extends Context, Data> = (context: C, data: Data) => void;

/**
 * CallbackFactory is the signature for a function that will be called once to produce the function
 * that Azure FunctionApps will call into.  It can be used to initialize expensive state once that
 * can then be used across all invocations of the FunctionApp (as long as the FunctionApp is using
 * the same warm node instance).
 */
export type CallbackFactory<C extends Context, Data> = () => Callback<C, Data>;

export type EventSubscriptionArgs<C extends Context, Data> = Overwrite<appservice.FunctionAppArgs, {
    /**
     * The Javascript function instance to use as the entrypoint for the Azure FunctionApp.  Either
     * [func] or [factoryFunc] must be provided.
     */
    func?: Callback<C, Data>;

    /**
     * The Javascript function instance that will be called to produce the function that is the
     * entrypoint for the Azure FunctionApp. Either [func] or [factoryFunc] must be provided.
     *
     * This form is useful when there is expensive initialization work that should only be executed
     * once.  The factory-function will be invoked once when the final Azure FunctionApp module is
     * loaded. It can run whatever code it needs, and will end by returning the actual function that
     * the Azure will call into each time the FunctionApp it is is invoked.
     */
    factoryFunc?: CallbackFactory<C, Data>;

    /**
     * The name of the resource group in which to create the Function App.
     */
    resourceGroupName: pulumi.Input<string>;

    /**
     * Specifies the supported Azure location where the resource exists. Changing this forces a new resource to be created.
     */
    location: pulumi.Input<string>;

    /**
     * The ID of the App Service Plan within which to create this Function App. Changing this forces
     * a new resource to be created.
     *
     * If not provided, a plan will created automatically for this FunctionApp.
     */
    appServicePlanId?: pulumi.Input<string>;

    /**
     * The storage account to use where the zip-file blob for the FunctionApp will be located. If
     * not provided, a new storage account will create. It will be a 'Standard', 'LRS', 'StorageV2'
     * account.
     */
    storageAccount?: azure.storage.Account;

    /**
     * The container to use where the zip-file blob for the FunctionApp will be located. If not
     * provided, the root container of the storage account will be used.
     */
    storageContainer?: azure.storage.Container;

    /**
     * A key-value pair of App Settings.
     */
    appSettings?: pulumi.Input<{ [key: string]: any; }>

    /**
     * Options to control which files and packages are included with the serialized FunctionApp code.
     */
    codePathOptions?: pulumi.runtime.CodePathOptions;

    /**
     * The paths relative to the program folder to include in the FunctionApp upload.  Default is
     * `[]`.
     *
     * @deprecated Use [codePathOptions] instead.
     */
    includePaths?: string[];

    /**
     * The packages relative to the program folder to include in the FunctionApp upload.  The
     * version of the package installed in the program folder and it's dependencies will all be
     * included. Default is `[]`.
     *
     * @deprecated Use [codePathOptions] instead.
     */
    includePackages?: string[];

    /**
     * The packages relative to the program folder to not include the FunctionApp upload. This can
     * be used to override the default serialization logic that includes all packages referenced by
     * project.json (except @pulumi packages).  Default is `[]`.
     *
     * @deprecated Use [codePathOptions] instead.
     */
    excludePackages?: string[];
}>;

/**
 * Represents a Binding that will be emitted into the function.json config file for the FunctionApp.
 * Individual services will have more specific information they will define in their own bindings.
 */
export interface Binding {
    type: string;
    direction: string;
    name: string;
}

/**
 * Takes in a callback and a set of bindings, and produces the right AssetMap layout that Azure
 * FunctionApps expect.
 */
function serializeCallback<C extends Context, Data>(
        name: string,
        eventSubscriptionArgs: EventSubscriptionArgs<C, Data>,
        bindingsInput: pulumi.Input<Binding[]>,
    ): pulumi.Output<pulumi.asset.AssetMap> {

    if (eventSubscriptionArgs.func && eventSubscriptionArgs.factoryFunc) {
        throw new pulumi.RunError("Cannot provide both [func] and [factoryFunc]");
    }

    if (!eventSubscriptionArgs.func && !eventSubscriptionArgs.factoryFunc) {
        throw new Error("Missing required function callback");
    }

    let func: Function;
    if (eventSubscriptionArgs.func) {
        func = redirectConsoleOutput(eventSubscriptionArgs.func);
    }
    else {
        func = () => {
            const innerFunc = eventSubscriptionArgs.factoryFunc!();
            return redirectConsoleOutput(innerFunc);
        };
    }

    const serializedHandlerPromise = pulumi.runtime.serializeFunction(
        func, { isFactoryFunction: !!eventSubscriptionArgs.factoryFunc });

    const codePathOptions = eventSubscriptionArgs.codePathOptions || {};
    codePathOptions.extraIncludePaths = codePathOptions.extraIncludePaths || eventSubscriptionArgs.includePaths;
    codePathOptions.extraIncludePackages = codePathOptions.extraIncludePaths || eventSubscriptionArgs.includePackages;
    codePathOptions.extraExcludePackages = codePathOptions.extraExcludePackages || eventSubscriptionArgs.excludePackages;
    const pathSetPromise = pulumi.runtime.computeCodePaths(codePathOptions);

    return pulumi.output(bindingsInput).apply(async (bindings) => {
        const map: pulumi.asset.AssetMap = {};
        map["host.json"] = new pulumi.asset.StringAsset(JSON.stringify({
            "tracing": {
                "consoleLevel": "verbose",
            },
        }));

        map[`${name}/function.json`] = new pulumi.asset.StringAsset(JSON.stringify({
            "disabled": false,
            "bindings": bindings,
        }));

        const serializedHandler = await serializedHandlerPromise;
        map[`${name}/index.js`] = new pulumi.asset.StringAsset(`module.exports = require("./handler").handler`),
        map[`${name}/handler.js`] = new pulumi.asset.StringAsset(serializedHandler.text);

        // TODO: unify this code with aws-serverless instead of straight copying.
        // For each of the required paths, add the corresponding FileArchive or FileAsset to the AssetMap.
        const pathSet = await pathSetPromise;
        for (const [path, value] of pathSet.entries()) {
            map[name + "/" + path] = value;
        }

        return map;
    });
}

function redirectConsoleOutput<C extends Context, Data>(callback: Callback<C, Data>) {
    return (context: C, data: Data) => {
        // Redirect console logging to context logging.
        console.log = context.log;
        console.error = context.log.error;
        console.warn = context.log.warn;
        // tslint:disable-next-line:no-console
        console.info = context.log.info;

        return callback(context, data);
    };
}


/**
 * Base type for all subscription types.
 */
export class EventSubscription<C extends Context, Data> extends pulumi.ComponentResource {
    readonly storageAccount: azure.storage.Account;
    readonly storageContainer: azure.storage.Container;

    /**
     * The FunctionApp instance created to respond to the specific Binding triggers.  The
     * code for it will be produced by serializing out the 'callback' parameter using pulumi
     * serialization.
     */
    readonly functionApp: appservice.FunctionApp;

    constructor(type: string, name: string, bindings: pulumi.Input<Binding[]>,
                args: EventSubscriptionArgs<C, Data>, options: pulumi.ResourceOptions = {}) {
        super(type, name, {}, options);

        const parentArgs = { parent: this };

        if (!args.resourceGroupName) {
            throw new pulumi.ResourceError("[resourceGroupName] must be provided in [args]", options.parent);
        }

        if (!args.location) {
            throw new pulumi.ResourceError("[location] must be provided in [args]", options.parent);
        }

        const resourceGroupArgs = {
            resourceGroupName: args.resourceGroupName,
            location: args.location,
        };

        let appServicePlanId = args.appServicePlanId;
        if (!appServicePlanId) {
            const plan = new appservice.Plan(name, {
                ...resourceGroupArgs,

                kind: "FunctionApp",

                sku: {
                    tier: "Dynamic",
                    size: "Y1",
                },
            }, parentArgs);
            appServicePlanId = plan.id;
        }

        this.storageAccount = args.storageAccount || new azure.storage.Account(makeSafeStorageAccountName(name), {
            ...resourceGroupArgs,

            accountKind: "StorageV2",
            accountTier: "Standard",
            accountReplicationType: "LRS",
        }, parentArgs);

        this.storageContainer = args.storageContainer || new azure.storage.Container(makeSafeStorageContainerName(name), {
            resourceGroupName: args.resourceGroupName,
            storageAccountName: this.storageAccount.name,
            containerAccessType: "private",
        }, parentArgs);

        const assetMap = serializeCallback(name, args, bindings);
        const blob = new azure.storage.ZipBlob(name, {
            resourceGroupName: args.resourceGroupName,
            storageAccountName: this.storageAccount.name,
            storageContainerName: this.storageContainer.name,
            type: "block",
            content: assetMap.apply(m => new pulumi.asset.AssetArchive(m)),
        }, parentArgs);

        const codeBlobUrl = signedBlobReadUrl(blob, this.storageAccount, this.storageContainer);

        const functionAppArgs = {
            ...args,
            ...resourceGroupArgs,

            appServicePlanId: appServicePlanId,
            storageConnectionString: this.storageAccount.primaryConnectionString,

            appSettings: pulumi.output(args.appSettings).apply(settings => {
                settings = settings || {};
                return {
                    ...settings,
                    "WEBSITE_RUN_FROM_ZIP": codeBlobUrl,
                };
            }),
        };

        this.functionApp = new appservice.FunctionApp(name, functionAppArgs, parentArgs);
    }
}

function makeSafeStorageAccountName(prefix: string) {
    // Account name needs to be at max 24 chars (minus the extra 8 random chars);
    // not exceed the max length of 24.
    // Name must be alphanumeric.
    return prefix.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().substr(0, 24 - 8);
}

function makeSafeStorageContainerName(prefix: string) {
    // Account name needs to be at max 63 chars (minus the extra 8 random chars);
    // Name must be alphanumeric (and hyphens).
    return prefix.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase().substr(0, 63 - 8);
}
