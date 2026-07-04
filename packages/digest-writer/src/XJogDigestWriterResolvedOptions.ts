import type { XJogStateChange } from '@samihult/xjog-util';

import type { DigestOperations } from './Digests';

export type XJogDigestWriterResolvedOptions = {
  asyncOperation: boolean;
  mappings: {
    [machineId: string]: (
      change: XJogStateChange,
    ) => Promise<DigestOperations | null> | DigestOperations | null;
  };
};
