<h2 align="middle">Zero-Backpressure Fixed-Window Promise Rate Limiter</h2>

The `FixedWindowRateLimiter` class implements a rate limiter for Node.js projects, utilizing a fixed-window policy. This policy restricts the number of tasks that can **begin** execution within a fixed time-window.

It is crucial to emphasize that the limitation applies to task *start times*, meaning that concurrency is not inherently restricted by the rate limiter, as tasks from previous windows may still be running during the current window. This is a key difference between rate limiters and semaphores, which should be considered when deciding between the two.  
Typically, a rate limiter is employed to manage the throttling limits of a third-party API that your app interacts with.

This implementation does not queue pending tasks. Conversly, it promote a **just-in-time** approach, thereby eliminating backpressure. As a result, users have better control over memory footprint, which enhances performance by reducing garbage-collector overhead.

To illustrate the benefits of backpressure prevention, consider a scenario where messages from a message broker, such as RabbitMQ or Kafka, are translated into tasks. For example, in a stock-exchange broker system, each message might contain a username, and each task processes all the pending buy/sell requests for that user. If consumers using a rate-limiter pull messages too quickly, messages may accumulate for extended periods, potentially triggering the broker's TTL (Time to Live).

The design addresses the two primary rate-limiting use cases in Node.js:
* __Multiple Tasks Execution__: This use case involves a single caller dispatching multiple tasks, often serving as the sole owner of the rate-limiter instance.
* __Single Task Execution__: In scenarios where multiple callers, such as route handlers, concurrently access the same rate-limiter instance. Each caller initiates a single task and relies on its outcome to proceed (not a background task).

Each use case necessitates distinct handling capabilities, which will be discussed separately with accompanying examples.

## Table of Contents

