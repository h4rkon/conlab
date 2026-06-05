.PHONY: run install dev build desktop-dev desktop-build test-e2e

run: install dev

install:
	npm install

dev:
	npm run dev

build:
	npm run build

desktop-dev:
	npm run desktop:dev

desktop-build:
	npm run desktop:build

test-e2e:
	npm run test:e2e
