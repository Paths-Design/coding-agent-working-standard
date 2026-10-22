#!/bin/sh
# Trusted authority adapter uses its own fresh project Git context.
export CAWS_GIT_BINARY=__CAWS_IMAGE_GIT_PATH__
exec __CAWS_IMAGE_NODE_PATH__ __CAWS_IMAGE_CLI_ENTRY__ "$@"
