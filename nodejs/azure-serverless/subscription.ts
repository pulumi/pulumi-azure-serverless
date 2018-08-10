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
import * as fs from "fs";
import * as filepath from "path";

import * as azurefunctions from "azure-functions-ts-essentials";
import { signedBlobReadUrl } from "./util";

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

export interface EventSubscriptionArgs {
    /**
     * The resource group to create the serverless FunctionApp within.  If not provided, a new
     * resource group will be created with the same name as the pulumi resource. It will be created
     * in the region specified by the config variable "azure:region"
     */
    resourceGroup: pulumi.Input<azure.core.ResourceGroup>;

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
     * The consumption plan to put the FunctionApp in.  If not provided, a 'Dynamic', 'Y1' plan will
     * be used.  See https://social.msdn.microsoft.com/Forums/azure/en-US/665c365d-2b86-4a77-8cea-72ccffef216c for
     * additional details.
     */
    appServicePlan?: azure.appservice.Plan;

    /**
     * A key-value map to use as the 'App Settings' for this function.
     */
    appSettings?: pulumi.Output<Record<string, string>>;
}

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
        handler: Callback<C, Data>,
        bindingsOutput: pulumi.Input<Binding[]>,
    ): pulumi.Output<pulumi.asset.AssetMap> {

    const includedPackages = new Set<string>();
    const excludedPackages = new Set<string>();

    const pathSetOutput = pulumi.output(allFoldersForPackages(includedPackages, excludedPackages));

    const serializedHandlerOutput = pulumi.output(pulumi.runtime.serializeFunction(handler));
    return pulumi.all([bindingsOutput, serializedHandlerOutput, pathSetOutput]).apply(([bindings, serializedHandler, pathSet]) => {
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
        map[`${name}/index.js`] = new pulumi.asset.StringAsset(`module.exports = require("./handler").handler`),
        map[`${name}/handler.js`] = new pulumi.asset.StringAsset(serializedHandler.text);

        // TODO: unify this code with aws-serverless instead of straight copying.
        // For each of the required paths, add the corresponding FileArchive or FileAsset to the AssetMap.
        for (const path of pathSet.values()) {
            // The Asset model does not support a consistent way to embed a file-or-directory into an `AssetArchive`, so
            // we stat the path to figure out which it is and use the appropriate Asset constructor.
            const stats = fs.lstatSync(path);
            if (stats.isDirectory()) {
                map[name + "/" + path] = new pulumi.asset.FileArchive(path);
            } else {
                map[name + "/" + path] = new pulumi.asset.FileAsset(path);
            }
        }

        return map;
    });
}

// Package is a node in the package tree returned by readPackageTree.
interface Package {
    name: string;
    path: string;
    package: {
        dependencies?: { [key: string]: string; };
    };
    parent?: Package;
    children: Package[];
}

const readPackageTree = require("read-package-tree");

// allFolders computes the set of package folders that are transitively required by the root
// 'dependencies' node in the client's project.json file.
function allFoldersForPackages(includedPackages: Set<string>, excludedPackages: Set<string>): Promise<Set<string>> {
    return new Promise((resolve, reject) => {
        readPackageTree(".", undefined, (err: any, root: Package) => {
            if (err) {
                return reject(err);
            }

            // This is the core starting point of the algorithm.  We use readPackageTree to get the
            // package.json information for this project, and then we start by walking the
            // .dependencies node in that package.  Importantly, we do not look at things like
            // .devDependencies or or .peerDependencies.  These are not what are considered part of
            // the final runtime configuration of the app and should not be uploaded.
            const referencedPackages = new Set<string>(includedPackages);
            if (root.package && root.package.dependencies) {
                for (const depName of Object.keys(root.package.dependencies)) {
                    referencedPackages.add(depName);
                }
            }

            const packagePaths = new Set<string>();
            for (const pkg of referencedPackages) {
                addPackageAndDependenciesToSet(root, pkg, packagePaths, excludedPackages);
            }

            resolve(packagePaths);
        });
    });
}

// addPackageAndDependenciesToSet adds all required dependencies for the requested pkg name from the given root package
// into the set.  It will recurse into all dependencies of the package.
function addPackageAndDependenciesToSet(
    root: Package, pkg: string, packagePaths: Set<string>, excludedPackages: Set<string>) {
    // Don't process this packages if it was in the set the user wants to exclude.

    // Also, exclude it if it's an @pulumi package.  These packages are intended for deployment
    // time only and will only bloat up the serialized lambda package.
    if (excludedPackages.has(pkg) ||
        pkg.startsWith("@pulumi")) {

        return;
    }

    const child = findDependency(root, pkg);
    if (!child) {
        console.warn(`Could not include required dependency '${pkg}' in '${filepath.resolve(root.path)}'.`);
        return;
    }

    packagePaths.add(child.path);
    if (child.package.dependencies) {
        for (const dep of Object.keys(child.package.dependencies) ) {
            addPackageAndDependenciesToSet(child, dep, packagePaths, excludedPackages);
        }
    }
}

