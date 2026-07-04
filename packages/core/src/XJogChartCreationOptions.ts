import type { ChartReference } from '@samihult/xjog-util';

import type { ResolvedXJogMachineOptions } from './XJogMachineOptions';
import type { ResolvedXJogOptions } from './XJogOptions';

/**
 * @group XJog
 */
export type XJogChartCreationOptions<TContext = any> = {
  chartId?: string;
  parentRef?: ChartReference;
  initialContext?: TContext;
};

/**
 * @group XJog
 */
export type ResolvedXJogChartOptions = {
  chartMutexTimeout: number;
};

/**
 * @group XJog
 * @private
 */
export function resolveXJogChartOptions(
  instanceOptions: ResolvedXJogOptions,
  machineOptions: ResolvedXJogMachineOptions,
): ResolvedXJogChartOptions {
  const chartMutexTimeout = machineOptions.chartMutexTimeout;

  return {
    chartMutexTimeout,
  };
}
