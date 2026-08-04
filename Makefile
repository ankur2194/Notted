.DEFAULT_GOAL := help

.PHONY: help install env-init env-check infra-project infra-up infra-up-ports infra-down infra-status infra-logs infra-reset-dev dev dev-api dev-web build format format-check lint type-check test test-ci db-check db-generate db-migrate db-studio seed

help:
	@echo "Notted developer targets delegate to the canonical pnpm scripts."

install:
	pnpm install --frozen-lockfile --strict-peer-dependencies

env-init:
	pnpm env:init

env-check:
	pnpm env:check

infra-up:
	pnpm infra:up

infra-up-ports:
	pnpm infra:up:ports

infra-project:
	pnpm infra:project

infra-down:
	pnpm infra:down

infra-status:
	pnpm infra:status

infra-logs:
	pnpm infra:logs

infra-reset-dev:
	pnpm infra:reset:dev

dev:
	pnpm dev

dev-api:
	pnpm dev:api

dev-web:
	pnpm dev:web

build:
	pnpm build

format:
	pnpm format

format-check:
	pnpm format:check

lint:
	pnpm lint

type-check:
	pnpm type-check

test:
	pnpm test

test-ci:
	pnpm test:ci

db-check:
	pnpm db:check

db-generate:
	pnpm db:generate

db-migrate:
	pnpm db:migrate

db-studio:
	pnpm db:studio

seed:
	pnpm db:seed
