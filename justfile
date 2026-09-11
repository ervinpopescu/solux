# Default recipe, lists available commands
default:
    @just --list

# --- Setup & Dependencies ---

# Install dependencies
install:
    npm install

# Clean install dependencies (reproducible build)
ci:
    npm ci

# Configure Git hooks via Husky
setup-hooks:
    npm run prepare

# --- Development ---

# Start development server with HMR
dev *args="":
    npm run dev -- {{args}}

# Preview production build locally
preview:
    npm run preview

# --- Build & Typecheck ---

# Build production bundle
build:
    npm run build

# Run TypeScript type check
typecheck:
    npx tsc -b

# --- Testing ---

# Run Vitest unit tests
test *args="":
    npm test -- {{args}}

# Run Vitest in interactive watch mode
test-watch:
    npm run test:watch

# Run Vitest with coverage report
test-coverage:
    npm run test:coverage

# Run Playwright end-to-end tests
test-e2e *args="":
    npm run test:e2e -- {{args}}

# Run Playwright end-to-end tests with interactive UI
test-e2e-ui:
    npm run test:e2e:ui

# --- Code Quality ---

# Run ESLint check
lint:
    npm run lint

# Run ESLint with automatic fixes
lint-fix:
    npm run lint:fix

# Format code with Prettier
format:
    npm run format

# Check code formatting with Prettier
format-check:
    npm run format:check

# Run all quality checks: format verification, linting, type-checking, and tests
check:
    just format-check
    just lint
    just typecheck
    just test

# --- Infrastructure & Serving ---

# Serve application over local HTTPS via Docker Nginx proxy
serve-https:
    npm run serve:https

# Stop the Docker Nginx HTTPS container
serve-https-stop:
    npm run serve:https:stop

# Tunnel development server over public ngrok HTTPS URL
serve-ngrok:
    npm run serve:ngrok