* [Fixed-Window Policy](#fixed-window-policy)
* [Key Features](#key-features)
* [API](#api)
* [Getter Methods](#getter-methods)
* [Even Distribution of Tasks: Shorter Window Duration](#even-distribution)
* [1st use-case: Multiple Tasks Execution](#first-use-case)
* [2nd use-case: Single Task Execution](#second-use-case)
* [Graceful Termination](#graceful-termination)
* [Error Handling for Background Tasks](#error-handling)
* [Unavoidable / Implicit Backpressure](#unavoidable-backpressure)
* [Naming Convention](#naming-convention)
* [License](#license)

## Fixed-Window Policy<a id="fixed-window-policy"></a>

By definition, fixed windows **do not overlap**; each window is distinct.

When a task is pending execution, the rate limiter follows this competition procedure:
* If there is a currently open window:
    * If the window's capacity has not been exhausted, the task starts immediately.
    * If the window's capacity is full, the task waits for the next available window and re-enters the competition procedure.
* If there is no open window, a new window is created, and the task starts immediately.

This implementation processes pending tasks in a First-In-First-Out (FIFO) order, prioritizing earlier tasks over newer ones. This approach is common and effectively eliminates the possibility of starvation.

## Key Features :sparkles:<a id="key-features"></a>

- __Fixed Window Policy__: Windows are distinct and **do not overlap**. This approach has a low performance overhead, and can ensure an even distribution of tasks if a relatively short window duration is chosen.
- __Backpressure Control__: Ideal for job workers and background services. Concurrency control alone isn't sufficient to ensure stability and performance if backpressure control is overlooked. For example, when message queues are involved, overlooking backpressure control can lead to messages accumulating over a long period, potentially reaching their TTL.
- __Graceful Termination__: Await the completion of all currently executing tasks via the `waitForAllExecutingTasksToComplete` method.
- __High Efficiency :gear:__: All state-altering operations have a constant time complexity, O(1).
- __Comprehensive documentation :books:__: The class is thoroughly documented, enabling IDEs to provide helpful tooltips that enhance the coding experience.
- __Metrics :bar_chart:__: The class offers various metrics through getter methods, providing insights into the rate limiter's current state.
- __Robust Error Handling__: Uncaught errors from background tasks triggered by `startExecution` are captured and can be accessed using the `extractUncaughtErrors` method.
- __Tests :test_tube:__: **Fully covered** by rigorous unit tests.
- Self-explanatory method names.
- No external runtime dependencies: Only development dependencies are used.
- ES2020 Compatibility: The `tsconfig` target is set to ES2020, ensuring compatibility with ES2020 environments.
- TypeScript support.

## API :globe_with_meridians:<a id="api"></a>

The `FixedWindowRateLimiter` class provides the following methods:

* __startExecution__: Resolves once the given task has **started** its execution. Users can leverage this to prevent backpressure of pending tasks; If the rate-limiter is too busy to start a given task `X`, there is no reason to create another task `Y` until `X` has started. This method is particularly useful for background job workers that frequently retrieve job metadata from external sources, such as pulling messages from a message broker.
* __waitForCompletion__: Executes the given task in a controlled manner, once there is an available window. It resolves or rejects when the task **completes** execution, returning the task's value or propagating any error it may throw.
* __waitForAllExecutingTasksToComplete__: Resolves when all **currently** executing tasks have finished, meaning once all running promises have either resolved or rejected. This is particularly useful in scenarios where you need to ensure that all tasks are completed before proceeding, such as during shutdown processes or between unit tests.
* __extractUncaughtErrors__: Returns an array of uncaught errors, captured by the rate-limiter while executing background tasks added by `startExecution`. The instance will no longer hold these error references once extracted. In other words, ownership of these uncaught errors shifts to the caller, while the rate-limiter clears its list of uncaught errors.

If needed, refer to the code documentation for a more comprehensive description of each method.

## Getter Methods :mag:<a id="getter-methods"></a>

The `FixedWindowRateLimiter` class provides the following getter methods to reflect the current state:

* __maxStartsPerWindow__: The maximum number of tasks allowed to start within a given fixed window. This value is set in the constructor and remains constant throughout the instance's lifespan.
* __windowDurationMs__: The fixed-window duration in milliseconds. This value is set in the constructor and remains constant throughout the instance's lifespan.
* __isCurrentWindowAvailable__: Indicates whether the current window is not fully booked, i.e., fewer than `maxStartsPerWindow` tasks have begun execution within the current window.
* __amountOfCurrentlyExecutingTasks__: The number of tasks currently being executed by this instance. Note that the number of concurrently executing tasks is **not** restricted by the rate limiter, as this is not a semaphore. A rate limiter only limits the number of tasks **starting** execution within a given window. However, a task may continue to run after its window ends and may even persist across multiple windows.
* __amountOfTasksInitiatedDuringCurrentWindow__: The number of tasks that have started within the current window.
* __amountOfUncaughtErrors__: The number of uncaught errors from background tasks, triggered by `startExecution`.

To eliminate any ambiguity, all getter methods have **O(1)** time and space complexity, meaning they do **not** iterate through all currently executing tasks with each call. The metrics are maintained by the tasks themselves.

## Even Distribution of Tasks: Shorter Window Duration<a id="even-distribution"></a>

There is a common misconception, arguing that the Sliding Window policy guarantees a more even distribution of tasks compared to Fixed Window. This is not necessarily correct. For instance, consider a window duration of 1000ms and a specific window `[T, T + 1000)`. If we allow at most 200 tasks per window, and all 200 tasks begin within the first 5ms of the window `[T, T + 5]`, both Sliding and Fixed Window policies will prevent any additional tasks from starting for the remaining 995ms.

However, there is an edge case where a Fixed Window may fall short, while a Sliding Window does not: If all tasks begin **near the end** of the ith window and **near the start** of the (i+1)th window. In this scenario, **twice** the window's capacity could be reached within a very short time frame.

On the other hand, implementing a Sliding Window policy incurs a greater performance overhead. To prevent request bursts in either approach, one can select shorter windows. For example, instead of a 1000ms window allowing 200 tasks, you might choose a 100ms window with 20 tasks, or a 50ms window with 10 tasks, etc.

Thus, even when complying with third-party API throttling constraints, it is advisable to maintain the same duration-to-task **ratio** while opting for a relatively short duration.

Note that the minimum allowed window duration of the `FixedWindowRateLimiter` class is 15ms, considering that Node.js time-handling utilities do not guarantee precise timing.

## 1st use-case: Multiple Tasks Execution :man_technologist:<a id="first-use-case"></a>

This rate-limiter variant excels in eliminating backpressure when dispatching multiple concurrent tasks from the same caller. This pattern is typically observed in **background job services**, such as:
- Log File analysis.
- Network Traffic analyzers.
- Vulnerability scanning.
- Malware Signature updates.
- Sensor Data aggregation.
- Remote Configuration changes.
- Batch Data processing.

Here, the **start time** of each task is crucial. Since a pending task cannot start its execution until the rate-limiter allows, there is no benefit to adding additional tasks that cannot start immediately. The `startExecution` method communicates the task's start time to the caller (resolves as soon as the task starts), which enables to create a new task **as-soon-as it makes sense**.

For example, consider an application managing 1M IoT sensors that require hourly data aggregation. Each sensor's data is aggregated through a third-party API with a throttling limit of 50 requests per second.  
Rather than pre-creating 1M tasks (one for each sensor), which could potentially overwhelm the Node.js task queue and induce backpressure, the system should adopt a **just-in-time** approach. This means creating a sensor aggregation task only when the rate-limiter indicates availability, thereby optimizing resource utilization and maintaining system stability.

Note: method `waitForAllExecutingTasksToComplete` can be used to perform post-processing, after all tasks have completed. It complements the typical use-cases of `startExecution`.

```ts
import { FixedWindowRateLimiter } from 'zero-backpressure-fixed-window-promise-rate-limiter';

const windowDurationMs = 1000;
const maxStartsPerWindow = 50;
const sensorAggregationLimiter = new FixedWindowRateLimiter<void>(
  windowDurationMs,
  maxStartsPerWindow
);

async function aggregateSensorsData(sensorUIDs: ReadonlyArray<string>): Promise<void> {
  for (const uid of sensorUIDs) {
    // Until the rate-limiter can start aggregating data from the current sensor,
    // adding more tasks won't make sense as such will induce unnecessary
    // backpressure.
    await sensorAggregationLimiter.startExecution(
      (): Promise<void> => handleDataAggregation(uid)
    );
  }
  // Note: at this stage, tasks might be still executing, as we did not wait for
  // their completion.

  // Graceful termination: await the completion of all currently executing tasks.
  await sensorAggregationLimiter.waitForAllExecutingTasksToComplete();
  console.info(`Finished aggregating data from ${sensorUIDs.length} IoT sensors`);
}

/**
 * Handles the data aggregation process for a specified IoT sensor.
 *
 * @param sensorUID - The unique identifier of the IoT sensor whose data is to
 *                    be aggregated.
 */
async function handleDataAggregation(sensorUID): Promise<void> {
  // Implementation goes here. 
  // Triggers an API call to a third-party service with a
  // throttling limit of 50 requests per second.
}
```

If the tasks might throw errors, you don't need to worry about these errors propagating up to the event loop and potentially crashing the application. Uncaught errors from tasks triggered by `startExecution` are captured by the rate-limiter and can be safely accessed for post-processing purposes (e.g., metrics).  
Refer to the following adaptation of the above example, now utilizing the error handling capabilities:

```ts
import { FixedWindowRateLimiter } from 'zero-backpressure-fixed-window-promise-rate-limiter';

const windowDurationMs = 1000;
const maxStartsPerWindow = 50;
const sensorAggregationLimiter =
  // Notice the 2nd generic parameter (Error by default).
  new FixedWindowRateLimiter<void, SensorAggregationError>(
    windowDurationMs,
    maxStartsPerWindow
  );

async function aggregateSensorsData(sensorUIDs: ReadonlyArray<string>): Promise<void> {
  for (const uid of sensorUIDs) {
    await sensorAggregationLimiter.startExecution(
      (): Promise<void> => handleDataAggregation(uid)
    );
  }

  // Graceful termination: await the completion of all currently executing tasks.
  await sensorAggregationLimiter.waitForAllExecutingTasksToComplete();

  // Post processing.
  const errors = sensorAggregationLimiter.extractUncaughtErrors();
  if (errors.length > 0) {
    await updateFailedAggregationMetrics(errors);
  }

  // Summary.
  const successfulTasksCount = sensorUIDs.length - errors.length;
  logger.info(
    `Successfully aggregated data from ${successfulJobsCount} IoT sensors, ` +
    `with failures in aggregating data from ${errors.length} IoT sensors`
  );
}
```

Please note that in a real-world scenario, sensor UIDs may be consumed from a message queue (e.g., RabbitMQ, Kafka, AWS SNS) rather than from an in-memory array. This setup **highlights the benefits** of avoiding backpressure:  
Working with message queues typically involves acknowledgements, which have **timeout** mechanisms. Therefore, immediate processing is crucial to ensure efficient and reliable handling of messages. Backpressure on the rate-limiter means that messages experience longer delays before their corresponding tasks start execution.  
Refer to the following adaptation of the previous example, where sensor UIDs are consumed from a message queue. This example overlooks error handling and message validation, for simplicity.

```ts
import {
  FixedWindowRateLimiter,
  RateLimiterTask
} from 'zero-backpressure-fixed-window-promise-rate-limiter';

const windowDurationMs = 1000;
const maxStartsPerWindow = 50;
const sensorAggregationLimiter =
  new FixedWindowRateLimiter<void, SensorAggregationError>(
    windowDurationMs,
    maxStartsPerWindow
  );

const SENSOR_UIDS_TOPIC = "IOT_SENSOR_UIDS";
const mqClient = new MessageQueueClient(SENSOR_UIDS_TOPIC);

async function processConsumedMessages(): Promise<void> {
  let processedMessagesCounter = 0;
  let isEmptyQueue = false;

  const processOneMessage: RateLimiterTask<void> = async (): Promise<void> => {
    if (isEmptyQueue) {
      return;
    }

    const message = await mqClient.receiveOneMessage();
    if (!message) {
      // Consider the queue as empty.
      isEmptyQueue = true;
      return;
    }

    ++processedMessagesCounter;
    const { uid } = message.data;
    await handleDataAggregation(uid);
    await mqClient.removeMessageFromQueue(message); // Acknowledge.
  };

  do {
    await sensorAggregationLimiter.startExecution(processOneMessage);
  } while (!isEmptyQueue);
  // Note: at this stage, jobs might be still executing, as we did not wait for
  // their completion.

  // Graceful termination: await the completion of all currently executing jobs.
  await sensorAggregationLimiter.waitForAllExecutingTasksToComplete();

  // Post processing.
  const errors = sensorAggregationLimiter.extractUncaughtErrors();
  if (errors.length > 0) {
    await updateFailedAggregationMetrics(errors);
  }

  // Summary.
  const successfulTasksCount = processedMessagesCounter - errors.length;
  logger.info(
    `Successfully aggregated data from ${successfulTasksCount} IoT sensors, ` +
    `with failures in aggregating data from ${errors.length} IoT sensors`
  );
}
```

## 2nd use-case: Single Task Execution :man_technologist:<a id="second-use-case"></a>

The `waitForCompletion` method is useful for executing a sub-procedure, for which the caller **must wait before proceeding** with its work.

For example, consider fetching data from an external resource with a throttling limit of 100 requests per second within a route handler. The route handler must respond (e.g., with an HTTP status 200 on success) based on the result of the fetching sub-procedure. Note that a sub-procedure may return a value or throw an error. If an error is thrown, `waitForCompletion` will propagate the error back to the caller.

```ts
import {
  FixedWindowRateLimiter,
  RateLimiterTask
} from 'zero-backpressure-fixed-window-promise-rate-limiter';

type UserInfo = Record<string, string>;

// Note: 20 requests per 200ms window ensures a more even distribution,
// compared to 100 requests per 1000ms window. Both satisfy the constraint
// of 100 requests per 1000ms, but a shorter window reduces the likelihood
// of traffic bursts.
const windowDurationMs = 200;
const maxStartsPerWindow = 20;
const dbAccessLimiter = new FixedWindowRateLimiter<UserInfo>(
  windowDurationMs,
  maxStartsPerWindow
);

app.get('/user/', async (req, res) => {
  // Define the sub-prodecure.
  const fetchUserInfo: RateLimiterTask<UserInfo> = async (): Promise<UserInfo> => {
    // The database service imposes throttling limits,
    // which are managed by the rate limiter.
    const userInfo: UserInfo = await usersDbClient.get(req.userID);
    return userInfo;
  }

  // Execute the sub-procedure in a controlled manner.
  try {
    const userInfo = await dbAccessLimiter.waitForCompletion(fetchUserInfo);
    res.status(HTTP_OK_CODE).send(userInfo);
  } catch (err) {
    // err was thrown by the fetchUserInfo job.
    logger.error(`Failed fetching user info for userID ${req.userID} with error: ${err.message}`);
    res.status(HTTP_ERROR_CODE);
  }
});
```

## Graceful Termination :hourglass:<a id="graceful-termination"></a>

The `waitForAllExecutingTasksToComplete` method is essential for scenarios where it is necessary to wait for all ongoing tasks to finish, such as logging a success message or executing subsequent logic.

A key use case for this method is ensuring stable unit tests. Each test should start with a clean state, independent of others, to avoid interference. This prevents scenarios where a task from Test A inadvertently continues to execute during Test B.

If your component has a termination method (`stop`, `terminate`, or similar), keep that in mind.

## Error Handling for Background Tasks :warning:<a id="error-handling"></a>

Background tasks triggered by `startExecution` may throw errors. Unlike the `waitForCompletion` case, the caller has no reference to the corresponding task promise which executes in the background.

Therefore, errors from background tasks are captured by the rate-limiter and can be extracted using the `extractUncaughtErrors` method. Optionally, you can specify a custom `UncaughtErrorType` as the second generic parameter of the `FixedWindowRateLimiter` class. By default, the error type is `Error`.
```ts
const trafficAnalyzerLimiter = 
  new FixedWindowRateLimiter<void, TrafficAnalyzerError>(
    // ...
  );
```
The number of accumulated uncaught errors can be obtained via the `amountOfUncaughtErrors` getter method. This can be useful, for example, if the user wants to handle uncaught errors only after a certain threshold is reached.

Even if the user does not intend to perform error-handling with these uncaught errors, it is **important** to periodically call this method when using `startExecution` to prevent the accumulation of errors in memory.
However, there are a few exceptional cases where the user can safely avoid extracting uncaught errors:
- The number of tasks is relatively small and the process is short-lived.
- The tasks never throw errors, thus no uncaught errors are possible.

## Unavoidable / Implicit Backpressure<a id="unavoidable-backpressure"></a>

Mitigating backpressure is primarily associated with the `startExecution` method, particularly in scenarios involving multiple tasks. However, the single-task use case may certainly inflict backpressure on the Node.js micro-tasks queue.

For instance, consider a situation where 1K concurrently executing route handlers are each awaiting the completion of their own `waitForCompletion` execution, while the rate-limiter is unavailable. In such cases, all handlers will internally wait on the rate-limiter's `_waitForWindowToEnd` private property, competing to acquire an available window.

## Naming Convention :memo:<a id="naming-convention"></a>

To improve readability and maintainability, it is highly recommended to assign a use-case-specific name to your rate-limiter instances. This practice helps in clearly identifying the purpose of each rate-limiter in the codebase. Examples include:
- dbAccessLimiter
- tokenGenerationLimiter
- azureStorageLimiter

## License :scroll:<a id="license"></a>

[Apache 2.0](LICENSE)
