import {
  type ChartReference,
  getCorrelationIdentifier,
} from '@samihult/xjog-util';
import type { XJog } from './XJog';
import type { ResolvedXJogOptions } from './XJogOptions';

/**
 * Class that will handle the startup sequence.
 * @group XJog
 */
export class XJogStartupManager {
  private readonly options: ResolvedXJogOptions['startup'];

  /**
   * Internal variable for the {@link #started} getter.
   */
  private isStarted = false;

  /**
   * Has been started. Machine registrations are accepted no more.
   */
  public get started(): boolean {
    return this.isStarted;
  }

  /**
   * Internal variable for the {@link #ready} getter.
   */
  private isReady = false;

  /**
   * In addition to the initial startup sequence, the async tail of the
   * startup has completed.
   */
  public get ready(): boolean {
    return this.isReady;
  }

  // private readinessListeners = new Set<() => void>();

  /** @private Timer for startup grace period */
  private startupGracePeriodTimer: NodeJS.Timeout | null = null;
  /** @private Timer for adoption loop */
  private adoptionLoopTimer: NodeJS.Timeout | null = null;

  public constructor(private readonly xJog: XJog) {
    this.options = xJog.options.startup;
  }

  private exitAdoptionGracePeriod() {
    if (this.startupGracePeriodTimer) {
      clearTimeout(this.startupGracePeriodTimer);
      this.startupGracePeriodTimer = null;
    }
  }

  private startAdoptionGracePeriod() {
    this.exitAdoptionGracePeriod();

    this.startupGracePeriodTimer = setTimeout(
      this.forciblyOverThrowStubbornInstances.bind(this),
      this.options.gracePeriod,
    );
  }

  /**
   * Start charts and activities. Start adoption process of
   * old instances' charts. Call this after registering all the machines.
   *
   * @param cid Optional correlation id for debugging purposes.
   */
  public async start(cid: string = getCorrelationIdentifier()): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.xJog.trace({ cid, in: 'startupManager.start', ...args });

    trace({ message: 'Overthrowing other instances' });
    await this.xJog.persistence.overthrowOtherInstances(this.xJog.id, cid);

    trace({ message: 'Entering the adoption grace period' });
    this.startAdoptionGracePeriod();

    trace({ message: 'Starting adoption process' });
    await this.adoptCharts();

