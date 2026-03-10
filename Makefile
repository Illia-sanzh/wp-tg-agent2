.PHONY: dev prod stop logs restart test lint typecheck shell-agent health

dev:
	docker compose up --build

prod:
	docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

stop:
	docker compose down

logs:
	docker compose logs -f --tail=100

restart:
	docker compose restart

test:
	npm test

lint:
	npm run lint

typecheck:
	npm run typecheck

shell-agent:
	docker compose exec greenclaw-agent sh

health:
	curl -sf http://localhost:3010/health | python3 -m json.tool
