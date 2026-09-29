const { assertContinuityLease, continuityFailure } = require("./continuity-lease.cjs");

function releaseRetainedConversation(host, conversationKey, expected) {
  const retained = [...host.turnTabs.values()].filter((tab) => (
    tab.status === "ready" && tab.conversationKey === conversationKey
  ));
  if (expected && retained.length !== 1) throw continuityFailure();
  for (const tab of retained) {
    if (tab.continuityOwner || expected) assertContinuityLease(tab, expected);
  }
  for (const tab of retained) {
    host.removeTurnTab(tab, false);
    host.logger.info("browser.tab_released", {
      tabId: tab.id,
      traceId: tab.traceId,
      status: tab.status,
      reason: "retained_conversation_superseded",
    });
  }
  return retained.length;
}

module.exports = { releaseRetainedConversation };
