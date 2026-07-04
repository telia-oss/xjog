export type XJogDigestReaderOptions = {
  /**
   * Notifications for new digest entries are buffered for this many
   * milliseconds before triggering a re-query, so that a burst of
   * notifications collapses into a single `queryDigests` call per
   * distinct chart. Defaults to 50ms.
   */
  notificationDebounceMs?: number;
};
