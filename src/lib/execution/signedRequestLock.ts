export class SignedRequestLock {
  private static chain: Promise<unknown> = Promise.resolve();

  static run<T>(task: () => Promise<T>): Promise<T> {
    const runTask = SignedRequestLock.chain.then(task, task);
    SignedRequestLock.chain = runTask.then(
      () => undefined,
      () => undefined,
    );
    return runTask;
  }
}

