declare function acquireModelCatalogCommandLock(
  markerPath: string,
  options?: { retryMs?: number; timeoutMs?: number },
): Promise<() => void>;

declare function processStartIdentity(pid: number): string | null;

declare const modelCatalogCommandLock: {
  acquireModelCatalogCommandLock: typeof acquireModelCatalogCommandLock;
  processStartIdentity: typeof processStartIdentity;
};

export = modelCatalogCommandLock;
