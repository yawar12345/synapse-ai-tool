#!/usr/bin/env bash
# exit on error
set -o errexit

echo "Installing dependencies..."
npm install

echo "Installing Playwright browsers (without system dependencies)..."
npx playwright install chromium