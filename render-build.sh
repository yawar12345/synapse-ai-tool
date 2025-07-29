#!/bin/bash

echo "Installing npm dependencies..."
npm install

echo "Installing Playwright browsers..."
npx playwright install

echo "Build complete!"
