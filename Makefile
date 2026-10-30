.PHONY: install demo test typecheck serve live check
install:   ## pinned dependencies from package-lock.json
	npm ci
demo:      ## fixture demo: two real server processes, one SQLite file, no API key, no cost
	npm run demo
test:      ## store, auth, access, injection, assistant and process-restart tests
	npm test
typecheck:
	npm run typecheck
serve:     ## run the API locally with the fixture assistant (prints its URL)
	npm run serve
live:      ## real model run, needs ANTHROPIC_API_KEY, costs money
	npm run live
check: typecheck test demo
