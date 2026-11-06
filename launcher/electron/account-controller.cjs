/** The process owns one account. A transition closes local actions before draining the API. */
function createAccountController({
  store, context, getRuntimeHost, getSupervisor, getBrowserHost,
  confirmSwitch, confirmRemoval, clearBrowserStorage, restart,
  beforeRestart = async () => {}, restoreAfterFailure = async () => {}, beforeTransition = async () => {}, publish = () => {},
}) {
  let transitioning = false;
  let activeActions = 0;
  const busy = () => new Error("Finish the current task, login, or launcher operation before changing accounts.");
  const snapshot = () => store.snapshot();
  const publishSnapshot = () => { const value = snapshot(); publish(value); return value; };
  const assertAvailable = () => {
    if (transitioning) throw new Error("Account change is in progress. Retry after Launcher restarts.");
  };
  async function runAction(action) {
    assertAvailable();
    activeActions++;
    try { return await action(); }
    finally { activeActions--; }
  }
  async function exclusive(name, action) {
    assertAvailable();
    if (activeActions > 0) throw busy();
    transitioning = true;
    const browser = getBrowserHost();
    const admissionWasClosed = browser?.accountAdmissionClosed === true;
    const supervisor = getSupervisor();
    let stopped = false;
    let restarting = false;
    let restored = true;
    try {
      const host = getRuntimeHost();
      if (host?.currentOperation() || browser?.currentOperation()) throw busy();
      const perform = async () => {
        browser?.closeAccountAdmission();
        if (supervisor) {
          const result = await supervisor.stopForAccountSwitch();
          if (result?.status !== "stopped") throw new Error("Cannot confirm that the account runtime has stopped.");
          stopped = true;
        }
        return action({ browser, markRestarting: () => { restarting = true; } });
      };
      return host ? await host.runLifecycleOperation(name, perform) : await perform();
    } finally {
      if (!restarting) {
        try {
          const stillEnabled = !context || snapshot().accounts.some(account => account.id === context.id && account.status === "active");
          if (stopped && stillEnabled) {
            restored = false;
            await restoreAfterFailure();
            await supervisor.startIfConfigured();
            restored = true;
          }
        } finally {
          if (restored && !admissionWasClosed && (!context || snapshot().accounts.some(account => account.id === context.id && account.status === "active"))) browser?.resumeAccountAdmission();
          transitioning = false;
          publishSnapshot();
        }
      }
    }
  }
  return {
    snapshot, runAction, assertAvailable,
    add(input) {
      assertAvailable();
      const account = store.add(input);
      publishSnapshot();
      return account;
    },
    rename(id, name) {
      assertAvailable();
      store.rename(id, name);
      return publishSnapshot();
    },
    async switchAccount(id) {
      await beforeTransition();
      assertAvailable();
      const target = store.context(id);
      if (!target) throw new Error("The selected account is unavailable.");
      if (context?.id === id && snapshot().currentId === id) return { restarting: false };
      if (!await confirmSwitch(target)) return { cancelled: true };
      return exclusive("account-switch", async ({ browser, markRestarting }) => {
        await browser?.persistSession();
        store.setPending(id);
        try {
          await beforeRestart();
          await restart();
          markRestarting();
          return { restarting: true };
        } catch (error) {
          store.cancelPending();
          throw error;
        }
      });
    },
    async remove(id) {
      await beforeTransition();
      assertAvailable();
      // context() intentionally refuses records that already have a removal marker.
      const account = snapshot().accounts.find(item => item.id === id);
      if (!account) throw new Error("The selected account no longer exists.");
      if (context?.id === id && snapshot().accounts.some(item => item.id !== id && item.status === "active")) {
        throw new Error("Switch to another account before removing the current account.");
      }
      if (!await confirmRemoval(account)) return { cancelled: true };
      return exclusive("account-remove", async ({ browser, markRestarting }) => {
        const removingCurrent = context?.id === id;
        if (removingCurrent) await browser?.persistSession();
        store.beginRemoval(id);
        publishSnapshot();
        // A failed cleanup stays disabled and can be retried from the same management page.
        if (removingCurrent) browser?.destroy();
        try {
          await store.remove(id, { clearBrowserStorage });
        } finally {
          if (removingCurrent) {
            await beforeRestart();
            await restart();
            markRestarting();
          }
        }
        return removingCurrent ? { restarting: true } : { removed: true };
      });
    },
  };
}

function registerAccountIpc({ ipcMain, controller, trusted }) {
  const methods = {
    "launcher:accounts": () => controller.snapshot(),
    "launcher:account-add": input => controller.add(input),
    "launcher:account-rename": (id, name) => controller.rename(id, name),
    "launcher:account-switch": id => controller.switchAccount(id),
    "launcher:account-remove": id => controller.remove(id),
  };
  for (const [channel, method] of Object.entries(methods)) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error("Account management is only available in the Launcher window.");
      return method(...args);
    });
  }
}

module.exports = { createAccountController, registerAccountIpc };
