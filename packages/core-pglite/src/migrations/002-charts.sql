--------------------------------------------------------------------------------
-- Up migration
--------------------------------------------------------------------------------

CREATE TABLE "charts" (
  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT transaction_timestamp(),

  -- instanceId of an instance
  "ownerId" TEXT,

  "machineId" TEXT NOT NULL,
  "chartId" TEXT NOT NULL,
  "parentMachineId" TEXT,
  "parentChartId" TEXT,

  -- Full state as serialized JSON
  "state" BYTEA NOT NULL,

  "paused" BOOLEAN NOT NULL DEFAULT false,

  PRIMARY KEY ("machineId", "chartId")
);

--------------------------------------------------------------------------------
-- Down migration
--------------------------------------------------------------------------------

DROP TABLE "charts"; 