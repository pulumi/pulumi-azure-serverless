PROJECT_NAME := Pulumi Azure Serverless components
NODE_MODULE_NAME := @pulumi/azure-serverless
include ../../build/common.mk

VERSION := $(shell ../../scripts/get-version)

export PATH := $(shell yarn bin 2>/dev/null):$(PATH)

TESTPARALLELISM := 10

build::
	yarn install
	#yarn link @pulumi/pulumi @pulumi/aws
	tsc
	sed -e 's/\$${VERSION}/$(VERSION)/g' < package.json > bin/package.json
	cp ../../README.md ../../LICENSE bin/

lint::
	tslint -c ../tslint.json -p tsconfig.json

test_fast::
	$(GO_TEST_FAST) ./examples

test_all::
	$(GO_TEST) ./examples
