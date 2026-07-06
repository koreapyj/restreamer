#!/bin/sh
# restreamer - HLS restreaming daemon and switcher for tvheadend
# Copyright (C) 2026 Yoonji Park
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or any
# later version. This program is distributed WITHOUT ANY WARRANTY; see
# <https://www.gnu.org/licenses/> for details.
#
# POSIX-sh counterpart of fake-tsreadex.mjs for Linux CI / manual smoke runs
# (the vitest e2e uses the .mjs version so it also runs on Windows dev
# machines). Pipes stdin -> stdout like the real filter; exits on EOF,
# SIGTERM, or a broken downstream pipe.

echo "fake-tsreadex: started (argv: $*)" >&2

trap 'exit 0' TERM INT PIPE

# 0<&0: POSIX gives background commands /dev/null as stdin unless
# explicitly redirected — re-assert the inherited pipe.
cat 0<&0 &
CAT=$!
wait "$CAT"
exit 0
