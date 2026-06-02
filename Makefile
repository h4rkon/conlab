.PHONY: run install dev build

run: install dev

install:
	npm install

dev:
	npm run dev

build:
	npm run build
