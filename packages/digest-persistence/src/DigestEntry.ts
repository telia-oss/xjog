import type { ChartReference } from '@telia-oss/xjog-util';

export type DigestEntry = {
  created: number;
  timestamp: number;
  ref: ChartReference;
  key: string;
  value: string;
};
