# Deploying OpenPencil Cloud

OpenPencil Cloud runs as one Node 22+ process in front of PostgreSQL and an S3-compatible object
store, with optional SMTP for email. See [security.md](./security.md) for hardening checks.

## Local development

From the repository root, with Docker running:

```sh
bun run cloud:dev
# OpenPencil Cloud: https://<branch>.cloud.open-pencil.localhost
# Captured email:  https://<branch>.mail.open-pencil.localhost
```

The command starts PostgreSQL, SeaweedFS, and Mailpit from [`compose.yml`](./compose.yml) as a
Compose project named after the branch, publishes them on free loopback ports, writes an ignored
TOML file with the branch's Portless URLs under `generated/`, and runs the Cloud server on the host
with `bun --watch` behind Portless. Email and password sign-up is enabled, and every message lands
in Mailpit.

`bun run cloud:dev:down` stops the services and removes the Mailpit route; their volumes are kept.

## Self-hosting

Building, configuring, and running a server, the editor address, the first administrator, operator
commands, email, storage, backups, and upgrades are covered in the
[self-hosting guide](https://openpencil.dev/reference/self-hosting-cloud)
(`packages/docs/reference/self-hosting-cloud.md`). The example files it refers to are here:
[`openpencil-cloud.example.toml`](./openpencil-cloud.example.toml) and [`.env.example`](./.env.example).

## End-to-end tests

```sh
bun --filter @open-pencil/cloud test:e2e         # PostgreSQL and SeaweedFS
bun --filter @open-pencil/cloud test:e2e:garage  # Garage S3 compatibility
```

Each runner starts an isolated Compose project and removes it with its volumes afterwards. The main
suite checks object-store readiness, a presigned single PUT and a 33 MiB three-part multipart upload
(ordered ETags, metadata SHA-256, size, verified GET, deletion), then the full revision flow against
real PostgreSQL: migrations, idempotent commits, stale-base conflicts, multipart cleanup, usage, and
soft deletion.

The Garage profile ([`compose.garage.yml`](./compose.garage.yml)) pins Garage `v2.3.0` as a single
node. Configure Cloud for it with `region = "garage"`, `force_path_style = true`, and
`checksum_verification = "metadata"`, and leave server-side encryption unset.
