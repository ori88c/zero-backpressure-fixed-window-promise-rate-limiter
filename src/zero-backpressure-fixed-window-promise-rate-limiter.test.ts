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
const MOCK_MAX_STARTS_PER_WINDOW = 37;

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
        finishTaskCallbacks[ithTask - 1]();
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
      triggerEndingOfCurrentWindow();
      ++windowsCounter;
      await outOfFirstWindowStartExecutionPromise;
      expect(finishTaskCallbacks.length).toBe(MOCK_MAX_STARTS_PER_WINDOW + 1);
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

    test(
      'waitForAllExecutingTasksToComplete should resolve once all executing tasks have completed: ' +
      'setup with insufficient initial slots, triggering dynamic slot allocation. ' +
      'Tasks are resolved in FIFO order in this test', async () => {
      // This test deliberately creates backpressure by simulating a burst of tasks
      // that spans `amountOfWindows` time windows. As a result, each window (except the final one)
      // is unable to process all the pending tasks.
      const amountOfWindows = 12;
      const amountOfTasks = amountOfWindows * MOCK_MAX_STARTS_PER_WINDOW; // Each window is fully utilized.
      const rateLimiter = createTestLimiter();

      // From the Rate Limiter's perspective, a task is considered complete upon either
      // success or failure (i.e., when the Promise is resolved or rejected).
      // To simulate real-world scenarios, this test includes tasks that both succeed and fail.
      const taskCompletionCallbacks: (PromiseResolveCallbackType | PromiseRejectCallbackType)[] = [];
      const createResolvingTask = () => new Promise<void>(res => {
        taskCompletionCallbacks.push(res);
        // This promise will remain unsettled until we manually invoke the 'res' callback,
        // simulating an ongoing task that is about to complete successfully.
      });            
      const createRejectingTask = () => new Promise<void>((_, rej) => {
        taskCompletionCallbacks.push(rej);
        // This promise will remain unsettled until we manually invoke the 'rej' callback,
        // simulating an ongoing task that is about to fail.
      });

      const waitForCompletionPromises: Promise<void>[] = [];
      for (let ithTask = 1; ithTask <= amountOfTasks; ++ithTask) {
        const shouldTaskSucceed = ithTask % 2 === 0; // Odd-numbered tasks fail, while even-numbered tasks succeed.
        waitForCompletionPromises.push(
          // Tasks will *start* execution in the order in which they were registered.
          rateLimiter.waitForCompletion(shouldTaskSucceed ? createResolvingTask : createRejectingTask)
        );
          
        // Trigger the event loop.
        // This may activate the rate limiter's dynamic slot allocation for this task,
        // if the window's capacity hasn't been fully utilized yet.
        // Most tasks should receive a new slot, as the rate limiter initially allocates
        // slightly more slots than the window's capacity. However, in this test, there are
        // `amountOfWindows` windows, which is significantly higher.
        await Promise.race([
          waitForCompletionPromises[waitForCompletionPromises.length - 1],
          resolveFast()
        ]);
      }

      // Trigger the end of all windows, while none of the tasks have settled yet.
      // We expect the Rate Limiter to retain references to all still-executing tasks,
      // including those from earlier windows that have already ended.
      for (let ithWindow = 1; ithWindow <= amountOfWindows; ++ithWindow) {
        expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
        expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(
          ithWindow * MOCK_MAX_STARTS_PER_WINDOW // Reminder: tasks from previous windows are still executing.
        );
        expect(rateLimiter.isCurrentWindowAvailable).toBe(false);

        // End the current window and trigger the event loop, allowing the next batch
        // of the highest-priority tasks (first in Node.js's microtasks queue) to start
        // execution.
        triggerEndingOfCurrentWindow();
        await Promise.race([waitForCompletionPromises[0], resolveFast()]);
      }

      let allTasksCompleted = false;
      const waitForAllExecutingTasksToComplete: Promise<void> = (async () => {
        await rateLimiter.waitForAllExecutingTasksToComplete();
        allTasksCompleted = true;
      })();
      await Promise.race([waitForAllExecutingTasksToComplete, resolveFast()]);
      expect(allTasksCompleted).toBe(false);

      // Complete all tasks one by one, in FIFO order.
      let expectedAmountOfCurrentlyExecutingTasks = amountOfTasks;
      for (let ithTask = 1; ithTask <= amountOfTasks; ++ithTask) {
        let thrownError: Error;
        const shouldTaskSucceed = ithTask % 2 === 0;
        if (shouldTaskSucceed) {
          taskCompletionCallbacks[ithTask -1](); // Invoking the task's Promise-resolve callback.
        } else {
          thrownError = new Error(`mock error message: ${ithTask}`);
          taskCompletionCallbacks[ithTask - 1](thrownError); // Invoking the task's Promise-reject callback.
        }

        --expectedAmountOfCurrentlyExecutingTasks;

        // Trigger the event loop, we expect the current task promise to be settled.
        if (shouldTaskSucceed) {
          await waitForCompletionPromises[ithTask - 1];
        } else {
          // The current task rejects.
          try {
            await waitForCompletionPromises[ithTask - 1];
            expect(true).toBe(false); // The flow should not reach this point.
          } catch (err) {
            expect(err.message).toEqual(thrownError.message);
          }
        }

        // Trigger the event loop.
        if (ithTask === amountOfTasks) {
          await waitForAllExecutingTasksToComplete; // We have just completed the last task.
        } else {
          await Promise.race([waitForAllExecutingTasksToComplete, resolveFast()]);
        }

        expect(allTasksCompleted).toBe(ithTask === amountOfTasks);
        expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(expectedAmountOfCurrentlyExecutingTasks);

        // Currently we are in the (amountOfWindows +1)th window. We don't add any
        // tasks to it, so its metrics are expected to remain unchanged.
        expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(0);
        expect(rateLimiter.isCurrentWindowAvailable).toBe(true);
        expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
      }

      expect(allTasksCompleted).toBe(true);
    });

    test(
      'waitForAllExecutingTasksToComplete should resolve once all executing tasks have completed: ' +
      'setup with insufficient initial slots, triggering dynamic slot allocation. ' +
      'Tasks are resolved in FILO order in this test', async () => {
      // FILO order for task completion times is unlikely in real life, but it’s a good edge case to test.
      // It ensures the rate limiter can maintain a reference to an old task, even if its execution time exceeds
      // all others.

      // This test deliberately creates backpressure by simulating a burst of tasks
      // that spans `amountOfWindows` time windows. As a result, each window (except the final one)
      // is unable to process all the pending tasks.
      const amountOfWindows = 10;
      const amountOfTasks = amountOfWindows * MOCK_MAX_STARTS_PER_WINDOW; // Each window is fully utilized.
      const rateLimiter = createTestLimiter();

      // From the Rate Limiter's perspective, a task is considered complete upon either
      // success or failure (i.e., when the Promise is resolved or rejected).
      // To simulate real-world scenarios, this test includes tasks that both succeed and fail.
      const taskCompletionCallbacks: (PromiseResolveCallbackType | PromiseRejectCallbackType)[] = [];
      const createResolvingTask = () => new Promise<void>(res => {
        taskCompletionCallbacks.push(res);
        // This promise will remain unsettled until we manually invoke the 'res' callback,
        // simulating an ongoing task that is about to complete successfully.
      });            
      const createRejectingTask = () => new Promise<void>((_, rej) => {
        taskCompletionCallbacks.push(rej);
        // This promise will remain unsettled until we manually invoke the 'rej' callback,
        // simulating an ongoing task that is about to fail.
      });

      const waitForCompletionPromises: Promise<void>[] = [];
      for (let ithTask = 1; ithTask <= amountOfTasks; ++ithTask) {
        const shouldTaskSucceed = ithTask % 2 === 0; // Odd-numbered tasks fail, while even-numbered tasks succeed.
        waitForCompletionPromises.push(
          // Tasks will *start* execution in the order in which they were registered.
          rateLimiter.waitForCompletion(shouldTaskSucceed ? createResolvingTask : createRejectingTask)
        );
          
        // Trigger the event loop.
        // This may activate the rate limiter's dynamic slot allocation for this task,
        // if the window's capacity hasn't been fully utilized yet.
        // Most tasks should receive a new slot, as the rate limiter initially allocates
        // slightly more slots than the window's capacity. However, in this test, there are
        // `amountOfWindows` windows, which is significantly higher.
        await Promise.race([
          waitForCompletionPromises[waitForCompletionPromises.length - 1],
          resolveFast()
        ]);
      }

      // Trigger the end of all windows, while none of the tasks have settled yet.
      // We expect the Rate Limiter to retain references to all still-executing tasks,
      // including those from earlier windows that have already ended.
      for (let ithWindow = 1; ithWindow <= amountOfWindows; ++ithWindow) {
        expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(MOCK_MAX_STARTS_PER_WINDOW);
        expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(
          ithWindow * MOCK_MAX_STARTS_PER_WINDOW // Reminder: tasks from previous windows are still executing.
        );
        expect(rateLimiter.isCurrentWindowAvailable).toBe(false);

        // End the current window and trigger the event loop, allowing the next batch
        // of the highest-priority tasks (first in Node.js's microtasks queue) to start
        // execution.
        triggerEndingOfCurrentWindow();
        await Promise.race([waitForCompletionPromises[0], resolveFast()]);
      }

      let allTasksCompleted = false;
      const waitForAllExecutingTasksToComplete: Promise<void> = (async () => {
        await rateLimiter.waitForAllExecutingTasksToComplete();
        allTasksCompleted = true;
      })();
      await Promise.race([waitForAllExecutingTasksToComplete, resolveFast()]);
      expect(allTasksCompleted).toBe(false);

      // Complete all tasks one by one, in FILO order.
      let expectedAmountOfCurrentlyExecutingTasks = amountOfTasks;
      for (let ithTask = amountOfTasks; ithTask >= 1; --ithTask) {
        let thrownError: Error;
        const shouldTaskSucceed = ithTask % 2 === 0;
        if (shouldTaskSucceed) {
          taskCompletionCallbacks.pop()(); // Invoking the task's Promise-resolve callback.
        } else {
          thrownError = new Error(`mock error message: ${ithTask}`);
          taskCompletionCallbacks.pop()(thrownError); // Invoking the task's Promise-reject callback.
        }

        --expectedAmountOfCurrentlyExecutingTasks;

        // Trigger the event loop, we expect the current task promise to be settled.
        if (shouldTaskSucceed) {
          await waitForCompletionPromises.pop();
        } else {
          // The current task rejects.
          try {
            await waitForCompletionPromises.pop();
            expect(true).toBe(false); // The flow should not reach this point.
          } catch (err) {
            expect(err.message).toEqual(thrownError.message);
          }
        }

        // Trigger the event loop.
        if (ithTask === 1) {
          await waitForAllExecutingTasksToComplete; // We have just completed the last task, the oldest one.
        } else {
          await Promise.race([waitForAllExecutingTasksToComplete, resolveFast()]);
        }

        expect(allTasksCompleted).toBe(ithTask === 1);
        expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(expectedAmountOfCurrentlyExecutingTasks);

        // Currently we are in the (amountOfWindows +1)th window. We don't add any
        // tasks to it, so its metrics are expected to remain unchanged.
        expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(0);
        expect(rateLimiter.isCurrentWindowAvailable).toBe(true);
        expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
      }

      expect(allTasksCompleted).toBe(true);
    });

    test('startExecution: when backpressure is induced, each window should honor its capacity', async () => {
      const rateLimiter = createTestLimiter();
      const totalAmountOfWindows = 9;
      const amountOfLastWindowTasks = Math.floor(3 * MOCK_MAX_STARTS_PER_WINDOW / 4); // The last window won't utilize all its capacity.
      const totalAmountOfTasks =
        (totalAmountOfWindows - 1) * MOCK_MAX_STARTS_PER_WINDOW +
        amountOfLastWindowTasks;
      const startExecutionPromises = new Array<Promise<void>>(totalAmountOfTasks).fill(undefined);
      const taskCompletionCallbacks = new Array<PromiseResolveCallbackType>(totalAmountOfTasks).fill(undefined);

      // We push all tasks at once, inducing backpressure deliberately.
      // Note: this is not a mindful / wise use of the rate-limiter's capabilities, as the `startExecution`
      // method helps to avoid backpressure by promoting a just-in-time approach.
      // However, the rate-limiter guarantees validity under any settings, including under backpressure.
      for (let ithTask = 1; ithTask <= totalAmountOfTasks; ++ithTask) {
        // We create unresolved promises, simulating an async work in progress.
        // They will be resolved later, once we want to simulate completion of the async work.
        const taskIndex = ithTask - 1;
        const createTask = () => new Promise<void>(res => taskCompletionCallbacks[taskIndex] = res);
        startExecutionPromises[taskIndex] = rateLimiter.startExecution(createTask);
        
        // Trigger the event loop.
        await Promise.race([
          startExecutionPromises[taskIndex],
          resolveFast()
        ]);

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
      for (let ithWindow = 1; ithWindow <= totalAmountOfWindows; ++ithWindow) {
        // The last window is not fully occupied, while all the others are.
        const isLastWindow = ithWindow === totalAmountOfWindows;
        const expectedAmountOfCurrentlyExecutingTasks = isLastWindow ?
          totalAmountOfTasks : (ithWindow * MOCK_MAX_STARTS_PER_WINDOW);
        const amountOfCurrentWindowTasks = isLastWindow ? amountOfLastWindowTasks : MOCK_MAX_STARTS_PER_WINDOW;

        let currTaskIndex = (ithWindow - 1) * MOCK_MAX_STARTS_PER_WINDOW;
        for (let ithCurrWindowTask = 1; ithCurrWindowTask <= amountOfCurrentWindowTasks; ++ithCurrWindowTask, ++currTaskIndex) {
          await startExecutionPromises[currTaskIndex];

          expect(setTimeoutSpy).toHaveBeenCalledTimes(ithWindow);
          expect(rateLimiter.isCurrentWindowAvailable).toBe(isLastWindow);
          expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(expectedAmountOfCurrentlyExecutingTasks);
          expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(amountOfCurrentWindowTasks);
        }

        if (!isLastWindow) {
          triggerEndingOfCurrentWindow();
          // Trigger the event loop. All the next-window tasks will begin execution.
          const nextWindowLastTaskIndex = Math.min(
            totalAmountOfTasks - 1,
            (ithWindow + 1) * MOCK_MAX_STARTS_PER_WINDOW - 1
          );
          await startExecutionPromises[nextWindowLastTaskIndex];
        }
      }

      // Now, we finish tasks one by one. The order of completion does not matter for validating metrics.
      // We will use a FILO order, meaning a task that started later will be finished sooner.
      let expectedAmountOfCurrentlyExecutingTasks = totalAmountOfTasks;
      do {
        const completeCurrentTask: PromiseResolveCallbackType = taskCompletionCallbacks.pop();
        completeCurrentTask();

        // Trigger the event loop, to update the rate-limiter's internal state.
        await resolveFast();
        --expectedAmountOfCurrentlyExecutingTasks;

        expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(expectedAmountOfCurrentlyExecutingTasks);
        // We are still within the last window.
        expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(amountOfLastWindowTasks);
        expect(setTimeoutSpy).toHaveBeenCalledTimes(totalAmountOfWindows);
        expect(rateLimiter.isCurrentWindowAvailable).toBe(true); // Last window is not fully occupied.
      } while (expectedAmountOfCurrentlyExecutingTasks > 0);

      expect(rateLimiter.amountOfUncaughtErrors).toBe(0);
    });

    test('waitForCompletion: when backpressure is induced, each window should honor its capacity', async () => {
      const rateLimiter = createTestLimiter();
      const totalAmountOfWindows = 7;
      const amountOfLastWindowTasks = Math.floor(7 * MOCK_MAX_STARTS_PER_WINDOW / 9); // The last window won't utilize all its capacity.
      const totalAmountOfTasks =
        (totalAmountOfWindows - 1) * MOCK_MAX_STARTS_PER_WINDOW +
        amountOfLastWindowTasks;

      const waitForCompletionPromises = new Array<Promise<void>>(totalAmountOfTasks).fill(undefined);
      const taskCompletionCallbacks = new Array<PromiseResolveCallbackType>(totalAmountOfTasks).fill(undefined);

      // We push all tasks at once, inducing backpressure deliberately.
      // Such a scenario can be unavoidable, for example if there's a spike in requests
      // to a specific route handler, which uses a rate-limiter to comply with a third-party
      // API that has throttling limits.
      for (let ithTask = 1; ithTask <= totalAmountOfTasks; ++ithTask) {
        // We create unresolved promises, simulating an async work in progress.
        // They will be resolved later, once we want to simulate completion of the async work.
        const taskIndex = ithTask - 1;
        const createTask = () => new Promise<void>(
          res => taskCompletionCallbacks[taskIndex] = res
        );
        waitForCompletionPromises[taskIndex] = rateLimiter.waitForCompletion(createTask);;
        
        // Trigger the event loop.
        await Promise.race([
          waitForCompletionPromises[taskIndex],
          resolveFast()
        ]);

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

          // Trigger the event loop. All next-window tasks will begin execution.
          await Promise.race([
            waitForCompletionPromises,
            resolveFast()
          ]);
        }
      }

      // Now, we finish tasks one by one. The order of completion does not matter for validating metrics.
      // In this test, tasks will be completed in a FIFO order.
      let expectedAmountOfCurrentlyExecutingTasks = totalAmountOfTasks;
      for (let ithTask = 1; ithTask <= totalAmountOfTasks; ++ithTask) {
        const completeOldestExecutingTask: PromiseResolveCallbackType = taskCompletionCallbacks[ithTask - 1];
        completeOldestExecutingTask();

        await waitForCompletionPromises[ithTask - 1]; // This wait-for-completion promise corresponds the just-completed task.
        --expectedAmountOfCurrentlyExecutingTasks;

        expect(rateLimiter.amountOfCurrentlyExecutingTasks).toBe(expectedAmountOfCurrentlyExecutingTasks);
        // We are still within the last window.
        expect(rateLimiter.amountOfTasksInitiatedDuringCurrentWindow).toBe(amountOfLastWindowTasks);
        expect(setTimeoutSpy).toHaveBeenCalledTimes(totalAmountOfWindows);
        expect(rateLimiter.isCurrentWindowAvailable).toBe(true); // Last window is not fully occupied.
      }

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
