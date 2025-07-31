---

### ALPHA NOTICE

This library is in the **alpha phase**. The programming interface and the
feature set are still changing! The database structure will evolve and
future versions may not be able to migrate data from alpha versions. The
documentation and test coverage are being improved.

---

![XJog](https://www.xjog.io/_next/image?url=%2Fxjog-md.png&w=640&q=75)

XJog is a specialized [XState](https://xstate.js.org/) statechart runner.

It is made specifically for running long-living, persisted charts. This makes
it suitable for driving business processes that can take considerable time
to execute. A real-life example is a customer process starting from the cart,
going through checkout and managing the delivery of the goods.

The main features:

- Statechart persistence into a [database](#database-adapters)
- Recovery after shutdown
- External identifiers

Modules:

- Core

On roadmap:

- Delta listening
- Chart migration

## Database adapters

- **PostgreSQL**

  Robust and suitable for production. Support for deltas and listening for
  changes on database level (external process can track changes).

- **PGlite**

  Lightweight but fairly complete Postgres compatible database for development
  and testing purposes.

## Usage

```shell script
yarn add xstate@4 @samihult/xjog @samihult/xjog-core-pglite
```

```typescript
import { XJog } from '@samihult/xjog';
import { PGlitePersistenceAdapter } from '@samihult/xjog-core-pglite';
import { createMachine } from 'xstate';

// Configure a regular xState chart
export const doorMachine = createMachine({
  id: 'door',
  initial: 'closed',
  states: {
    closed: {
      on: {
        open: 'open',
      },
    },
    open: {
      on: {
        close: 'closed',
      },
    },
  },
});

// Use default in-memory database
const persistence = await PGlitePersistenceAdapter.connect();

const xJog = new XJog({ persistence });
const door = await xJog.registerMachine(doorMachine);

await xJog.start();

// Create a door
const frontDoor = await door.createChart();
door.changes.subscribe((stateUpdate) => {
  console.log('Door is', stateUpdate);
});

await frontDoor.send('open');
await frontDoor.send('close');

// Stop everything
await frontDoor.stop();
await xJog.shutdown();
```
