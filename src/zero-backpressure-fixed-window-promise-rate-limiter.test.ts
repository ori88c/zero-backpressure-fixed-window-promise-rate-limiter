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

import { FixedWindowRateLimiter } from './zero-backpressure-fixed-window-promise-rate-limiter';
  
type PromiseResolveCallbackType = (value?: unknown) => void;
type PromiseRejectCallbackType = (reason?: Error) => void;

interface CustomTaskError extends Error {
    taskID: number;
}

/**
 * resolveFast
 * 
 * The one-and-only purpose of this function, is triggerring an event-loop iteration.
 * It is relevant whenever a test needs to simulate tasks from the Node.js' micro-tasks queue.
 */
const resolveFast = async () => { expect(14).toBeGreaterThan(3); };

const MOCK_WINDOW_DURATION_MS = 15 * 1000; // Can be long, as we use Jest's fake timers.
const MOCK_MAX_STARTS_PER_WINDOW = 81;

const createTestLimiter = () => new FixedWindowRateLimiter<void>(MOCK_WINDOW_DURATION_MS, MOCK_MAX_STARTS_PER_WINDOW);

describe('FixedWindowRateLimiter tests', () => {
    let setTimeoutSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.useFakeTimers();
        setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    });
  
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    const triggerEndingOfCurrentWindow = (): void => {
        // The 1st task of each window sets a new setTimeout timer. The timer's callback is executed
        // once the window ends, updating the rate-limiter's internal state.
        jest.runOnlyPendingTimers();
    };
  
    describe('Happy path tests', () => {
        test('validate initial state following instantiation', async () => {
            const rateLimiter = createTestLimiter();

            expect(rateLimiter.windowDurationMs).toBe(MOCK_WINDOW_DURATION_MS);
            expect(rateLimiter.maxStartsPerWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
            expect(rateLimiter.isCurrentWindowAvailable).toBe(true);
            expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(0);
            expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(0);
            expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
            expect(setTimeoutSpy).toHaveBeenCalledTimes(0);
        });

        test('when the window capacity is exhausted, the Rate Limiter should stop executing tasks utill a new window opens up', async () => {
            const rateLimiter = createTestLimiter();
            let windowsCounter = 1;

            const finishTaskCallbacks: PromiseResolveCallbackType[] = [];
            const createTask = () => new Promise<void>(res => finishTaskCallbacks.push(res));

            for (let ithTask = 1; ithTask <= MOCK_MAX_STARTS_PER_WINDOW; ++ithTask) {
                await rateLimiter.startExecution(createTask);

                expect(setTimeoutSpy).toHaveBeenCalledTimes(windowsCounter); // setTimeout is triggered by the 1st window task.
                expect(rateLimiter.windowDurationMs).toBe(MOCK_WINDOW_DURATION_MS);
                expect(rateLimiter.maxStartsPerWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
                expect(rateLimiter.isCurrentWindowAvailable).toBe(ithTask < MOCK_MAX_STARTS_PER_WINDOW);
                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(ithTask);
                expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(ithTask);
                expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
            }

            // Now, we push an excessive task which cannot be started during the current window.
            const outOfFirstWindowStartExecutionPromise = rateLimiter.startExecution(createTask);
            await Promise.race([outOfFirstWindowStartExecutionPromise, resolveFast()]);
            expect(rateLimiter.isCurrentWindowAvailable).toBe(false);
            expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(MOCK_MAX_STARTS_PER_WINDOW);
            expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
            expect(rateLimiter.amountOfUncaughtErrors).toBe(0);

            // Now, we resolve all the 1st window tasks. The excessive task still cannot be executed,
            // as the fixed time-window did not end.
            for (let ithTask = 1; ithTask <= MOCK_MAX_STARTS_PER_WINDOW; ++ithTask) {
                finishTaskCallbacks[0]();
                finishTaskCallbacks.shift();
                await Promise.race([outOfFirstWindowStartExecutionPromise, resolveFast()]);

                expect(setTimeoutSpy).toHaveBeenCalledTimes(windowsCounter);
                expect(rateLimiter.windowDurationMs).toBe(MOCK_WINDOW_DURATION_MS);
                expect(rateLimiter.maxStartsPerWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
                expect(rateLimiter.isCurrentWindowAvailable).toBe(false);
                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(MOCK_MAX_STARTS_PER_WINDOW - ithTask);
                expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
                expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
            }

            // Now, we simulate the ending of current window, allowing the pending task to begin.
            expect(finishTaskCallbacks.length).toBe(0);
            triggerEndingOfCurrentWindow();
            ++windowsCounter;
            await outOfFirstWindowStartExecutionPromise;
            expect(finishTaskCallbacks.length).toBe(1);
            expect(setTimeoutSpy).toHaveBeenCalledTimes(windowsCounter);
            expect(rateLimiter.windowDurationMs).toBe(MOCK_WINDOW_DURATION_MS);
            expect(rateLimiter.maxStartsPerWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
            expect(rateLimiter.isCurrentWindowAvailable).toBe(true);
            expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(1);
            expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(1);
            expect(rateLimiter.amountOfUncaughtErrors).toBe(0);

            // Finish the out-of-first-window task.
            finishTaskCallbacks.pop()();
            await rateLimiter.waitForAllExecutingTasksToComplete();
            expect(rateLimiter.isCurrentWindowAvailable).toBe(true);
            expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(0);
            expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(1);
        });

        test('waitForAllExecutingTasksToComplete should resolve only when all tasks are completed (either resolved or rejected)', async () => {
            const rateLimiter = createTestLimiter();
            // This test simulates 2 windows. All the 1st window tasks reject (throw an error),
            // while all the 2nd window tasks resolve successfully.
            const totalAmountOfTasks = 2 * MOCK_MAX_STARTS_PER_WINDOW;
            
            const taskResolveCallbacks: PromiseResolveCallbackType[] = [];
            const taskRejectCallbacks: PromiseRejectCallbackType[] = [];
            const createFirstWindowTask = () => new Promise<void>((_, rej) => {
                taskRejectCallbacks.push(rej)
            });
            const createSecondWindowTask = () => new Promise<void>(res => {
                taskResolveCallbacks.push(res)
            });

            // Adding the 1st window tasks.
            for (let ithTask = 1; ithTask <= MOCK_MAX_STARTS_PER_WINDOW; ++ithTask) {
                await rateLimiter.startExecution(createFirstWindowTask);
                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(ithTask);
                expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(ithTask);
                const isLastWindowTask = ithTask === MOCK_MAX_STARTS_PER_WINDOW;
                expect(rateLimiter.isCurrentWindowAvailable).toBe(!isLastWindowTask);
                expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
            }

            // Triggering the 2nd window.
            triggerEndingOfCurrentWindow();

            // Adding the 2nd window tasks.
            for (let ithTask = MOCK_MAX_STARTS_PER_WINDOW + 1; ithTask <= totalAmountOfTasks; ++ithTask) {
                await rateLimiter.startExecution(createSecondWindowTask);
                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(ithTask);
                expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(ithTask - MOCK_MAX_STARTS_PER_WINDOW);
                const isLastWindowTask = ithTask === totalAmountOfTasks;
                expect(rateLimiter.isCurrentWindowAvailable).toBe(!isLastWindowTask);
                expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
            }

            let allTasksCompleted = false;
            const waitForAllExecutingTasksToComplete: Promise<void> = (async () => {
                await rateLimiter.waitForAllExecutingTasksToComplete();
                allTasksCompleted = true;
            })();
            await Promise.race([waitForAllExecutingTasksToComplete, resolveFast()]);
            expect(allTasksCompleted).toBe(false);

            // Completing tasks one by one. The completion order do not matter.
            // For simplicity, first let's finish (reject) all the 1st window tasks.
            const thrownError = new Error("mock error message");
            let expectedAmountOfCurrentlyExecutingTasks = totalAmountOfTasks;
            for (let ithTask = 1; ithTask <= MOCK_MAX_STARTS_PER_WINDOW; ++ithTask) {
                const rejectCurrentTask: PromiseRejectCallbackType = taskRejectCallbacks.pop();
                rejectCurrentTask(thrownError);
                --expectedAmountOfCurrentlyExecutingTasks;
                await Promise.race([waitForAllExecutingTasksToComplete, resolveFast()]);
                expect(allTasksCompleted).toBe(false);
                expect(rateLimiter.amountOfUncaughtErrors).toBe(ithTask);
                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(expectedAmountOfCurrentlyExecutingTasks);
            }

            // Now, we resolve all the 2nd window tasks.
            for (let ithTask = 1; ithTask <= MOCK_MAX_STARTS_PER_WINDOW; ++ithTask) {
                const resolveCurrentTask: PromiseResolveCallbackType = taskResolveCallbacks.pop();
                resolveCurrentTask();
                --expectedAmountOfCurrentlyExecutingTasks;
                await Promise.race([waitForAllExecutingTasksToComplete, resolveFast()]);
                expect(allTasksCompleted).toBe(false);
                expect(rateLimiter.amountOfUncaughtErrors).toBe(MOCK_MAX_STARTS_PER_WINDOW);
                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(expectedAmountOfCurrentlyExecutingTasks);
            }

            // Finaly, we expect the `waitForAllExecutingTasksToComplete` promise to resolve.
            await waitForAllExecutingTasksToComplete;
            expect(allTasksCompleted).toBe(true);

            // Post processing validations.
            expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(0);
            expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW); // We are still in the 2nd window.
            const extractedErrors = rateLimiter.extractUncaughtErrors();
            const expectedErrors = new Array<Error>(MOCK_MAX_STARTS_PER_WINDOW).fill(thrownError);
            expect(extractedErrors).toEqual(expectedErrors);
        });

        test('startExecution: when backpressure is induced, each window should honor its capacity', async () => {
            const rateLimiter = createTestLimiter();
            const totalAmountOfWindows = 12;
            const amountOfLastWindowTasks = Math.floor(3 * MOCK_MAX_STARTS_PER_WINDOW / 4); // The last window won't utilize all its capacity.
            const totalAmountOfTasks =
                (totalAmountOfWindows - 1) * MOCK_MAX_STARTS_PER_WINDOW +
                amountOfLastWindowTasks;
            const startExecutionPromises: Promise<void>[] = [];
            const taskCompletionCallbacks: PromiseResolveCallbackType[] = [];
            // We create unresolved promises, simulating an async work in progress.
            // They will be resolved later, once we want to simulate completion of the async work.
            const createTask = () => new Promise<void>(res => taskCompletionCallbacks.push(res));

            // We push all tasks at once, inducing backpressure deliberately.
            // Note: this is not a mindful / wise use of the rate-limiter's capabilities, as the `startExecution`
            // method helps to avoid backpressure by promoting a just-in-time approach.
            // However, the rate-limiter guarantees validity under any settings, including under backpressure.
            for (let ithTask = 1; ithTask <= totalAmountOfTasks; ++ithTask) {
                const currStartExecutionPromise = rateLimiter.startExecution(createTask);
                startExecutionPromises.push(currStartExecutionPromise);
                await Promise.race(startExecutionPromises); // Trigger the event loop.

                expect(setTimeoutSpy).toHaveBeenCalledTimes(1); // setTimeout is triggered by the 1st window task.
                expect(rateLimiter.windowDurationMs).toBe(MOCK_WINDOW_DURATION_MS);
                expect(rateLimiter.maxStartsPerWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
                expect(rateLimiter.isCurrentWindowAvailable).toBe(ithTask < MOCK_MAX_STARTS_PER_WINDOW);
                
                // Only 1st window tasks will begin execution.
                const amountOfAlreadyAddedFirstWindowTasks = Math.min(ithTask, MOCK_MAX_STARTS_PER_WINDOW);
                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(amountOfAlreadyAddedFirstWindowTasks);
                expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(amountOfAlreadyAddedFirstWindowTasks);
                expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
            }

            let windowsCounter = 1;
            // Each main iteration begins when the current window (denoted by windowsCounter) is open, thus we
            // expect the rate-limiter to trigger (begin) all its tasks.
            // At the end of each main loop, we trigger the next window by advancing the system clock to the timestamp
            // when the current window ends, using fake timers.
            do {
                // The last window is not fully occupied, while all the others are.
                const isLastWindow = windowsCounter === totalAmountOfWindows;
                const expectedAmountOfCurrentlyExecutingTasks = isLastWindow ?
                    totalAmountOfTasks : (windowsCounter * MOCK_MAX_STARTS_PER_WINDOW);
                const amountOfCurrentWindowTasks = isLastWindow ? amountOfLastWindowTasks : MOCK_MAX_STARTS_PER_WINDOW;

                for (let ithCurrWindowTask = 1; ithCurrWindowTask <= amountOfCurrentWindowTasks; ++ithCurrWindowTask) {
                    await startExecutionPromises[0];
                    startExecutionPromises.shift();

                    expect(setTimeoutSpy).toHaveBeenCalledTimes(windowsCounter);
                    expect(rateLimiter.isCurrentWindowAvailable).toBe(isLastWindow);
                    expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(expectedAmountOfCurrentlyExecutingTasks);
                    expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(amountOfCurrentWindowTasks);
                }

                if (!isLastWindow) {
                    triggerEndingOfCurrentWindow();
                    // Trigger the event loop. All the next-window tasks will begin execution.
                    await Promise.race(startExecutionPromises);
                    ++windowsCounter;
                }
            } while (startExecutionPromises.length > 0);

            // Now, we finish tasks one by one. The order of completion does not matter for validating metrics.
            // We will use a FILO order, meaning a task that started later will be finished sooner.
            let amountOfRemainedExecutingTasks = totalAmountOfTasks;
            do {
                const completeCurrentTask: PromiseResolveCallbackType = taskCompletionCallbacks.pop();
                completeCurrentTask();
                await resolveFast(); // Trigger the event loop, to update the rate-limiter's internal state.
                --amountOfRemainedExecutingTasks;

                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(amountOfRemainedExecutingTasks);
                // We are still within the last window.
                expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(amountOfLastWindowTasks);
                expect(setTimeoutSpy).toHaveBeenCalledTimes(totalAmountOfWindows);
                expect(rateLimiter.isCurrentWindowAvailable).toBe(true); // Last window is not fully occupied.
            } while (amountOfRemainedExecutingTasks > 0);

            expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
        });

        test('waitForCompletion: when backpressure is induced, each window should honor its capacity', async () => {
            const rateLimiter = createTestLimiter();
            const totalAmountOfWindows = 7;
            const amountOfLastWindowTasks = Math.floor(7 * MOCK_MAX_STARTS_PER_WINDOW / 9); // The last window won't utilize all its capacity.
            const totalAmountOfTasks =
                (totalAmountOfWindows - 1) * MOCK_MAX_STARTS_PER_WINDOW +
                amountOfLastWindowTasks;

            const waitForCompletionPromises: Promise<void>[] = [];
            const taskCompletionCallbacks: PromiseResolveCallbackType[] = [];
            // We create unresolved promises, simulating an async work in progress.
            // They will be resolved later, once we want to simulate completion of the async work.
            const createTask = () => new Promise<void>(res => taskCompletionCallbacks.push(res));

            // We push all tasks at once, inducing backpressure deliberately.
            // Such a scenario can be unavoidable, for example if there's a spike in requests
            // to a specific route handler, which uses a rate-limiter to comply with a third-party
            // API that has throttling limits.
            for (let ithTask = 1; ithTask <= totalAmountOfTasks; ++ithTask) {
                const currWaitForCompletionPromise = rateLimiter.waitForCompletion(createTask);
                waitForCompletionPromises.push(currWaitForCompletionPromise);
                await resolveFast(); // Trigger the event loop.

                expect(setTimeoutSpy).toHaveBeenCalledTimes(1); // setTimeout is triggered by the 1st window task.
                expect(rateLimiter.windowDurationMs).toBe(MOCK_WINDOW_DURATION_MS);
                expect(rateLimiter.maxStartsPerWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
                expect(rateLimiter.isCurrentWindowAvailable).toBe(ithTask < MOCK_MAX_STARTS_PER_WINDOW);
                
                // Only 1st window tasks will begin execution.
                const amountOfAlreadyAddedFirstWindowTasks = Math.min(ithTask, MOCK_MAX_STARTS_PER_WINDOW);
                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(amountOfAlreadyAddedFirstWindowTasks);
                expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(amountOfAlreadyAddedFirstWindowTasks);
                expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
            }

            // Each main iteration begins when the current window (denoted by windowsCounter) is open, thus we
            // expect the rate-limiter to trigger (begin) all its tasks.
            // At the end of each main loop, we trigger the next window by advancing the system clock to the timestamp
            // when the current window ends, using fake timers.
            for (let currentWindowNo = 1; currentWindowNo <= totalAmountOfWindows; ++currentWindowNo) {
                // The last window is not fully occupied, while all the others are.
                const isLastWindow = currentWindowNo === totalAmountOfWindows;
                const expectedAmountOfCurrentlyExecutingTasks = isLastWindow ?
                    totalAmountOfTasks : (currentWindowNo * MOCK_MAX_STARTS_PER_WINDOW);
                const amountOfCurrentWindowTasks = isLastWindow ? amountOfLastWindowTasks : MOCK_MAX_STARTS_PER_WINDOW;

                expect(setTimeoutSpy).toHaveBeenCalledTimes(currentWindowNo);
                expect(rateLimiter.isCurrentWindowAvailable).toBe(isLastWindow);
                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(expectedAmountOfCurrentlyExecutingTasks);
                expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(amountOfCurrentWindowTasks);

                if (!isLastWindow) {
                    triggerEndingOfCurrentWindow();
                    await resolveFast(); // Trigger the event loop. All next-window tasks will begin execution.
                }
            }

            // Now, we finish tasks one by one. The order of completion does not matter for validating metrics.
            // In this test, tasks will be completed in a FIFO order.
            let amountOfRemainedExecutingTasks = totalAmountOfTasks;
            do {
                const completeOldestExecutingTask: PromiseResolveCallbackType = taskCompletionCallbacks[0];
                completeOldestExecutingTask();
                taskCompletionCallbacks.shift();

                await waitForCompletionPromises[0]; // This wait-for-completion promise corresponds the just-completed task.
                waitForCompletionPromises.shift();
                --amountOfRemainedExecutingTasks;

                expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(amountOfRemainedExecutingTasks);
                // We are still within the last window.
                expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(amountOfLastWindowTasks);
                expect(setTimeoutSpy).toHaveBeenCalledTimes(totalAmountOfWindows);
                expect(rateLimiter.isCurrentWindowAvailable).toBe(true); // Last window is not fully occupied.
            } while (amountOfRemainedExecutingTasks > 0);

            expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
        });
    });
  
    describe('Negative path tests', () => {
        test('should throw if window duration is less than 15ms or non-natural number', async () => {
            const invalidWindowDurations = [-16, -0.29, 0.0001, 10, 14.9999, 15.54, 16.8989, 9348.4433];
            for (const windowDurationMs of invalidWindowDurations) {
                expect(() => new FixedWindowRateLimiter(windowDurationMs, MOCK_MAX_STARTS_PER_WINDOW)).toThrow();
            }
        });

        test('should throw if max starts per window is a non-natural number', async () => {
            const invalidMaxStartsPerWindow = [-16, -0.29, 0.0001, 10.0000001, 14.9999, 15.54, 16.8989, 9348.4433];
            for (const maxStartsPerWindow of invalidMaxStartsPerWindow) {
                expect(() => new FixedWindowRateLimiter(MOCK_WINDOW_DURATION_MS, maxStartsPerWindow)).toThrow();
            }
        });

        test('should capture uncaught errors from background tasks triggered by startExecution', async () => {
            // In this test, we simulate a single window in which all tasks throw an error.
            const rateLimiter = createTestLimiter();
            const amountOfTasks = MOCK_MAX_STARTS_PER_WINDOW;
            const expectedTaskErrors: CustomTaskError[] = [];

            const createError = (taskID: number): CustomTaskError => ({
                name: "CustomTaskError",
                message: `Task no. ${taskID} has failed`,
                taskID
            });
    
            for (let ithTask = 1; ithTask <= amountOfTasks; ++ithTask) {
                expectedTaskErrors.push(createError(ithTask));
    
                // We deliberately create a new error instance with the exact same fields to validate deep equality.
                await rateLimiter.startExecution(async () => { throw createError(ithTask); });
            }
    
            await rateLimiter.waitForAllExecutingTasksToComplete();
            expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(0);
            expect(rateLimiter.amountOfUncaughtErrors).toBe(amountOfTasks);
            expect(rateLimiter.extractUncaughtErrors()).toEqual(expectedTaskErrors);
            // Following extraction, the rate-limiter no longer holds the error references.
            expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
          });
    });
});
