# `ops/` — monitoring configuration

Prometheus scrape config, alert rules, their unit tests, and one Grafana
dashboard for the Notted API.

## This directory adds no container

`compose.yaml` runs **no Prometheus and no Grafana**, and an opt-in monitoring
Compose profile was considered and deliberately rejected. Three reasons:

1. A monitoring stack that only runs when the thing it watches runs is useless
   during the outage it exists for. Real monitoring lives outside the deployment
   it observes.
2. Prometheus plus Grafana is roughly a gigabyte of resident memory on a host
   where the API already carries a Chromium. Paying that permanently for a
   convenience is the wrong trade on VPS-class hardware, and a profile that is
   never enabled is dead configuration that rots.
3. Every artefact here is portable. There is nothing Notted-specific about
   running Prometheus, so shipping one would be shipping someone else's
   deployment decision.

These are **files to point an existing Prometheus and Grafana at**.

## Files

| Path | Purpose |
| --- | --- |
| `prometheus/prometheus.yml` | 15s scrape of `notted-api`, `metrics_path: /metrics`, bearer token via `credentials_file`. |
| `prometheus/alerts.yml` | 14 rules, each with a `for:` duration and a `runbook_url`. |
| `prometheus/alerts_test.yml` | `promtool test rules` unit tests — verifies the rules with no Prometheus running. |
| `grafana/notted-overview.json` | One dashboard, `uid: notted-overview`, `DS_PROMETHEUS` datasource variable, no `__inputs`. |

## Setup

1. **Enable the endpoint.** `GET /metrics` answers `404` until `METRICS_TOKEN`
   is set, and production requires at least 32 characters:

   ```sh
   echo "METRICS_TOKEN=$(openssl rand -hex 32)" >> .env   # repository root
   docker compose up -d api
   ```

2. **Give the scraper the same token — in its own file, never inline:**

   ```sh
   install -m 0400 /dev/stdin /etc/prometheus/secrets/notted-metrics-token <<< "$METRICS_TOKEN"
   ```

   Inline `authorization.credentials` is rendered as `<secret>` by Prometheus's
   config endpoint but still sits in a file that gets committed, copied and
   backed up. `credentials_file` keeps it out of all three.

3. **Copy the config in and reload:**

   ```sh
   cp ops/prometheus/prometheus.yml ops/prometheus/alerts.yml /etc/prometheus/
   promtool check config /etc/prometheus/prometheus.yml
   curl -X POST http://localhost:9090/-/reload
   ```

   Adjust `scrape_configs[0].static_configs[0].targets`: `127.0.0.1:3001` for a
   Prometheus on the Docker host, `api:3001` for one joined to the `backend`
   Compose network.

4. **Verify the rules without an outage:**

   ```sh
   promtool test rules ops/prometheus/alerts_test.yml
   ```

5. **Import the dashboard.** Grafana → Dashboards → Import →
   `ops/grafana/notted-overview.json`, then pick the Prometheus above for the
   `DS_PROMETHEUS` variable.

## Two things that will bite you

- **`TrustedHostMiddleware` answers `421` to an unexpected `Host` when
  `CUSTOM_DOMAINS_ENABLED=true`.** Unlike `/health/live` and `/health/ready`,
  `/metrics` is **not** exempt, so a scraper dialling `10.0.0.5:3001` gets a
  `421` and Prometheus reports the target down. Either scrape a configured
  hostname or add the scrape address to the trusted hosts. See
  `docs/runbooks/observability.md`.
- **`/metrics` must never be routable from the public internet.** The bearer
  token is the access control the application enforces; the reverse proxy owes
  it a second one. See `docs/standards/operations.md`.

The signal catalogue, the label allow-list and the forbidden list, the
correlation walkthrough, and one section per alert live in
[`docs/runbooks/observability.md`](../docs/runbooks/observability.md).
