#
# Copyright 2019 Joyent, Inc.
#

#
# Vars, Tools, Files, Flags
#
JS_FILES	:= bin/prr lib/prr.js
ESLINT          = ./node_modules/.bin/eslint
ESLINT_FILES	 = $(JS_FILES)
CLEAN_FILES += ./node_modules

#
# Makefile.defs defines variables used as part of the build process.
# Ensure we have the eng submodule before attempting to include it.
#
ENGBLD_REQUIRE          := $(shell git submodule update --init deps/eng)
ENGBLD_SKIP_VALIDATE_BUILDENV = true
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

#
# Repo-specific targets
#
.PHONY: install
install:
	npm install

check:: package.json $(JS_FILES)

#
# Target definitions.  This is where we include the target Makefiles for
# the "defs" Makefiles we included above.
#
include ./deps/eng/tools/mk/Makefile.targ
