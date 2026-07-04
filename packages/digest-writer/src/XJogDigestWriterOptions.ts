import type { XJogStateChange } from '@telia-oss/xjog-util';

import type { DigestOperations } from './Digests';

export type XJogDigestWriterOptions = {
  asyncOperation?: boolean;
  mappings: {
    [machineId: string]: (
      change: XJogStateChange,
    ) => Promise<DigestOperations | null> | DigestOperations | null;
  };
};