    trace({ message: 'Startup completed' });
    this.isStarted = true;
  }

  public async stop(cid: string = getCorrelationIdentifier()): Promise<void> {
    const trace = (args: Record<string, any>) =>
      this.xJog.trace({ cid, in: 'startupManager.stop', ...args });

    trace({ message: 'Exiting the adoption grace period' });
    this.exitAdoptionGracePeriod();

    trace({ message: 'Stopping adoption process' });
    this.stopAdoptionLoop();

    trace({ message: 'Signal readiness' });
    this.signalReadiness();
  }

  private stopAdoptionLoop(): void {
    if (this.adoptionLoopTimer) {
      clearTimeout(this.adoptionLoopTimer);
    }
    this.adoptionLoopTimer = null;
  }

  /**
   * Adopt charts until there are no charts left to adopt. This is the gentle
   * option, and only paused charts that have zero activity counter will be
   * adopted. If this fails, {@link #forciblyOverThrowStubbornInstances} will
   * be called after the grace period.
   *
   * @private
   */
  private async adoptCharts(): Promise<void> {
    const cid = getCorrelationIdentifier();

    const trace = (args: Record<string, any>) =>
      this.xJog.trace({ cid, in: 'startupManager.adoptCharts', ...args });

    this.adoptionLoopTimer = null;

    trace({ message: 'Adopting charts' });
    const adoptedChartIdentifiers =
      await this.xJog.persistence.gentlyAdoptCharts(this.xJog.id, cid);

    const pausedChartCount =
      await this.xJog.persistence.getPausedChartCount(cid);

    if (adoptedChartIdentifiers.length) {
      trace({
        message: 'Starting adopted charts',
        count: adoptedChartIdentifiers.length,
        left: pausedChartCount,
      });

      await this.startAdoptedCharts(adoptedChartIdentifiers);
    } else {
      trace({
        message: 'Could not adopt any charts',
        count: adoptedChartIdentifiers.length,
        left: pausedChartCount,
      });
    }

    if (pausedChartCount > 0) {
      trace({ message: 'More charts to adopt', pausedChartCount });

      // Bug fix: only start the grace period if one isn't already running.
      // Previously this was called on every adoption cycle (~every 2s),
      // which cleared and reset the 30s timer each time, preventing
      // forciblyOverThrowStubbornInstances() from ever firing.
      if (!this.startupGracePeriodTimer) {
        this.startAdoptionGracePeriod();
      }

      this.adoptionLoopTimer = setTimeout(
        this.adoptCharts.bind(this),
        this.options.adoptionFrequency,
      );
    } else {
      trace({ message: 'No more charts to adopt' });
      this.exitAdoptionGracePeriod();

      trace({ message: 'Signal readiness' });
      this.signalReadiness();
    }

    trace({ message: 'Done' });
  }

  /**
   * Carried out when grace period timer fires and there are still lingering
   * charts, not ready for adoption. Grace period timer is cleared after every
   * chart is successfully adopted.
   *
   * @private
   */
  private async forciblyOverThrowStubbornInstances(): Promise<void> {
    const cid = getCorrelationIdentifier();

    const trace = (args: Record<string, any>) =>
      this.xJog.trace({
        cid,
        in: 'startupManager.forciblyOverThrowStubbornInstances',
        ...args,
      });

    this.startupGracePeriodTimer = null;

    trace({ message: 'Adopting all charts, ready or not' });
    const adoptedChartIdentifiers =
      await this.xJog.persistence.forciblyAdoptCharts(this.xJog.id, cid);

    trace({ message: 'Starting adopted charts' });
    await this.startAdoptedCharts(adoptedChartIdentifiers);

    trace({ message: 'Signal readiness' });
    this.signalReadiness();

    trace({ message: 'Done' });
  }

  /**
   * The startup routine needs to be run for a list of charts. This will
   * restart any ongoing activities etc. Intended as a post-adoption routine.
   *
   * @param refs List of chart identifiers
   * @param cid Optional correlation identifier for debugging purposes.
   *
   * @private
   */
  private async startAdoptedCharts(
    refs: ChartReference[],
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    // runStep internally honors skipRunningActionsOnRehydrate — when the flag
    // is set, it skips persisted state.actions but still executes reconstructed
    // missing xstate.after(...) send actions, so stuck polling timers self-heal
    // on adoption without replaying history.
    //
    // Per-chart failures (e.g. machine.resolveState() throwing because a
    // persisted state value refers to a state that no longer exists in the
    // machine definition) must not abort adoption for the remaining charts.
    // The bad chart stays paused in persistence and needs operator attention;
    // the rest of the system must come up.
    for (const ref of refs) {
      try {
        const adoptedChart = await this.xJog.getChart(ref, cid);
        await adoptedChart?.runStep(cid);
      } catch (error) {
        this.xJog.error({
          cid,
          in: 'startAdoptedCharts',
          ref,
          message: 'Failed to adopt chart; skipping so startup can continue',
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : error,
        });
      }
    }
  }

  private signalReadiness(): void {
    this.isReady = true;
    this.xJog.emit('ready');

    // for (const readinessListener of this.readinessListeners) {
    //   try {
    //     readinessListener();
    //     this.readinessListeners.delete(readinessListener);
    //   } catch (error) {
    //     this.xJog.trace({
    //       in: 'startupManger.signalReadiness',
    //       level: 'warning',
    //       message: 'Failed to call a readiness listener',
    //       error,
    //     });
    //   }
    // }
  }

  // public async waitUntilReady(): Promise<void> {
  //   if (this.ready) {
  //     return Promise.resolve();
  //   }
  //
  //   return new Promise((resolve) => {
  //     this.readinessListeners.add(resolve);
  //   });
  // }
}
