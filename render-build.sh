#!/usr/bin/env bash
set -o errexit

npm ci && npx playwright install --with-deps chromium