--------------------------------------------------------------------------------
-- Up migration
--------------------------------------------------------------------------------

CREATE INDEX "journalChartIndex" ON "journalEntries" ("machineId", "chartId");


--------------------------------------------------------------------------------
-- Down migration
--------------------------------------------------------------------------------

DROP INDEX "journalChartIndex";

