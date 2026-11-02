#!/bin/sh
# Native admission pins this executable; system loader/stdlib remain explicit TCB.
exec __CAWS_IMAGE_TOOL_PATH__ __CAWS_IMAGE_TOOL_FLAGS__ "$@"
