import { randomUUID } from 'node:crypto';
import {
  ChartOwnershipLostError,
  type PersistedDeferredEvent,
  type PersistenceAdapter,
} from '@telia-oss/xjog-core-persistence';
import {
  type ActivityRef,
  ChartIdentifier,
  type ChartReference,
  getCorrelationIdentifier,
  type LogFields,
  XJogLogEmitter,
  type XJogStateChange,
} from '@telia-oss/xjog-util';
import { Mutex, type MutexInterface, withTimeout } from 'async-mutex';
import { concat, filter, from, map, type Observable, of } from 'rxjs';
import {
  type ActionFunction,
  type ActionObject,
  ActionTypes,
  type ActivityActionObject,
  type AnyEventObject,
  type BaseActionObject,
  type CancelAction,
  type DelayFunctionMap,
  type Event,
  type EventObject,
  Interpreter,
  type InvokeCallback,
  type InvokeDefinition,
  type LogActionObject,
  type Observer,
  type SCXML,
  type SendActionObject,
  type Spawnable,
  State,
  type StateMachine,
  type StateNode,
  type StateNodeConfig,
  type StateSchema,
  type Subscribable,
  type Subscription,
  type Typestate,
} from 'xstate';
import { doneInvoke, getActionFunction } from 'xstate/lib/actions';

import {
  isFunction,
  isMachine,
  isObservable,
  isPromiseLike,
  mapContext,
  toEventObject,
  toInvokeSource,
  toObserver,
  toSCXMLEvent,
} from 'xstate/lib/utils';
import {
  resolveXJogCreateStateChange,
  resolveXJogDeleteStateChange,
  resolveXJogUpdateStateChange,
  type XJogStateSnapshot,
} from './resolveXJogStateChange';

import type { XJog } from './XJog';

import {
  type ResolvedXJogChartOptions,
  resolveXJogChartOptions,
  type XJogChartCreationOptions,
} from './XJogChartCreationOptions';
import type { SpawnOptions, XJogMachine } from './XJogMachine';
import type { SimulatorAction } from './XJogSimulator';

export type XJogSendAction<
  TContext = any,
  TEvent extends EventObject = EventObject,
  TSentEvent extends EventObject = AnyEventObject,
> = Omit<SendActionObject<TContext, TEvent, TSentEvent>, 'to'> & {
  to?: string | number | ActivityRef | ChartReference;
};

/**
 * This class represents an interface to a single chart instance.
 * It will take care of sending events, state transitions etc.
 *
 * Longer-living matters are taken care of by {@link XJog}, which
 * can then, for example, limit the number of scheduled events
 * system-wide.
 *
 * Since state transitions need to take place in strict order,
 * any event sending must acquire a mutex lease. A single event
 * may cause other events to be sent as well. For that reason
 * the mutex acquisition has a configurable timeout. It will
 * typically fire, when there are infinite loops in the charts.
 * Tune the mutex timeout so that it allows for suitably lengthy,
 * normative event and transition chains.
 *
 * @group XJog
 */
