PROJECTBENCH_COMPOSE = docker compose -f docker-compose.bench.yml --project-name projectbench-w2 --profile w2
PROJECTBENCH_W4_COMPOSE = docker compose -f docker-compose.bench.yml --project-name projectbench-w4 --profile w4

.PHONY: bench-up bench-down bench-trivial bench-w4-up bench-w4-down bench-w4 claim

bench-up:
	$(PROJECTBENCH_COMPOSE) up -d --build --wait
	@seed_id=$$($(PROJECTBENCH_COMPOSE) ps -aq db-seed); test -n "$$seed_id"; test "$$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' $$seed_id)" = "exited 0"
	@for service in http-backend web ws-backend ai-worker; do id=$$($(PROJECTBENCH_COMPOSE) ps -q $$service); test -n "$$id"; test "$$(docker inspect -f '{{.State.Health.Status}}' $$id)" = healthy; done

bench-down:
	$(PROJECTBENCH_COMPOSE) down

bench-trivial:
	node bench/claim.mjs

bench-w4-up:
	@test "$$(docker info --format '{{.MemTotal}}')" -ge 12000000000 || { echo 'W4 requires at least 12 GB Docker memory' >&2; exit 2; }
	$(PROJECTBENCH_W4_COMPOSE) up -d --build --wait
	$(PROJECTBENCH_W4_COMPOSE) exec -T postgres psql -U postgres -d canvas -v ON_ERROR_STOP=1 < bench/seed.sql
	@for service in ws-baseline ws-candidate generator-w4; do id=$$($(PROJECTBENCH_W4_COMPOSE) ps -q $$service); test -n "$$id"; test "$$(docker inspect -f '{{.State.Health.Status}}' $$id)" = healthy; done

bench-w4-down:
	$(PROJECTBENCH_W4_COMPOSE) down

bench-w4:
	@commit=$$(git rev-parse HEAD); \
	 host_cpu=$$(sysctl -n machdep.cpu.brand_string); \
	 docker_version=$$(docker version --format '{{.Server.Version}}'); \
	 generator_image=$$($(PROJECTBENCH_W4_COMPOSE) images -q generator-w4); \
	 baseline_image=$$($(PROJECTBENCH_W4_COMPOSE) images -q ws-baseline); \
	 candidate_image=$$($(PROJECTBENCH_W4_COMPOSE) images -q ws-candidate); \
	 test -n "$$generator_image"; test -n "$$baseline_image"; test "$$baseline_image" = "$$candidate_image"; \
	 $(PROJECTBENCH_W4_COMPOSE) exec -T \
	   -e PROJECTBENCH_COMMIT="$$commit" \
	   -e PROJECTBENCH_HOST_CPU="$$host_cpu" \
	   -e PROJECTBENCH_DOCKER_VERSION="$$docker_version" \
	   -e PROJECTBENCH_OS="$$(uname -s)" \
	   -e PROJECTBENCH_SUT_CPUSET="0-1" \
	   -e PROJECTBENCH_SUT_MEMORY_MB="384" \
	   -e PROJECTBENCH_IMAGE_GENERATOR="$$generator_image" \
	   -e PROJECTBENCH_IMAGE_WS_BASELINE="$$baseline_image" \
	   -e PROJECTBENCH_IMAGE_WS_CANDIDATE="$$candidate_image" \
	   generator-w4 node /bench/cold-start.mjs

claim: bench-trivial
