#!/usr/bin/env bash
# exit on error
set -o errexit

echo "Updating system packages and installing dependencies for virtual display..."
apt-get update
apt-get install -y xvfb xauth

echo "Installing project dependencies..."
npm install

echo "Installing Playwright browsers (Chromium only)..."
npx playwright install chromium

echo "Build complete!"
