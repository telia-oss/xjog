---
"@telia-oss/xjog": patch
---

Release a deferred event's lock when its send fails, so a live instance retries it on the next poll instead of stranding it until the instance restarts. A chart mutex acquire timeout while delivering a `done.invoke` event used to leave the chart parked in its invoking state for good.
