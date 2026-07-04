# XJog

A statechart runner for **long-living, database-persisted** [XState](https://xstate.js.org/)
charts. XJog is built for driving business processes that run for minutes, days,
or months — an order that moves from cart, through checkout, into fulfilment and
delivery — where each chart must survive restarts, deploys, and crashes.

> **Alpha.** The API, feature set, and database schema are still changing. Future
> versions may not migrate data written by earlier alpha releases. Current
> version: `0.2.0`.

XState defines *how* a chart behaves; XJog takes ownership of *running* it:
persisting every transition, resuming charts after a shutdown, scheduling delayed
events, and coordinating handoff between multiple running instances.

## Availability

These are **internal Telia packages**, published to Telia's JFrog Artifactory
under the `@telia-oss` scope — not to the public npm registry. Requirements:

- Node.js **>= 24**
- `xstate@4` (peer), `rxjs@7` (peer of core)

## Packages

| Package | Purpose |
| --- | --- |
| `@telia-oss/xjog` | Core engine — lifecycle, machine registration, chart running |
| `@telia-oss/xjog-util` | Shared types, logging, helpers |
| **Chart persistence** | |
| `@telia-oss/xjog-core-persistence` | Abstract persistence adapter + shared SQL |
| `@telia-oss/xjog-core-pg` | PostgreSQL adapter (production) |
| `@telia-oss/xjog-core-pglite` | PGlite adapter (in-process; dev & tests) |
| **Journal** (optional — records chart state-change history) | |
| `@telia-oss/xjog-journal-persistence` · `-pg` · `-pglite` | Journal adapters |
| `@telia-oss/xjog-journal-writer` · `-reader` | Write / query the journal |
| **Digest** (optional — derived, queryable chart digests) | |
| `@telia-oss/xjog-digest-persistence` · `-pg` · `-pglite` | Digest adapters |
| `@telia-oss/xjog-digest-writer` · `-reader` | Write / query digests |

## What it does

- **Persistence** — every chart's state is stored in Postgres (or PGlite); nothing
  lives only in memory.
- **Recovery** — on startup an instance adopts and resumes charts left behind by a
  previous run.
- **Delayed events** — XState `after(...)` timers and delayed sends are persisted
  and fire even across restarts.
- **Activities & invoked services** — long-running side effects are tracked per
  chart and cleaned up on stop.
- **External identifiers** — look a chart up by your own domain id
  (`getChartByExternalId`), not just its internal id.
- **Multi-instance ownership** — charts are fenced to one owner; during a rolling
  deploy a draining instance hands its charts to a successor, and a lost-ownership
  write surfaces as `ChartOwnershipLostError` instead of silently clobbering.
- **Simulator** — rule-based interception of events for testing.

## Install

Point the `@telia-oss` scope at the Artifactory registry (repo `.npmrc`), with an
auth token in your `~/.npmrc` (never commit the token):

```ini
# .npmrc
@telia-oss:registry=https://jfrog.teliacompany.io/artifactory/api/npm/ecom-npm-local/
```

```shell
pnpm add xstate@4 @telia-oss/xjog @telia-oss/xjog-core-pglite
```

Use `@telia-oss/xjog-core-pg` instead of `-pglite` for a real PostgreSQL backend.

## Quick start

```typescript
import { XJog } from '@telia-oss/xjog';
import { PGlitePersistenceAdapter } from '@telia-oss/xjog-core-pglite';
import { createMachine } from 'xstate';

const doorMachine = createMachine({
  id: 'door',
  initial: 'closed',
  predictableActionArguments: true,
  states: {
    closed: { on: { open: 'open' } },
    open: { on: { close: 'closed' } },
  },
});

// In-process PGlite database (swap for a Postgres adapter in production)
const persistence = await PGlitePersistenceAdapter.connect();

const xJog = new XJog({ persistence });
const door = await xJog.registerMachine(doorMachine);
await xJog.start();

// Create and drive a persisted chart
const frontDoor = await door.createChart();
door.changes.subscribe((change) => console.log('door changed:', change));

await frontDoor.send('open');
await frontDoor.send('close');

// Graceful shutdown — charts are left persisted for the next instance to resume
await frontDoor.stop();
await xJog.shutdown();
```

## Development & releasing

- [contributing/development.md](contributing/development.md) — monorepo layout
  (pnpm workspaces + Turborepo), build/test/lint commands, branching.
- [contributing/releasing.md](contributing/releasing.md) — Changesets flow and
  publishing to Artifactory.

## License & attribution

MIT. Originally created by Sami Hult; now maintained as a hard fork by Telia at
[telia-oss/xjog](https://github.com/telia-oss/xjog) and published under the
`@telia-oss` scope.
