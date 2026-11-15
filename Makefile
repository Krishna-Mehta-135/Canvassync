PROJECTBENCH_COMPOSE = docker compose -f docker-compose.bench.yml --project-name projectbench-w2

.PHONY: bench-up bench-down bench-trivial claim

bench-up:
	$(PROJECTBENCH_COMPOSE) up -d --build --wait
	@seed_id=$$($(PROJECTBENCH_COMPOSE) ps -aq db-seed); test -n "$$seed_id"; test "$$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' $$seed_id)" = "exited 0"
	@for service in http-backend web ws-backend ai-worker; do id=$$($(PROJECTBENCH_COMPOSE) ps -q $$service); test -n "$$id"; test "$$(docker inspect -f '{{.State.Health.Status}}' $$id)" = healthy; done

bench-down:
	$(PROJECTBENCH_COMPOSE) down

bench-trivial:
	node bench/claim.mjs

claim: bench-trivial
