/**
 * Copyright 2024 Ori Cohen https://github.com/ori88c
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
export type RateLimiterTask<T> = () => Promise<T>;
/**
 * FixedWindowRateLimiter
 *
 * The `FixedWindowRateLimiter` class implements a rate limiter for Node.js projects, utilizing a fixed-window
 * policy. This policy restricts the number of tasks that can *begin* execution within a fixed time-window.
 * It is crucial to emphasize that the limitation applies to task *start times*, meaning that concurrency is
 * not inherently restricted by the rate limiter, as tasks from previous windows may still be running during
 * the current window. This is a key difference between rate limiters and semaphores, which should be considered
 * when deciding between the two.
 *
 * By definition, fixed windows do not overlap; each window is distinct.
 * When a task is pending execution, the rate limiter follows this competition procedure:
 * - If there is a currently open window:
 *   - If the window's capacity has not been exhausted, the task starts immediately.
 *   - If the window's capacity is full, the task waits for the next available window and re-enters the competition procedure.
 * - If there is no open window, a new window is created, and the task starts immediately.
 *
 * This implementation does not queue pending tasks, thereby eliminating backpressure. As a result, users have
 * better control over memory footprint, which enhances performance by reducing garbage-collector overhead.
 *
 * The design addresses the two primary rate limiting use cases in Node.js:
 * 1. **Single Task Execution**: A sub-procedure for which the caller must wait before proceeding with
 *    its work. In this case, the tasks's *completion* time is crucial to know.
 * 2. **Multiple Tasks Execution**: In this case, the *start* time of a given task is crucial. Since a
 *    pending task cannot start its execution until the rate-limiter allows, there is no reason to add
 *    additional tasks that cannot start either.
 *    Once all the tasks are completed, some post-processing logic may be required. The API provides a
 *    designated method to wait until there are no currently-executing tasks.
 *
 * ### Graceful Termination
 * All the task execution promises are tracked by the rate-limiter instance, ensuring no dangling promises.
 * This enables graceful termination via the `waitForAllExecutingTasksToComplete` method, which is
 * particularly useful for the multiple tasks execution use-case. This can help perform necessary
 * post-processing logic, and ensure a clear state between unit-tests.
 * If your component has a termination method (`stop`, `terminate`, or similar), keep that in mind.
 *
 * ### Error Handling for Background Tasks
 * Background tasks triggered by `startExecution` may throw errors. Unlike the `waitForCompletion` case,
 * the caller has no reference to the corresponding job promise which executes in the background.
 * Therefore, errors from background tasks are captured by the rate-limiter and can be extracted using
 * the `extractUncaughtErrors` method. The number of accumulated uncaught errors can be obtained via
 * the `amountOfUncaughtErrors` getter method. This can be useful, for example, if the user wants to
 * handle uncaught errors only after a certain threshold is reached.
 *
 * ### Complexity
 * - **Initialization**: O(maxStartsPerWindow) for both time and space.
 * - **startExecution, waitForCompletion**: O(1) for both time and space, excluding the task execution itself.
 * - **waitForAllExecutingTasksToComplete**: O(max concurrently executing tasks) for both time and space, excluding task executions.
 * - All the getter methods have O(1) complexity for both time and space.
 */
