.PHONY: run install dev build test-e2e

run: install dev

install:
	npm install

dev:
	npm run dev

build:
	npm run build

test-e2e:
	npm run test:e2e
