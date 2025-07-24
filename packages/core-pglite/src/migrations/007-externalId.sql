--------------------------------------------------------------------------------
-- Up migration
--------------------------------------------------------------------------------

-- Unique external identifiers assigned to a chart
CREATE TABLE "externalId" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,

  "machineId" TEXT NOT NULL,
  "chartId" TEXT NOT NULL,

  PRIMARY KEY ("key", "value")
);

--------------------------------------------------------------------------------
-- Down migration
--------------------------------------------------------------------------------

DROP TABLE "externalId"; 