export class XJogChart<
    TContext = any,
    TStateSchema extends StateSchema = any,
    TEvent extends EventObject = EventObject,
    TTypeState extends Typestate<TContext> = {
      value: any;
      context: TContext;
    },
    TEmitted = any,
  >
  extends XJogLogEmitter
  implements ChartReference
{
  public readonly component = 'chart';

  public readonly xJog: XJog;
  private readonly persistence: PersistenceAdapter;

  private stopping = false;

  public readonly chartMutex: MutexInterface;

  /**
   * @param xJogMachine
   * @param parentRef Optional parent chart or activity that spawned this chart.
   * @param id Unique identifier for the chart. Defaults to a UUID v4.
   * @param state
   * @param options
   */
  private constructor(
    private xJogMachine: XJogMachine<
      TContext,
      TStateSchema,
      TEvent,
      TTypeState
    >,
    public readonly id: string = randomUUID(),
    public readonly parentRef: ChartReference | null,
    private state: State<TContext, TEvent, TStateSchema, TTypeState>,
    private readonly options: ResolvedXJogChartOptions,
  ) {
    super();

    this.options = resolveXJogChartOptions(
      xJogMachine.xJog.options,
      xJogMachine.options,
    );

    this.xJog = xJogMachine.xJog;
    this.persistence = xJogMachine.persistence;

    // TODO make this configurable separately
    this.chartMutex = withTimeout(new Mutex(), this.options.chartMutexTimeout);

    this.trace({ message: 'Instance created', in: 'constructor' });
  }

  public getState(): State<TContext, TEvent, TStateSchema, TTypeState> {
    return this.state;
  }

  /**
   * Load a XJog chart from the database
   * @param xJogMachine
   * @param options
   */
  public static async create<
    TContext,
    TEvent extends EventObject,
    TStateSchema extends StateSchema<any>,
    TTypeState extends Typestate<any>,
    TEmitted,
  >(
    xJogMachine: XJogMachine<
      TContext,
      TStateSchema,
      TEvent,
      TTypeState,
      TEmitted
    >,
    options?: XJogChartCreationOptions<TContext>,
  ): Promise<XJogChart<TContext, TStateSchema, TEvent, TTypeState, TEmitted>> {
    return xJogMachine.xJog.timeExecution('chart.create', async () => {
      const instanceId = xJogMachine.xJog.id;

      const ref: ChartReference = {
        machineId: xJogMachine.id,
        chartId: options?.chartId ?? randomUUID(),
      };

      const parentRef: ChartReference | null = options?.parentRef ?? null;

      const context = Object.assign(
        {},
        xJogMachine.machine.initialState.context,
        options?.initialContext ?? {},
      );

      // TODO check if could do with static `inert` or something

      const stateMachine = xJogMachine.xJog.timeExecution(
        'chart.create.configure machine',
        () => xJogMachine.machine.withContext(context),
      );

      //- seems to be needed - TODO verify that is not needed: in the XState interpreted this
      // is only called if the state is initialized with some OTHER state
      // like we could when READING this from the database
      const state = xJogMachine.xJog.timeExecution(
        'chart.create.resolve state',
        () => stateMachine.resolveState(stateMachine.initialState),
      );

      const change = resolveXJogCreateStateChange(ref, parentRef, state);

      await xJogMachine.xJog.runUpdateHooks(
        change,
        'chart.create.call hook',
        (err) => xJogMachine.xJog.error({ err }, 'Failed to execute hook'),
      );

      await xJogMachine.xJog.timeExecution('chart.create.store', async () => {
        await xJogMachine.persistence?.createChart<
          TContext,
          TEvent,
          TStateSchema,
          TTypeState
        >(instanceId, ref, state, parentRef);
      });

      const chart = xJogMachine.xJog.timeExecution(
        'chart.create.instantiate',
        () =>
          new XJogChart<TContext, TStateSchema, TEvent, TTypeState, TEmitted>(
            xJogMachine,
            ref.chartId,
            options?.parentRef ?? null,
            state,
            resolveXJogChartOptions(
              xJogMachine.xJog.options,
              xJogMachine.options,
            ),
          ),
      );

      const releaseMutex = await chart.chartMutex.acquire();

      try {
        xJogMachine.xJog.changeSubject.next(change);

        await xJogMachine.xJog.timeExecution(
          'chart.create.execute actions',
          async () => await chart.executeActions(state, false, false),
        );

        return chart;
      } finally {
        releaseMutex();
      }
    });
  }

  public static async exists<
    TContext = any,
    TStateSchema extends StateSchema = any,
    TEvent extends EventObject = EventObject,
    TTypeState extends Typestate<TContext> = {
      value: any;
      context: TContext;
    },
  >(
    xJogMachine: XJogMachine<TContext, TStateSchema, TEvent, TTypeState>,
    chartId: string,
  ) {
    const ref = {
      machineId: xJogMachine.id,
      chartId,
    };
    return xJogMachine.persistence.isChartPresent(ref);
  }

  public static async load<
    TContext = any,
    TStateSchema extends StateSchema = any,
    TEvent extends EventObject = EventObject,
    TTypeState extends Typestate<TContext> = {
      value: any;
      context: TContext;
    },
    TEmitted = any,
  >(
    xJogMachine: XJogMachine<TContext, TStateSchema, TEvent, TTypeState>,
    chartId: string,
  ): Promise<XJogChart<
    TContext,
    TStateSchema,
    TEvent,
    TTypeState,
    TEmitted
  > | null> {
    return xJogMachine.xJog.timeExecution('chart.load', async () => {
      const ref = {
        machineId: xJogMachine.id,
        chartId,
      };

      const chart = await xJogMachine.persistence?.loadChart<
        TContext,
        TEvent,
        TStateSchema,
        TTypeState
      >(ref);

      if (!chart) {
        return null;
      }

      const { state, parentRef } = chart;
      const resolvedState = xJogMachine.machine.resolveState(state);

      return new XJogChart<
        TContext,
        TStateSchema,
        TEvent,
        TTypeState,
        TEmitted
      >(
        xJogMachine,
        chartId,
        parentRef,
        resolvedState,
        resolveXJogChartOptions(xJogMachine.xJog.options, xJogMachine.options),
      );
    });
  }

  private static async resolveMissingAfterActions<
    TContext,
    TStateSchema extends StateSchema,
    TEvent extends EventObject,
    TTypeState extends Typestate<TContext>,
  >(
    xJogMachine: XJogMachine<TContext, TStateSchema, TEvent, TTypeState>,
    chartId: string,
    state: State<TContext, TEvent, TStateSchema, TTypeState>,
  ): Promise<Array<SendActionObject<TContext, TEvent>>> {
    const afterActions = state.configuration.flatMap((stateNode) =>
      XJogChart.resolveAfterActionsForStateNode(
        stateNode,
        xJogMachine.machine.options.delays as
          | DelayFunctionMap<TContext, TEvent>
          | undefined,
        state.context,
      ),
    );

    // The existence checks are independent, so they can run concurrently
    const presenceChecks = await Promise.all(
      afterActions
        .filter((action) => action.id)
        .map(async (action) => {
          const isPresent =
            await xJogMachine.persistence.isDeferredEventPresent(
              { machineId: xJogMachine.id, chartId },
              action.id,
            );
          return { action, isPresent };
        }),
    );

    return presenceChecks
      .filter(({ isPresent }) => !isPresent)
      .map(({ action }) => action);
  }

  /**
   * Resolve a transition delay to a finite number of milliseconds.
   *
   * xstate stores the raw delay on the compiled transition: a number literal
   * stays a number, but a named delay (`after: { 'check interval': ... }`)
   * stays as the string key, and a function delay stays as a function. For
   * the repair path we need a real numeric delay to hand to
   * `deferredEventManager.defer`, so we look up named delays in
   * `machine.options.delays`. Function resolvers are invoked with the chart's
   * current context and a synthetic init event — the common shape is
   * `(ctx) => ctx.someConfigValue`, which doesn't care about the event.
   *
   * Returns `null` when the delay cannot be resolved to a finite number. The
   * caller filters these out rather than scheduling `setTimeout` with `NaN`
   * or an unresolvable string.
   */
  private static resolveTransitionDelay<TContext, TEvent extends EventObject>(
    delay: unknown,
    delays: DelayFunctionMap<TContext, TEvent> | undefined,
    context: TContext,
  ): number | null {
    const callDelayExpr = (fn: (...args: any[]) => any): number | null => {
      try {
        const resolved = fn(context, { type: ActionTypes.Init } as TEvent, {
          _event: toSCXMLEvent({ type: ActionTypes.Init } as TEvent),
        });
        return typeof resolved === 'number' && Number.isFinite(resolved)
          ? resolved
          : null;
      } catch {
        return null;
      }
    };

    if (typeof delay === 'number' && Number.isFinite(delay)) {
      return delay;
    }

    if (typeof delay === 'function') {
      return callDelayExpr(delay as (...args: any[]) => any);
    }

    if (typeof delay === 'string' && delays) {
      const entry = delays[delay];

      if (typeof entry === 'number' && Number.isFinite(entry)) {
        return entry;
      }

      if (typeof entry === 'function') {
        return callDelayExpr(entry as unknown as (...args: any[]) => any);
      }
    }

    return null;
  }

  private static resolveAfterActionsForStateNode<
    TContext,
    TEvent extends EventObject,
  >(
    stateNode: StateNode<TContext, any, TEvent>,
    delays: DelayFunctionMap<TContext, TEvent> | undefined,
    context: TContext,
  ): Array<SendActionObject<TContext, TEvent>> {
    return stateNode.after
      .map((transition) => ({
        transition,
        resolvedDelay: XJogChart.resolveTransitionDelay<TContext, TEvent>(
          transition.delay,
          delays,
          context,
        ),
      }))
      .filter(
        ({ transition, resolvedDelay }) =>
          typeof transition.eventType === 'string' &&
          transition.eventType.startsWith('xstate.after(') &&
          resolvedDelay !== null,
      )
      .map(
        ({ transition, resolvedDelay }) =>
          ({
            to: undefined,
            type: ActionTypes.Send,
            id: transition.eventType,
            delay: resolvedDelay as number,
            event: { type: transition.eventType },
            _event: toSCXMLEvent({ type: transition.eventType }),
          }) as SendActionObject<TContext, TEvent>,
      );
  }

  private async acquireMutex(
    cid = getCorrelationIdentifier(),
  ): Promise<() => Promise<void>> {
    const logPayload = {
      cid,
      in: 'acquireMutex',
      ref: this.ref,
    };

    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace(logPayload, ...args);

    try {
      const releaseMutex = await this.chartMutex.acquire();
      trace({ message: 'Mutex acquired' });

      return async () => {
        releaseMutex();
        trace({ message: 'Mutex released' });
      };
    } catch (error) {
      // A timed-out acquire means this one chart is wedged — an eternal loop,
      // or a stuck operation holding the lock. Fail only this operation. This
      // used to shut down the whole engine (at trace level), which turned a
      // per-chart problem into an instance-wide one: a dying engine defers
      // every subsequent send and returns null while the process stays up.
      this.error(logPayload, {
        message: 'Failed to acquire chart mutex within timeout',
        chartMutexTimeout: this.options.chartMutexTimeout,
        error,
      });

      throw new Error(
        `Failed to acquire mutex for chart ${this.href} ` +
          `within ${this.options.chartMutexTimeout} ms`,
      );
    }
  }

  /**
   * This should never be called directly. It's called when a new chart is
   * created or an old one is adopted.
   * @param cid Optional correlation identifier for debugging purposes
   */
  public async runStep(cid = getCorrelationIdentifier()) {
    return this.xJog.timeExecution('chart.run step', async () => {
      const trace = (...args: Array<string | Record<string, unknown>>) =>
        this.trace({ cid, in: 'runStep' }, ...args);

      // actions is safe by reference: xstate's machine.transition() always
      // allocates a new State with a new actions array, so the pre-transition
      // array is never mutated after this snapshot. mapState (the only consumer
      // of this snapshot) reads only value/context/actions.
      const stateBeforeTransition: XJogStateSnapshot<
        TContext,
        TStateSchema,
        TEvent,
        TTypeState
      > = {
        value: structuredClone(this.state.value),
        context: structuredClone(this.state.context),
        actions: this.state.actions,
      };

      const missingAfterActions = await XJogChart.resolveMissingAfterActions(
        this.xJogMachine,
        this.chartId,
        this.state,
      );

      if (missingAfterActions.length > 0) {
        trace({
          message: 'Reconstructing missing after-actions on rehydrate',
          count: missingAfterActions.length,
          actionIds: missingAfterActions.map((action) => action.id),
        });
      }

      const actionsToExecute = [
        ...missingAfterActions,
        ...(this.xJog.options.startup.skipRunningActionsOnRehydrate
          ? []
          : this.state.actions),
      ];

      const rehydratedState = Object.assign(
        Object.create(Object.getPrototypeOf(this.state)) as State<
          TContext,
          TEvent,
          TStateSchema,
          TTypeState
        >,
        this.state,
        { actions: actionsToExecute },
      );

      trace({ message: 'Executing actions' });
      await this.executeActions(rehydratedState, true, false, cid);

      trace({ message: 'Emitting next value' });

      const change = resolveXJogUpdateStateChange(
        this.ref,
        this.parentRef,
        stateBeforeTransition,
        this.state,
      );

      this.xJogMachine.xJog.changeSubject.next(change);

      trace({ message: 'Done' });
    });
  }

  public get machineId(): string {
    return this.xJogMachine.id;
  }

  public get chartId(): string {
    return this.id;
  }

  public get ref(): ChartReference {
    return {
      machineId: this.machineId,
      chartId: this.chartId,
    };
  }

  public get href(): string {
    return new ChartIdentifier(this.ref).uri.href;
  }

  public async destroy({
    cid = getCorrelationIdentifier(),
  } = {}): Promise<void> {
    await this.xJogMachine.evictCacheEntry(this.id);

    return this.xJog.timeExecution('chart.destroy', async () => {
      const trace = (...args: Array<string | Record<string, unknown>>) =>
        this.trace({ cid, in: 'destroy' }, ...args);

      trace({ message: 'Entering stopping state' });
      this.stopping = true;

      const change = resolveXJogDeleteStateChange(
        this.ref,
        this.parentRef,
        this.state,
      );

      const releaseMutex = await this.xJog.timeExecution(
        'chart.destroy.acquire mutex',
        async () => this.acquireMutex(),
      );

      try {
        await this.xJog.runUpdateHooks(
          change,
          'chart.destroy.call hook',
          (err) =>
            this.error({ cid, in: 'destroy' }, 'Failed to execute hook', {
              err,
            }),
        );

        trace({ message: 'Destroying persisted chart' });
        await this.persistence?.destroyChart(this.ref, cid);
      } finally {
        await releaseMutex();
      }

      this.xJog.changeSubject.next(change);
    });
  }

  // TODO Drop in favour of just reading the state
  /** @deprecated Use {@link getState} instead! */
  public async read(
    cid = getCorrelationIdentifier(),
    connection?: unknown,
  ): Promise<State<TContext, TEvent, any, any> | null> {
    this.trace({
      type: 'warning',
      cid,
      in: 'read',
      message: 'Read (deprecated!)',
    });

    return this.state;
  }

  /**
   * Dev only: if a simulation rule matches the given event, short-circuits
   * `send()` by skipping the event, simulating a failure, or delaying it.
   *
   * Returns a discriminated result: `{ intercepted: true, result }` means
   * `send()` must return `result` immediately; `{ intercepted: false }` means
   * `send()` should proceed as normal.
   */
  private async interceptWithSimulator(
    event: Event<TEvent> | SCXML.Event<TEvent>,
    scxmlEvent: SCXML.Event<TEvent>,
    warn: (...args: Array<string | Record<string, unknown>>) => void,
  ): Promise<{ intercepted: true; result: null } | { intercepted: false }> {
    if (!this.xJog.simulator.isEnabled()) {
      return { intercepted: false };
    }

    const eventName = scxmlEvent.name;
    const getMatchingRule = (action: SimulatorAction) => {
      const rule = this.xJog.simulator.matchesRule({
        event: eventName,
        action,
      });
      if (rule) {
        warn({
          message: `Matched simulation rule, will ${rule.action} event ${event}`,
          eventName,
          rule,
        });
        return rule;
      }
      return null;
    };

    if (getMatchingRule('skip')) {
      return { intercepted: true, result: null };
    }

    if (getMatchingRule('fail')) {
      throw new Error(`Simulated failure for event ${eventName}`);
    }

    const delayRule = getMatchingRule('delay');
    if (delayRule) {
      // Assume the value is in milliseconds and delay of the event
      const delay = parseInt(delayRule.value ?? '0');
      if (!Number.isNaN(delay)) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return { intercepted: false };
  }

  /**
   * @param event XState event to send.
   * @param context Fields to patch the context. Either an object or an updater callback function.
   *   can be called. The callback is called with the context read from the database, and it must
   *   return an object. Object is patched using `Object.assign`, function must return a full context.
   * @param sendId Id of the send action, has to be unique, see `SendActionObject`
   * @param cid Optional correlation identifier for debugging purposes
   */
  public async send(
    event: Event<TEvent> | SCXML.Event<TEvent>,
    context?: Partial<TContext> | ((context: TContext) => TContext),
    // TODO TBD if this really is required if not passed
    sendId: string | number = randomUUID(),
    cid = getCorrelationIdentifier(),
  ): Promise<State<TContext, TEvent, TStateSchema, TTypeState> | null> {
    const logPayload = { cid, in: 'send', sendId };

    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace(logPayload, ...args);

    const warn = (...args: Array<string | Record<string, unknown>>) =>
      this.warn(logPayload, ...args);

    const error = (...args: Array<string | Record<string, unknown>>) =>
      this.error(logPayload, ...args);

    return this.xJog.timeExecution('chart.send', async () => {
      const scxmlEvent = toSCXMLEvent(event);

      const simulatorInterception = await this.interceptWithSimulator(
        event,
        scxmlEvent,
        warn,
      );
      if (simulatorInterception.intercepted) {
        return simulatorInterception.result;
      }

      trace({ message: 'Sending event', eventName: scxmlEvent.name });

      if (this.stopping || this.xJog.dying) {
        trace({ message: 'Stopping or dying, so deferring this event' });
        await this.xJog.deferredEventManager.defer(
          {
            eventId: sendId,
            // TODO should we also pass actionId
            ref: this.ref,
            delay: 0,
            event: scxmlEvent,
          },
          cid,
        );

        return null;
      }

      const releaseMutex = await this.xJog.timeExecution(
        'chart.send.acquire mutex',
        async () => this.acquireMutex(cid),
      );

      trace({ message: 'Saving the current state' });
      // actions is safe by reference: xstate's machine.transition() always
      // allocates a new State with a new actions array, so the pre-transition
      // array is never mutated after this snapshot. mapState (the only consumer
      // of this snapshot) reads only value/context/actions.
      const stateBeforeTransition: XJogStateSnapshot<
        TContext,
        TStateSchema,
        TEvent,
        TTypeState
      > = {
        value: structuredClone(this.state.value),
        context: structuredClone(this.state.context),
        actions: this.state.actions,
      };

      try {
        if (context) {
          if (isFunction(context)) {
            trace({ message: 'Reducing context' });
            this.state.context = context(structuredClone(this.state.context));
          } else {
            trace({ message: 'Patching context' });
            this.state.context = Object.assign({}, this.state.context, context);
          }
        }

        this.state = this.xJog.timeExecution('chart.send.state after', () => {
          trace({ message: 'Resolving next state' });
          return this.xJogMachine.machine.transition(
            this.state,
            scxmlEvent,
            this.state.context,
          );
        });

        await this.xJogMachine.refreshCache(this);

        const change = resolveXJogUpdateStateChange(
          this.ref,
          this.parentRef,
          stateBeforeTransition,
          this.state,
        );

        await this.xJog.timeExecution('chart.send.update chart', async () => {
          trace({ message: 'Updating chart' });
          // Fenced write: applies only while this instance still owns the
          // chart, so a sibling that adopted it cannot be overwritten.
          await this.persistence.updateChart(
            this.ref,
            this.state,
            cid,
            undefined,
            this.xJog.id,
          );
        });

        await this.xJog.runUpdateHooks(change, 'chart.send.call hook', (err) =>
          error({ err }, 'Failed to execute hook'),
        );

        // Bug fix: changeSubject.next() can throw if a synchronous subscriber
        // errors. This must not prevent executeActions() from running, as that
        // would leave persisted state with actions that never execute (e.g.
        // deferred events from xstate.send delayed transitions).
        try {
          this.xJog.changeSubject.next(change);
        } catch (err) {
          error('Failed to emit change event', { err });
        }

        await this.xJog.timeExecution(
          'chart.send.execute actions',
          async () => {
            trace({ message: 'Executing actions' });
            await this.executeActions(this.state, false, true, cid);
          },
        );
      } catch (err) {
        if (ChartOwnershipLostError.is(err)) {
          // A sibling adopted this chart (deploy handoff or stale-instance
          // takeover). The in-memory copy is stale; evict it so the next
          // getChart reloads the owner's state from the database. Eviction
          // waits for this send's mutex to release, so it must not be
          // awaited here.
          //
          // Rethrown rather than swallowed to null: ownership loss is an
          // expected, self-correcting handoff condition, and callers need to
          // tell it apart from a genuine send failure (retry / redirect
          // instead of counting it against service health).
          error('Chart ownership lost, dropping the local copy', { err });
          this.xJogMachine
            .evictCacheEntry(this.id)
            .catch((evictError) =>
              error('Failed to evict chart from cache', { err: evictError }),
            );
          throw err;
        }

        error('Failed to send event, returning null', { err });
        return null;
      } finally {
        await releaseMutex();
      }

      await this.notifyOwnerIfDone(trace, error, cid);

      trace({ message: 'Done' });

      this.autoForwardToChildren(scxmlEvent);

      return this.state;
    });
  }

  /**
   * If the chart reached a final state and has an owning parent, resolve the
   * done data and notify the parent via a done-invoke event.
   *
   * Best-effort: the transition is already committed and the mutex released
   * by this point, so a throwing final-state `data` mapper (or
   * resolveDoneData failing to locate the final node) must not reject
   * send() — that would report a hard failure for a transition that actually
   * succeeded. Log and skip the parent notification instead.
   */
  private async notifyOwnerIfDone(
    trace: (...args: Array<string | Record<string, unknown>>) => void,
    error: (...args: Array<string | Record<string, unknown>>) => void,
    cid: string,
  ): Promise<void> {
    if (!this.state.done || !this.parentRef) {
      return;
    }

    try {
      trace({ message: 'Final state reached' });
      const doneData = await this.resolveDoneData(this.state, cid);

      trace({ message: 'Notifying the owner that chart is done' });

      // TODO should probably defer this event
      await this.xJog.sendEvent(
        this.parentRef,
        doneInvoke(this.id, doneData),
        undefined,
        undefined,
        cid,
      );
    } catch (err) {
      error('Failed to notify owner that chart is done', { err });
    }
  }

  /** Forwards the sent event to activities configured for auto-forwarding. */
  private autoForwardToChildren(scxmlEvent: SCXML.Event<TEvent>): void {
    this.xJog.timeExecution('chart.send.auto-forward', () => {
      this.xJog.activityManager.sendAutoForwardEvent(this.ref, scxmlEvent);
    });
  }

  private resolveDoneData(
    state: State<TContext, TEvent, TStateSchema, TTypeState>,
    cid = getCorrelationIdentifier(),
  ): Promise<any> {
    return this.xJog.timeExecution('chart.resolve done data', async () => {
      const trace = (...args: Array<string | Record<string, unknown>>) =>
        this.trace({ cid, in: 'resolveDoneData' }, ...args);

      const topLevelStates = Object.entries<
        StateNodeConfig<TContext, TStateSchema, TEvent>
      >(
        (this.xJogMachine.machine.config.states ?? {}) as {
          [key: string]: StateNodeConfig<TContext, TStateSchema, TEvent>;
        },
      );

      const [, finalStateNode] =
        topLevelStates
          .filter(([, stateNode]) => stateNode.type === 'final')
          .find(([stateName]) => state.matches(stateName)) ?? [];

      if (!finalStateNode) {
        throw new Error('Failed to find final state node');
      }

      trace({ message: 'Final state node resolved', node: finalStateNode });

      return finalStateNode.data
        ? mapContext(
            finalStateNode.data,
            state.context,
            toSCXMLEvent(state.event),
          )
        : undefined;
    });
  }

  /**
   * @private
   * @param state
   * @param rehydrating
   * @param nested
   * @param cid
   */
  public async executeActions(
    state: State<TContext, TEvent, TStateSchema, TTypeState>,
    rehydrating = false,
    nested = false,
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    return this.xJog.timeExecution('chart.execute actions', async () => {
      for (const action of state.actions) {
        // If rehydrating, we must not run the init actions again
        if (rehydrating && action.type === ActionTypes.Init) {
          continue;
        }

        try {
          await this.executeAction(
            state,
            action,
            nested,
            cid,
            // transactionConnectionForNesting,
          );
        } catch (error) {
          this.warn({
            message: 'Failed to execute action',
            error,
            action,
          });
          throw error;
        }
      }
    });
  }

  private async executeAction(
    state: State<TContext, TEvent, TStateSchema, TTypeState>,
    action: ActionObject<TContext, TEvent>,
    nested = false,
    cid = getCorrelationIdentifier(),
    // transactionConnectionForNesting?: unknown,
  ): Promise<void> {
    await this.xJog.timeExecution('chart.execute action', async () => {
      const machine = this.xJogMachine.machine;
      const { context, _event: scxmlEvent } = state;

      const logPayload = {
        cid,
        in: 'executeAction',
        actionType: action.type,
      };

      const trace = (...args: Array<string | Record<string, unknown>>) =>
        this.trace(logPayload, ...args);

      const warn = (...args: Array<string | Record<string, unknown>>) =>
        this.warn(logPayload, ...args);

      trace({ message: 'Executing action' });

      const actionOrExec =
        action.exec || getActionFunction(action.type, machine.options.actions);

      // The `isFunction` guard is a runtime check: action objects are plain
      // objects, so they fall through to the `.exec` lookup. The casts are
      // needed because xstate 4.38's ActionObject type declares a phantom
      // call signature (a TS inference aid that doesn't exist at runtime),
      // which makes the narrowing collapse the object branch to `never`.
      const exec = isFunction(actionOrExec)
        ? (actionOrExec as ActionFunction<TContext, TEvent>)
        : actionOrExec
          ? (actionOrExec as ActionObject<TContext, TEvent>).exec
          : action.exec;

      // If it's immediately executable, run it...
      if (exec) {
        return this.xJog.timeExecution('chart.execute action.immediate', () => {
          trace({ message: 'Immediately executable, running' });
          try {
            (exec as any)(context, scxmlEvent.data, {
              action,
              state,
              _event: scxmlEvent,
            });
          } catch (error) {
            warn({ message: 'Failed to execute', error });
          }
          trace({ message: 'Done' });
        });
      }

      switch (action.type) {
        case ActionTypes.Send: {
          await this.executeSendAction(action, cid, trace);
          break;
        }

        case ActionTypes.Cancel: {
          await this.executeCancelAction(action, cid, trace);
          break;
        }

        case ActionTypes.Start: {
          await this.executeStartAction(state, action, cid, trace, warn);
          break;
        }

        case ActionTypes.Stop: {
          await this.executeStopAction(action, cid, trace);
          break;
        }

        case ActionTypes.Log: {
          await this.executeLogAction(action);
          break;
        }

        default:
          warn({ message: 'Unknown action type' });
          break;
      }

      trace({ message: 'Done' });
    });
  }

  private async executeSendAction(
    action: ActionObject<TContext, TEvent>,
    cid: string,
    trace: (...args: Array<string | Record<string, unknown>>) => void,
  ): Promise<void> {
    await this.xJog.timeExecution('chart.execute action.send', async () => {
      const sendAction = action as unknown as SendActionObject<
        TContext,
        TEvent
      >;
      const delay = sendAction.delay ?? 0;

      const PersistedDeferredEvent: Omit<
        PersistedDeferredEvent,
        'id' | 'eventId' | 'timestamp' | 'due'
      > & {
        eventId: string | number;
      } = {
        ref: this.ref,
        event: sendAction._event,
        // TODO what should we send as eventId
        eventId: sendAction.id ?? randomUUID(),
        // TODO should we also send actionId and sendId?
        eventTo: (sendAction.to ?? null) as
          | string
          | number
          | ActivityRef
          | null,
        delay,
        lock: null,
      };

      trace({ message: 'Deferring event sending action' });
      await this.xJog.deferredEventManager.defer(PersistedDeferredEvent, cid);
    });
  }

  private async executeCancelAction(
    action: ActionObject<TContext, TEvent>,
    cid: string,
    trace: (...args: Array<string | Record<string, unknown>>) => void,
  ): Promise<void> {
    await this.xJog.timeExecution('chart.execute action.cancel', async () => {
      const sendId = (action as CancelAction<TContext, TEvent>).sendId;
      trace({ message: 'Canceling event', sendId });
      await this.xJog.deferredEventManager.cancel(sendId, cid, this.ref);
    });
  }

  private async executeStartAction(
    state: State<TContext, TEvent, TStateSchema, TTypeState>,
    action: ActionObject<TContext, TEvent>,
    cid: string,
    trace: (...args: Array<string | Record<string, unknown>>) => void,
    warn: (...args: Array<string | Record<string, unknown>>) => void,
  ): Promise<void> {
    await this.xJog.timeExecution('chart.execute action.start', async () => {
      const activity = (action as ActivityActionObject<TContext, TEvent>)
        .activity as InvokeDefinition<TContext, TEvent>;
      const activityId = activity.id;

      trace({ message: 'Starting activity', activityId });

      // If the activity will be stopped right after it's started
      // (such as in transient states) don't bother starting the activity.
      if (state.activities[activity.id || activity.type]) {
        // Invoked services
        if (activity.type === ActionTypes.Invoke) {
          trace({ message: 'Invoking service', activityId });
          // `id` is not part of the ActivityActionObject type, but
          // xstate attaches it at runtime; BaseActionObject keeps the
          // permissive index signature that ActionObject had in 4.26.
          await this.invokeService(
            (action as unknown as BaseActionObject).id,
            state,
            activity,
            cid,
          );
        }

        // Spawn
        else {
          // TODO

          warn({
            message: 'Tried to spawn, not supported yet',
            activityId,
          });

          throw new Error(
            'You need to use xjog-provided `spawn`, which is not yet available',
          );

          // this.spawnActivity(activity);
        }
      }
    });
  }

  private async executeStopAction(
    action: ActionObject<TContext, TEvent>,
    cid: string,
    trace: (...args: Array<string | Record<string, unknown>>) => void,
  ): Promise<void> {
    await this.xJog.timeExecution('chart.execute action.stop', async () => {
      const activity = (action as ActivityActionObject<TContext, TEvent>)
        .activity as InvokeDefinition<TContext, TEvent>;

      trace({ message: 'Stopping activity', id: activity.id });
      await this.xJog.activityManager.stopActivity(this.ref, activity.id, cid);
    });
  }

  private async executeLogAction(
    action: ActionObject<TContext, TEvent>,
  ): Promise<void> {
    await this.xJog.timeExecution('chart.execute action.log', () => {
      const { label, value } = action as LogActionObject<TContext, TEvent>;
      const message = isFunction(value) ? value() : value;
      this.info(message, { label });
    });
  }

  private async invokeService(
    actionId: string,
    state: State<TContext, TEvent, TStateSchema, TTypeState>,
    activity: InvokeDefinition<TContext, TEvent>,
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    const activityId = activity.id;

    const logPayload = { cid, in: 'invokeService', actionId, activityId };

    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace(logPayload, ...args);

    const warn = (...args: Array<string | Record<string, unknown>>) =>
      this.warn(logPayload, ...args);

    const error = (...args: Array<string | Record<string, unknown>>) =>
      this.error(logPayload, ...args);

    const alreadyOngoing = await this.xJog.activityManager.activityOngoing(
      this.ref,
      activityId,
    );

    if (alreadyOngoing) {
      trace({ message: 'Activity already ongoing, stopping first' });
      await this.xJog.activityManager.stopActivity(this.ref, activityId);
    }

    trace({ message: 'Resolving invoke source' });
    const invokeSource = toInvokeSource(activity.src);

    const serviceCreator =
      this.xJogMachine.machine.options.services?.[invokeSource.type];

    if (!serviceCreator) {
      warn({ message: 'Service creator not defined' });
      return;
    }

    trace({ message: 'Resolving service data' });
    const resolvedData = activity.data
      ? mapContext(activity.data, state.context, state._event)
      : undefined;

    if (typeof serviceCreator === 'string') {
      error({
        message: 'Service creator is a string',
        serviceCreator,
      });
      throw new Error(`Service creator "${serviceCreator}" is a string`);
    }

    let spawnable: Spawnable = isFunction(serviceCreator)
      ? (serviceCreator as any)(state.context, state._event.data, {
          data: resolvedData,
          src: invokeSource,
        })
      : serviceCreator;

    if (!spawnable) {
      warn({
        message: 'Service creator is function but did not return spawnable',
      });
      return;
    }

    const spawnOptions: SpawnOptions = {};

    if (isMachine(spawnable)) {
      trace({ message: 'Spawning a machine', spawnableId: spawnable.id });

      spawnable = resolvedData
        ? spawnable.withContext(resolvedData)
        : spawnable;
    }

    spawnOptions.autoForward =
      'autoForward' in activity ? activity.autoForward : !!activity.forward;

    trace({ message: 'Spawning' });
    const activityRef = await this.spawn(
      activityId,
      spawnable,
      spawnOptions,
      cid,
    );

    if (activityRef) {
      trace({ message: 'Registering as activity', id: activityRef.id });
      await this.xJog.activityManager.registerActivity(activityRef);
    }
  }

  /**
   * @returns `null`, if spawning failed
   * @private
   */
  private async spawn(
    id: string,
    spawnable: Spawnable,
    options: SpawnOptions,
    cid = getCorrelationIdentifier(),
  ): Promise<ActivityRef | null> {
    const logPayload = { cid, in: 'spawn', actionId: id };

    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace(logPayload, ...args);

    const error = (...args: Array<string | Record<string, unknown>>) =>
      this.error(logPayload, ...args);

    trace({ message: 'Spawning a spawnable' });

    if (isPromiseLike(spawnable)) {
      trace({ message: 'Spawning a promise' });
      return await this.spawnPromise(
        id,
        Promise.resolve(spawnable),
        options,
        cid,
      );
    }

    // Callback
    else if (isFunction(spawnable)) {
      trace({ message: 'Spawning a callback' });
      return await this.spawnCallback(
        id,
        spawnable as InvokeCallback,
        options,
        cid,
      );
    }

    // Observables
    else if (isObservable<TEvent>(spawnable)) {
      trace({ message: 'Spawning an observable' });
      return await this.spawnObservable(id, spawnable, options, cid);
    }

    // Is an unregistered throwaway machine
    else if (isMachine(spawnable)) {
      return await this.spawnUnregisteredMachine(id, spawnable, options);
    } else {
      error({
        message: 'Unknown spawnable type',
        spawnableType: typeof spawnable,
      });
      throw new Error(
        `Unable to spawn entity "${id}" of type "${typeof spawnable}".`,
      );
    }
  }

  private async spawnPromise<ResolveType>(
    id: string,
    promise: Promise<ResolveType>,
    options: SpawnOptions,
    cid = getCorrelationIdentifier(),
  ): Promise<ActivityRef> {
    const autoForward = options.autoForward ?? false;

    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace({ cid, in: 'spawnPromise', id }, ...args);

    let completed = false;
    let cancelled = false;

    // For unsubscribing
    const observers = new Set<Observer<EventObject>>();

    return {
      id,
      owner: this.ref,
      autoForward,
      toJSON: () => ({ id }),
      send: () => {
        // Promises cannot receive events, so swallow silently
      },
      stop: (): void => {
        cancelled = true;
      },
      subscribe: (
        onNext: Observer<EventObject> | ((value: EventObject) => void),
        onError?: (error: any) => void,
        onComplete?: () => void,
      ): Subscription => {
        const observer = toObserver(onNext, onError, onComplete);
        observers.add(observer);

        if (completed) {
          if (!cancelled) {
            observer.complete();
          }
        } else {
          promise
            .then((value: ResolveType) => {
              if (cancelled) {
                return;
              }

              observer.next(doneInvoke(id, value));

              completed = true;
              observer.complete();
            })
            .catch((error) => {
              if (cancelled) {
                return;
              }

              observer.error(error);
            });
        }

        return {
          unsubscribe() {
            observers.delete(observer);
          },
        };
      },
    };
  }

  /**
   * @returns `null`, if spawning failed
   * @private
   */
  private async spawnCallback(
    id: string,
    callback: InvokeCallback<AnyEventObject>,
    options: SpawnOptions,
    cid = getCorrelationIdentifier(),
  ): Promise<ActivityRef | null> {
    const autoForward = options.autoForward ?? false;

    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace({ cid, in: 'spawnCallback', id }, ...args);

    let canceled = false;

    // For unsubscribing
    const observers = new Set<Observer<Event<AnyEventObject>>>();

    trace({ message: 'Spawning a callback' });

    let initialError: any = null;
    let receiver: ((event: AnyEventObject) => void) | null = null;
    let listener: ((event: AnyEventObject) => void) | null = null;
    let callbackStop: (() => void) | null = null;

    try {
      // The invoked callback can return a function that
      // must be called when stopping this activity
      callbackStop = callback(
        // Passing a function that the callback can use to
        // send events to this chart (`send`)
        (event) => receiver?.(toEventObject(event)),
        // Pass a function that registers an event listener
        // to this chart's events (`onReceive`)
        (onReceiveListener) => {
          listener = onReceiveListener;
        },
      ) as () => void;
    } catch (error) {
      initialError = error;
    }

    if (isPromiseLike(callbackStop)) {
      // it turned out to be an async function, can't reliably check this before calling
      // `callback` because transpiled async functions are not recognizable. In this case
      // this was misrecognized as callback instead of a promise-like activity.
      trace({
        message: 'Callback turned out to be a promise-like activity',
      });
      return this.spawnPromise(
        id,
        callbackStop as unknown as Promise<any>,
        options,
        cid,
      );
    }

    return {
      id,
      owner: this.ref,
      autoForward,
      toJSON: () => ({ id }),

      // Send event to this activity
      send: (event) => {
        try {
          listener?.(toEventObject(event));
        } catch (error) {
          trace({
            type: 'warning',
            message:
              'Callback failed to receive an event. ' +
              'This indicates an error with the callback activity.',
            error,
          });
        }
      },

      // Receive updates and events from this activity
      subscribe: (
        onNext:
          | Observer<Event<EventObject> | SCXML.Event<EventObject>>
          | ((value: Event<EventObject> | SCXML.Event<EventObject>) => void),
        onError?: (error: any) => void,
        onComplete?: () => void,
      ): Subscription => {
        const observer = toObserver(onNext, onError, onComplete);
        observers.add(observer);

        if (initialError) {
          observer.error(initialError);
        }

        receiver = (event) => {
          observer.next(event);
        };

        return {
          unsubscribe: () => {
            this.stop();
            observers.delete(observer);
            receiver = null;
          },
        };
      },

      // Stop the activity
      stop: () => {
        canceled = true;
        if (isFunction(callbackStop)) {
          callbackStop();
        }
      },
    };
  }

  private async spawnObservable(
    id: string,
    source: Subscribable<Event<TEvent>>,
    options: SpawnOptions,
    cid = getCorrelationIdentifier(),
  ): Promise<ActivityRef> {
    const autoForward = options.autoForward ?? false;

    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace({ cid, in: 'spawnObservable', id }, ...args);

    trace({ message: 'Spawning an observable' });

    // For unsubscribing
    const observers = new Set<Observer<Event<TEvent>>>();

    let subscription: Subscription | null = null;

    return {
      id,
      owner: this.ref,
      autoForward,
      toJSON: () => ({ id }),
      send: () => {
        // Observables cannot receive events, so swallow silently
      },
      subscribe: (
        onNext: ((value: Event<TEvent>) => void) | Observer<Event<TEvent>>,
        onError?: (error: any) => void,
        onComplete?: () => void,
      ) => {
        const observer = toObserver(onNext, onError, onComplete);
        observers.add(observer);

        subscription = source.subscribe({
          next: observer.next,
          complete: () => {
            // Observable cannot complete with a value
            observer.next(doneInvoke(id));
            observer.complete();
          },
          error: observer.error,
        });

        return {
          unsubscribe: () => observers.delete(observer),
        };
      },
      stop: () => {
        subscription?.unsubscribe();
      },
    };
  }

  private async spawnUnregisteredMachine<
    TChildContext,
    TChildStateSchema extends StateSchema<any>,
    TChildEvent extends EventObject,
  >(
    id: string,
    machine: StateMachine<TChildContext, TChildStateSchema, TChildEvent>,
    options: SpawnOptions,
  ): Promise<ActivityRef> {
    // The trailing `any` (resolved typegen meta) keeps the declaration
    // assignable from `new Interpreter(machine)`, whose machine carries the
    // default ResolveTypegenMeta while a bare Interpreter<...> defaults to
    // TypegenDisabled.
    let childService: Interpreter<
      TChildContext,
      TChildStateSchema,
      TChildEvent,
      { value: any; context: TChildContext },
      any
    > | null = null;

    const resolvedOptions = {
      sync: false,
      autoForward: false,
      ...options,
    };

    return {
      id,
      toJSON: () => ({ id }),
      owner: this.ref,
      autoForward: resolvedOptions.autoForward,
      send: (event: Event<EventObject> | SCXML.Event<EventObject>) => {
        childService?.send(
          toSCXMLEvent(event as TChildEvent, { origin: childService.id }),
        );
      },
      subscribe: (
        onNext:
          | Observer<Event<EventObject>>
          | ((value: Event<EventObject> | SCXML.Event<EventObject>) => void),
        onError?: (error: any) => void,
        onComplete?: () => void,
      ): Subscription => {
        const observer = toObserver(onNext, onError, onComplete);

        childService = new Interpreter(machine, {
          id: id || machine.id,
        });

        if (resolvedOptions.sync) {
          childService.onTransition(
            (state: State<TChildContext, TChildEvent, TChildStateSchema>) => {
              observer.next(
                toSCXMLEvent({
                  type: ActionTypes.Update,
                  state,
                  id: childService?.id,
                }),
              );
            },
          );
        }

        childService.onDone((doneEvent) => {
          observer.next(
            toSCXMLEvent(doneEvent as any, { origin: childService?.id }),
          );
          observer.complete();
        });

        // Stream any events to the actor
        childService.onEvent((event: EventObject) => {
          observer.next(event);
        });

        childService.start();

        return {
          unsubscribe: () => {
            this.stop();
          },
        };
      },
      stop: () => {
        childService?.stop();
      },
    };
  }

  private async defer(
    action: XJogSendAction<TContext, TEvent>,
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    return this.xJog.timeExecution('chart.defer', async () => {
      const trace = (...args: Array<string | Record<string, unknown>>) =>
        this.trace({ cid, in: 'defer', actionId: action.id }, ...args);

      const delay = action.delay ?? 0;

      const PersistedDeferredEvent: Omit<
        PersistedDeferredEvent,
        'id' | 'timestamp' | 'due'
      > & {
        eventId?: string | number;
      } = {
        ref: this.ref,
        event: action._event,
        // TODO what should we pass as eventId?
        eventId: action.id,
        // TODO should we also pass actionId and sendId?
        eventTo: action.to ?? null,
        delay,
        lock: null,
      };

      trace({ message: 'Deferring event sending action' });
      await this.xJog.deferredEventManager.defer(PersistedDeferredEvent, cid);

      trace({ message: 'Done' });
    });
  }

  public async stop(cid = getCorrelationIdentifier()) {
    return this.xJog.timeExecution('chart.stop', async () => {
      const trace = (...args: Array<string | Record<string, unknown>>) =>
        this.trace({ cid, in: 'kill' }, ...args);

      trace({ message: 'Entering stopping state' });
      this.stopping = true;

      await this.xJog.deferredEventManager.cancelAllForChart(this.ref);
      await this.xJog.activityManager.stopAllForChart(this.ref);
    });
  }

  public async registerExternalId(
    key: string,
    value: string,
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    await this.xJogMachine.registerExternalId(this.id, key, value, cid);
  }

  public async dropExternalId(
    key: string,
    value: string,
    cid = getCorrelationIdentifier(),
  ): Promise<void> {
    await this.xJogMachine.dropExternalId(key, value, cid);
  }

  public get updates(): Observable<
    State<TContext, TEvent, TStateSchema, TTypeState>
  > {
    return concat(
      of(this.state),
      from(
        this.changes.pipe(
          filter((change) => !!change.new),
          map((change) => {
            if (!change.new) {
              throw new Error('Unexpected condition');
            }
            return State.from<TContext, TEvent>(
              change.new.value,
              change.new.context,
            );
          }),
        ),
      ),
    );
  }

  public get changes(): Observable<XJogStateChange> {
    return this.xJogMachine.changes.pipe(
      filter((change) => change.ref.chartId === this.ref.chartId),
    );
  }

  public async waitForState(
    expectedStateValue: TTypeState['value'] | TTypeState['value'][],
    timeoutMilliseconds = 0,
    cid = getCorrelationIdentifier(),
  ): Promise<State<TContext, TEvent, TStateSchema, TTypeState>> {
    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace({ cid, in: 'waitForState' }, ...args);

    trace({ message: 'Waiting for state', expectedStateValue });

    const stateMatches = (
      candidate: State<TContext, TEvent, TStateSchema, TTypeState>,
    ) =>
      Array.isArray(expectedStateValue)
        ? expectedStateValue.find((value) => candidate.matches(value))
        : candidate.matches(expectedStateValue);

    return new Promise((resolve, reject) => {
      if (stateMatches(this.state)) {
        trace({ message: 'State matches' });
        return resolve(this.state);
      }

      trace({ message: 'Waiting for the next state' });
      this.waitForNextState(expectedStateValue, timeoutMilliseconds, cid)
        .then(resolve)
        .catch(reject);
    });
  }

  public async waitForNextState(
    expectedStateValue: TTypeState['value'] | TTypeState['value'][],
    timeoutMilliseconds = 0,
    cid = getCorrelationIdentifier(),
  ): Promise<State<TContext, TEvent, TStateSchema, TTypeState>> {
    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace({ cid, in: 'waitForState' }, ...args);

    const stateMatches = (
      candidate: State<TContext, TEvent, TStateSchema, TTypeState>,
    ) =>
      Array.isArray(expectedStateValue)
        ? expectedStateValue.find((value) => candidate.matches(value))
        : candidate.matches(expectedStateValue);

    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | undefined;

      trace({ message: 'Subscribing to the chart' });
      const subscription = this.updates.subscribe({
        next: (state: State<TContext, TEvent, TStateSchema, TTypeState>) => {
          if (stateMatches(state)) {
            trace({ message: 'Updated state is a match, unsubscribing' });
            subscription.unsubscribe();

            if (timeoutHandle) {
              trace({ message: 'Clearing the timeout handle' });
              clearTimeout(timeoutHandle);
            }

            trace({ message: 'Resolving' });
            resolve(state);
          }
        },
        error: (error) => {
          if (timeoutHandle) {
            trace({ message: 'Clearing the timeout handle' });
            clearTimeout(timeoutHandle);
          }

          trace({ level: 'warning', message: 'Rejecting', error });
          reject(error);
        },
        complete: () => reject(new Error('Should not complete')),
      });

      if (timeoutMilliseconds > 0) {
        trace({ message: 'Installing a timeout', timeoutMilliseconds });

        timeoutHandle = setTimeout(() => {
          trace({ message: 'Timeout, unsubscribing' });
          subscription.unsubscribe();

          trace({ message: 'Rejecting' });
          reject(
            new Error(
              `Waiting for next state ${JSON.stringify(
                expectedStateValue,
              )} timed out after ${timeoutMilliseconds} ms`,
            ),
          );
        }, timeoutMilliseconds);
      }
    });
  }

  public async waitForFinalState(
    timeoutMilliseconds = 0,
    cid = getCorrelationIdentifier(),
  ): Promise<any> {
    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace({ cid, in: 'waitForFinalState' }, ...args);

    if (this.state.done) {
      trace({ message: 'Already done' });
      return this.resolveDoneData(this.state, cid);
    }

    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;

      const identifier = this.ref;
      const xJog = this.xJog;

      const subscription = this.updates.subscribe(
        (state: State<TContext, TEvent, TStateSchema, TTypeState>) => {
          if (state.done) {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
            const doneData = this.resolveDoneData(this.state, cid);
            resolve(doneData);
            subscription.unsubscribe();
          }
        },
      );

      if (timeoutMilliseconds > 0) {
        trace({ message: 'Installing a timeout', timeoutMilliseconds });

        timeoutHandle = setTimeout(() => {
          trace({ message: 'Timeout, rejecting' });
          reject(
            new Error(
              `Waiting for final state timed out after ${timeoutMilliseconds} ms`,
            ),
          );
        }, timeoutMilliseconds);
      }
    });
  }

  /** Pend until XJogChart mutex is released */
  public async wait(cid = getCorrelationIdentifier()): Promise<void> {
    const trace = (...args: Array<string | Record<string, unknown>>) =>
      this.trace({ cid, in: 'wait' }, ...args);

    const error = (...args: Array<string | Record<string, unknown>>) =>
      this.error({ cid, in: 'wait' }, ...args);

    try {
      trace({ message: 'Waiting for mutex release' });

      await this.chartMutex.waitForUnlock();
    } catch (err) {
      error({ message: 'Mutex failure', err });
      // Attached as `cause` manually; the es2015 lib target predates the
      // `Error` constructor's options bag.
      throw Object.assign(
        new Error(
          `Waiting for mutex unlock timed out in chart ` +
            `${this.xJogMachine.id}/${this.id} ` +
            `in wait method`,
        ),
        { cause: err },
      );
    }

    trace({ message: 'Mutex released' });
  }

  public log(...payloads: Array<string | Partial<LogFields>>) {
    return this.xJogMachine.log(
      {
        component: this.component,
        chartId: this.id,
      },
      ...payloads,
    );
  }
}