export declare class FixedWindowRateLimiter<T = void, UncaughtErrorType = Error> {
    private readonly _windowDurationMs;
    private readonly _maxStartsPerWindow;
    private readonly _availableSlotsStack;
    private readonly _taskExecutionSlots;
    private readonly _onWindowEndHandler;
    private _waitForWindowToEnd;
    private _currWindowStartsCounter;
    private _uncaughtErrors;
    /**
     * Constructor
     *
     * Initializes the instance by performing input validations and O(maxStartsPerWindow) pre-processing.
     * Both parameters must be natural numbers. The window duration has a minimum constraint of 15ms,
     * considering that Node.js time-handling utilities do not guarantee precise timing. Therefore,
     * it is advisable to avoid selecting windows that are too short.
     *
     * @param windowDurationMs - The fixed-window duration in milliseconds, must be at least 15ms.
     * @param maxStartsPerWindow - The maximum number of tasks allowed to start within a given fixed window.
     * @throws Will throw an error if validation fails.
     */
    constructor(windowDurationMs: number, maxStartsPerWindow: number);
    /**
     * maxStartsPerWindow
     *
     * @returns The maximum number of tasks allowed to start within a given fixed window.
     */
    get maxStartsPerWindow(): number;
    /**
     * windowDurationMs
     *
     * @returns The fixed-window duration in milliseconds.
     */
    get windowDurationMs(): number;
    /**
     * isCurrentWindowAvailable
     *
     * @returns True if the current window is not fully booked, i.e., fewer than maxStartsPerWindow
     *          tasks have begun execution within the current window.
     *          Otherwise, false.
     */
    get isCurrentWindowAvailable(): boolean;
    /**
     * amountOfCurrentlyExecutingTasks
     *
     * This getter returns the number of tasks currently being executed by this instance.
     *
     * Note that the number of concurrently executing tasks is *not* restricted by the rate limiter,
     * as this is not a semaphore. A rate limiter only limits the number of tasks *starting* execution
     * within a given window. However, a task may continue to run after its window ends and may even
     * persist across multiple windows.
     *
     * This metric can help assess whether the current replica (e.g., Pod) is overloaded, serving as
     * a valuable indicator for scaling out (horizontal scaling), alongside other conventional metrics
     * such as CPU and memory usage.
     * However, one should consider the overall system constraints before scaling out due to an overloaded
     * rate limiter. If there is a global rate-limiting constraint imposed by an external resource,
     * such as a third-party API, adding more replicas may result in requests being throttled by that external
     * resource.
     *
     * @returns The number of tasks currently being executed by this instance.
     */
    get amountOfCurrentlyExecutingTasks(): number;
    /**
     * amountOfUtilizedCurrentWindowTasks
     *
     * @returns The number of tasks that have started within the current window.
     */
    get amountOfTasksInitiatedDuringCurrentWindow(): number;
    /**
     * amountOfUncaughtErrors
     *
     * @returns The number of uncaught errors from background tasks, triggered by `startExecution`.
     */
    get amountOfUncaughtErrors(): number;
    /**
     * startExecution
     *
     * This method resolves once the given task has *started* its execution.
     * Users can leverage this to prevent backpressure of pending tasks:
     * If the rate-limiter is too busy to start a given task `X`, there is no reason to create another
     * task `Y` until `X` has started.
     *
     * This method is particularly useful for executing multiple or background tasks, where no return
     * value is expected. It promotes a just-in-time approach, on which each task is pending execution
     * only when no other task is, thereby eliminating backpressure and reducing memory footprint.
     *
     * ### Graceful Termination
     * Method `waitForAllExecutingTasksToComplete` complements the typical use-cases of `startExecution`.
     * It can be used to perform post-processing, after all the currently-executing tasks have completed.
     *
     * ### Error Handling
     * If the task throws an error, it is captured by the rate-limiter and can be accessed via the
     * `extractUncaughtError` method. Users are encouraged to specify a custom `UncaughtErrorType`
     * generic parameter to the class if tasks may throw errors.
     *
     * @param backgroundTask - The task to be executed when an available (not exhausted) window is found.
     * @returns A promise that resolves when the task starts execution.
     */
    startExecution(backgroundTask: RateLimiterTask<T>): Promise<void>;
    /**
     * waitForCompletion
     *
     * This method executes the given task in a controlled manner, once there is an available window.
     * It resolves or rejects when the task finishes execution, returning the task's value or propagating
     * any error it may throw.
     *
     * This method is useful when the flow depends on a task's execution to proceed, such as needing
     * its return value or handling any errors it may throw.
     *
     * ### Example Use Case
     * Suppose you have a route handler that needs to perform a third-party API request while honoring
     * its throttling limits of a maximum of 50 requests per second. The route handler's response depends
     * on the result of that third-party API request.
     * This method allows you to respect the third-party API throttling limits. Once the task resolves
     * or rejects, you can continue the route handler's flow based on the result.
     *
     * @param task - The task to be executed once there is an available window.
     * @throws - Error thrown by the task itself.
     * @returns A promise that resolves with the task's return value or rejects with its error.
     */
    waitForCompletion(task: RateLimiterTask<T>): Promise<T>;
    /**
     * waitForAllExecutingTasksToComplete
     *
     * This method allows the caller to wait until all *currently* executing tasks have finished,
     * meaning once all running promises have either resolved or rejected.
     *
     * This is particularly useful in scenarios where you need to ensure that all tasks are completed
     * before proceeding, such as during shutdown processes or between unit tests.
     *
     * Note that the returned promise only awaits tasks that were executed at the time this method
     * was called. Specifically, it awaits all tasks initiated by this instance — whether from the
     * current window or previous windows — that had not completed at the time of invocation.
     *
     * @returns A promise that resolves when all currently executing tasks are completed.
     */
    waitForAllExecutingTasksToComplete(): Promise<void>;
    /**
     * extractUncaughtErrors
     *
     * This method returns an array of uncaught errors, captured by the rate-limiter while executing
     * background tasks added by `startExecution`. The term `extract` implies that the rate-limiter
     * instance will no longer hold these error references once extracted, unlike `get`. In other
     * words, ownership of these uncaught errors shifts to the caller, while the rate-limiter clears
     * its list of uncaught errors.
     *
     * Even if the user does not intend to perform error-handling with these uncaught errors, it is
     * important to periodically call this method when using `startExecution` to prevent the
     * accumulation of errors in memory.
     * However, there are a few exceptional cases where the user can safely avoid extracting
     * uncaught errors:
     * - The number of tasks is relatively small and the process is short-lived.
     * - The tasks never throw errors, thus no uncaught errors are possible.
     *
     * @returns An array of uncaught errors from background tasks triggered by `startExecution`.
     */
    extractUncaughtErrors(): UncaughtErrorType[];
    /**
     * _allotExecutionSlot
     *
     * This method awaits for an available window, and allots an execution slot index
     * for a pending task. If all current slots are occupied, a new execution slot is created.
     *
     * ### Side Effects
     * If the allotted slot is the first in the current time window, a new `_waitForWindowToEnd`
     * promise is created. This promise informs awaiters when the window ends and reinitializes
     * the task counter for the window.
     *
     * @returns The execution slot index in which the task's promise will be stored.
     */
    private _allotExecutionSlot;
    /**
     * _handleTaskExecution
     *
     * This method manages the execution of a given task in a controlled manner. It ensures that
     * the task is executed within the constraints of the rate-limiter, and handles updating the
     * internal state once the task has completed.
     *
     * ### Behavior
     * - Waits for the task to either return a value or throw an error.
     * - Updates the internal state to make the allotted slot available again, once the task is finished.
     *
     * @param task - The task to be executed in the given slot.
     * @param allottedSlot - The slot index in which the task should be executed.
     * @param isBackgroundTask - A flag indicating whether the caller expects a return value to proceed
     *                           with its work. If `true`, no return value is expected, and any error
     *                           thrown by the task should *not* be propagated.
     * @returns A promise that resolves with the task's return value or rejects with its error.
     *          Rejection occurs only if triggered by `waitForCompletion`.
     */
    _handleTaskExecution(task: RateLimiterTask<T>, allottedSlot: number, isBackgroundTask: boolean): Promise<T>;
}
