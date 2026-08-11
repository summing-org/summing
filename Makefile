.PHONY: build test lint health

build:
	npm run build

test:
	npm test

lint:
	npm run lint

health:
	curl --fail --silent http://127.0.0.1:8765/health