// findDependency searches the package tree starting at a root node (possibly a child) for a match for the given name.
// It is assumed that the tree was correctly construted such that dependencies are resolved to compatible versions in
// the closest available match starting at the provided root and walking up to the head of the tree.
function findDependency(root: Package, name: string) {
    for (; root; root = root.parent!) {
        for (const child of root.children) {
            let childName = child.name;
            // Note: `read-package-tree` returns incorrect `.name` properties for packages in an orgnaization - like
            // `@types/express` or `@protobufjs/path`.  Compute the correct name from the `path` property instead. Match
            // any name that ends with something that looks like `@foo/bar`, such as `node_modules/@foo/bar` or
            // `node_modules/baz/node_modules/@foo/bar.
            const childFolderName = filepath.basename(child.path);
            const parentFolderName = filepath.basename(filepath.dirname(child.path));
            if (parentFolderName[0] === "@") {
                childName = filepath.join(parentFolderName, childFolderName);
            }
            if (childName === name) {
                return child;
            }
        }
    }

    return undefined;
}

/**
 * Base type for all subscription types.
 */
export class EventSubscription<C extends Context, Data> extends pulumi.ComponentResource {
    readonly resourceGroup: pulumi.Output<azure.core.ResourceGroup>;
    readonly storageAccount: azure.storage.Account;
    readonly storageContainer: azure.storage.Container;
    readonly appServicePlan: azure.appservice.Plan;

    /**
     * The FunctionApp instance created to respond to the specific Binding triggers.  The
     * code for it will be produced by serializing out the 'callback' parameter using pulumi
     * serialization.
     */
    readonly functionApp: azure.appservice.FunctionApp;

    constructor(type: string, name: string, callback: Callback<C, Data>, bindings: pulumi.Input<Binding[]>,
                args: EventSubscriptionArgs, options?: pulumi.ResourceOptions) {
        super(type, name, {}, options);

        const parentArgs = { parent: this };

        const appSettings = args.appSettings || pulumi.output({});

        if (!args.resourceGroup) {
            throw new pulumi.RunError("[resourceGroup] must be provided in [args].");
        }

        this.resourceGroup = pulumi.output(args.resourceGroup);
        const resourceGroupName = this.resourceGroup.apply(g => g.name);
        const location = this.resourceGroup.apply(g => g.location);

        const resourceGroupArgs = {
            resourceGroupName,
            location,
        };

        this.storageAccount = args.storageAccount || new azure.storage.Account(`${name}`, {
            ...resourceGroupArgs,

            accountKind: "StorageV2",
            accountTier: "Standard",
            accountReplicationType: "LRS",
        }, parentArgs);

        this.storageContainer = args.storageContainer || new azure.storage.Container(`${name}`, {
            resourceGroupName: resourceGroupName,
            storageAccountName: this.storageAccount.name,
            containerAccessType: "private",
        }, parentArgs);

        this.appServicePlan = args.appServicePlan || new azure.appservice.Plan(`${name}`, {
            ...resourceGroupArgs,

            kind: "FunctionApp",

            sku: {
                tier: "Dynamic",
                size: "Y1",
            },
        }, parentArgs);

        const assetMap = serializeCallback(name, callback, bindings);

        // const appSettings = assetAndAppSettings.apply(a => a.appSettings);

        const blob = new azure.storage.ZipBlob(name, {
            resourceGroupName: resourceGroupName,
            storageAccountName: this.storageAccount.name,
            storageContainerName: this.storageContainer.name,
            type: "block",
            content: assetMap.apply(m => new pulumi.asset.AssetArchive(m)),
        }, parentArgs);

        const codeBlobUrl = signedBlobReadUrl(blob, this.storageAccount, this.storageContainer);

        this.functionApp = new azure.appservice.FunctionApp(name, {
            ...resourceGroupArgs,

            appServicePlanId: this.appServicePlan.id,
            storageConnectionString: this.storageAccount.primaryConnectionString,

            appSettings: appSettings.apply(settings => ({
                ...settings,
                "WEBSITE_RUN_FROM_ZIP": codeBlobUrl,
            })),
        }, parentArgs);
    }
}
