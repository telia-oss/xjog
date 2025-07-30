--------------------------------------------------------------------------------
-- Up migration
--------------------------------------------------------------------------------

CREATE INDEX "fullJournalChartParentIndex"
  ON "fullJournalStates" ("parentMachineId", "parentChartId")
  WHERE "parentChartId" IS NOT NULL;

--------------------------------------------------------------------------------
-- Down migration
--------------------------------------------------------------------------------

DROP INDEX "fullJournalChartParentIndex";
