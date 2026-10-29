import { describe, expect, test } from "bun:test";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import {
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LEGACY_MODEL_ROUTES,
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
  CHATGPT_WEB_MODEL_ROUTES,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
  resolveChatGptWebHistoryLimits,
  resolveChatGptWebTransportLimits,
  resolveChatGptWebMessageTokenBudget,
  chatGptWebRouteEfforts,
  type ChatGptWebBackendModel,
  type ChatGptWebModelFamily,
} from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { routeChatGptWebRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

function parsed(modelId: string, reasoning = "medium"): CodexParsedRequest {
  return {
    modelId,
    context: { messages: [] },
    stream: false,
    options: { reasoning },
    _rawBody: { model: modelId, reasoning: { effort: reasoning } },
  };
}

describe("fixed ChatGPT Web model routes", () => {
  const plus = { solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const pro = { solAvailable: true, extraHighAvailable: true, proAvailable: true };

  test("reserves both Web namespaces and rejects continuity in incompatible environments", () => {
    expect(isChatGptWebModelSlug("chatgpt-web-continuity/gpt-5.6-sol")).toBe(true);
    expect(isChatGptWebModelSlug("chatgpt-web-continuity/unknown")).toBe(true);
    expect(isChatGptWebModelSlug("chatgpt-web/gpt-5.6-sol")).toBe(true);
    expect(isChatGptWebModelSlug("chatgpt-web-continuity-other/model")).toBe(false);
    expect(isChatGptWebModelSlug("gpt-5.6-sol")).toBe(false);
    expect(availableChatGptWebModelRoutes(pro).some(route => route.slug.startsWith("chatgpt-web-continuity/")))
      .toBe(false);
    expect(() => requireChatGptWebModelRoute("chatgpt-web-continuity/gpt-5.6-sol", pro)).toThrow();
    expect(() => requireChatGptWebModelRoute("chatgpt-web-continuity/unknown", pro)).toThrow();
  });

  test("keeps the published legacy bindings while advertising named families", () => {
    expect(new Set(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug)).size).toBe(CHATGPT_WEB_MODEL_ROUTES.length);
    expect(CHATGPT_WEB_LEGACY_MODEL_ROUTES.map(route => [route.slug, route.codexEffort, route.adapterEffort])).toEqual([
      ["chatgpt-web/light", "low", "low"],
      ["chatgpt-web/medium", "medium", "medium"],
      ["chatgpt-web/high", "high", "high"],
      ["chatgpt-web/extra-high", "xhigh", "xhigh"],
      ["chatgpt-web/pro", "ultra", "max"],
    ]);
    expect(CHATGPT_WEB_MODEL_ROUTES.map(route => route.displayName)).toEqual([
      "GPT-6 Sol Instant (Web)", "GPT-6 Sol (Web)",
      "GPT-5.6 Sol Instant (Web)", "GPT-5.6 Sol (Web)", "GPT-5.6 Pro (Web)", "GPT-6 Pro (Web)",
    ]);
    expect(CHATGPT_WEB_LUNA_MODEL_ROUTE.displayName).toBe("Luna (Web)");
    expect(CHATGPT_WEB_LUNA_BACKEND_MODEL).toBe("gpt-5.6-luna");
    expect(CHATGPT_WEB_LUNA_MODEL_ROUTE.backendModel).toBe("gpt-5.6-luna");
  });

  test("all supported Full Launcher routes use one task policy and preserve account gates", () => {
    const config = { ...defaultConfig("full"), ...plus, browserHost: "launcher" as const };
    const routes = availableChatGptWebModelRoutes(config);
    expect(routes.map(route => route.slug)).toEqual([
      "chatgpt-web/gpt-6-sol-instant", "chatgpt-web/gpt-6-sol",
      "chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol",
    ]);
    expect(routes.every(route => route.conversationPolicy === "task")).toBe(true);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/gpt-5.6-pro", config)).toThrow("not available");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/gpt-5.6-sol", config, "xhigh")).toThrow("does not support effort");
    for (const conflict of [{ mode: "browser-only" as const }, { browserHost: "managed-chrome" as const }]) {
      expect(availableChatGptWebModelRoutes({ ...config, ...conflict }).some(route => route.conversationPolicy === "task")).toBe(false);
    }
    expect(availableChatGptWebModelRoutes({ ...config, experimentalFreshConversationPerTurn: true })
      .every(route => route.conversationPolicy === "task")).toBe(true);
    const manual = { ...config, browserInteractionMode: "manual" as const, solAvailable: false };
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk", manual)).toMatchObject({ backendModel: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, conversationPolicy: "task" });
    expect(() => requireChatGptWebModelRoute("chatgpt-web/zero-risk-pro", manual)).toThrow("not enabled in Zero Risk model settings");
    const manualPro = { ...manual, zeroRiskProEnabled: true };
    expect(availableChatGptWebModelRoutes(manualPro).map(route => route.slug)).toEqual(["chatgpt-web/zero-risk", "chatgpt-web/zero-risk-pro"]);
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk-pro", manualPro)).toMatchObject({ backendModel: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, conversationPolicy: "task" });
  });

  test("trusted ordinary routing selects task continuity and ignores caller policy", () => {
    const config = { ...defaultConfig("full"), ...plus, browserHost: "launcher" as const };
    const request = parsed("chatgpt-web/gpt-5.6-sol", "medium");
    const route = routeChatGptWebRequest(request, config);
    expect(request._conversationPolicy).toBe("task");
    expect(request.modelId).toBe(CHATGPT_WEB_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("medium");
    expect(resolveChatGptWebHistoryLimits(route, config)).toEqual({
      contextWindow: 600_000, autoCompactTokenLimit: 540_000, effectiveContextWindowPercent: 90,
    });
    expect(resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config).contextWindow).toBe(600_000);
    expect(resolveChatGptWebTransportLimits(route.backendModel, route.adapterEffort, config).browserComposerCharLimit).toBe(500_000);
    const ordinary = parsed("chatgpt-web/gpt-5.6-sol", "medium");
    ordinary._conversationPolicy = "task";
    ordinary._rawBody = { metadata: { conversationPolicy: "task" }, _conversationPolicy: "task" };
    const ordinaryRoute = routeChatGptWebRequest(ordinary, { ...config, mode: "browser-only" });
    expect(ordinary).toMatchObject({ _conversationPolicy: "recoverable" });
    expect(resolveChatGptWebHistoryLimits(ordinaryRoute, { ...config, mode: "browser-only" }).contextWindow).toBe(600_000);
  });

  test("GPT-6 task routes use account history tiers and preserve one-message boundaries", () => {
    const config = { ...defaultConfig("full"), ...pro, browserHost: "launcher" as const };
    for (const [suffix, effort, historyWindow, messageTokens] of [
      ["sol-instant", "low", 400_000, 103_000],
      ["sol", "medium", 600_000, 103_000],
      ["sol", "high", 600_000, 103_000],
      ["sol", "xhigh", 600_000, 103_000],
      ["pro", "max", 800_000, 104_000],
    ] as const) {
      const request = parsed(`chatgpt-web/gpt-6-${suffix}`, effort);
      const route = routeChatGptWebRequest(request, config);
      expect(request).toMatchObject({ _conversationPolicy: "task", _chatgptModelFamily: "6" });
      expect(resolveChatGptWebHistoryLimits(route, config)).toEqual({
        contextWindow: historyWindow, autoCompactTokenLimit: historyWindow * 0.9, effectiveContextWindowPercent: 90,
      });
      expect(resolveChatGptWebMessageTokenBudget(route.backendModel, route.adapterEffort, config)).toBe(messageTokens);
      expect(resolveChatGptWebTransportLimits(route.backendModel, route.adapterEffort, config).browserMessageTokenLimit)
        .toBe(messageTokens);
    }
  });

  test("all available routes use the explicit history matrix across hosts and policies", () => {
    const expected: Record<string, readonly [number, number]> = {
      "chatgpt-web/gpt-6-sol-instant": [300_000, 400_000],
      "chatgpt-web/gpt-6-sol": [400_000, 600_000],
      "chatgpt-web/gpt-5.6-sol-instant": [400_000, 800_000],
      "chatgpt-web/gpt-5.6-sol": [600_000, 800_000],
      "chatgpt-web/gpt-5.6-pro": [800_000, 800_000],
      "chatgpt-web/gpt-6-pro": [800_000, 800_000],
      "chatgpt-web/light": [400_000, 800_000],
      "chatgpt-web/medium": [600_000, 800_000],
      "chatgpt-web/high": [600_000, 800_000],
      "chatgpt-web/extra-high": [600_000, 800_000],
      "chatgpt-web/pro": [800_000, 800_000],
      "chatgpt-web/gpt-5.6-luna": [300_000, 300_000],
      "chatgpt-web/luna": [300_000, 300_000],
      "chatgpt-web/think": [300_000, 300_000],
      "chatgpt-web/zero-risk": [400_000, 400_000],
      "chatgpt-web/zero-risk-pro": [800_000, 800_000],
    };
    for (const mode of ["full", "browser-only"] as const)
      for (const browserHost of ["launcher", "managed-chrome"] as const)
        for (const browserInteractionMode of ["automatic", "manual"] as const)
          for (const solAvailable of [false, true])
            for (const proAvailable of [false, true])
              for (const extraHighAvailable of [false, true])
                for (const zeroRiskProEnabled of [false, true]) {
                  const config = { ...defaultConfig(mode), browserHost, browserInteractionMode,
                    solAvailable, proAvailable, extraHighAvailable, zeroRiskProEnabled };
                  for (const advertised of availableChatGptWebModelRoutes(config, true)) {
                    for (const effort of chatGptWebRouteEfforts(advertised, config)) {
                      const route = requireChatGptWebModelRoute(advertised.slug, config, effort);
                      const contextWindow = expected[route.slug]![proAvailable ? 1 : 0];
                      const limits = { contextWindow, autoCompactTokenLimit: contextWindow * 0.9,
                        effectiveContextWindowPercent: 90 };
                      expect(resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config,
                        route.interactionMode === "automatic" ? route.modelFamily : undefined)).toEqual(limits);
                      for (const conversationPolicy of ["task", "recoverable"] as const) {
                        expect(resolveChatGptWebHistoryLimits({ ...route, conversationPolicy }, config)).toEqual(limits);
                      }
                    }
                  }
                }
  });

  test("exposes only Plus-eligible routes without the Pro account capability", () => {
    expect(availableChatGptWebModelRoutes(plus).map(route => route.slug)).toEqual([
      "chatgpt-web/gpt-6-sol-instant",
      "chatgpt-web/gpt-6-sol",
      "chatgpt-web/gpt-5.6-sol-instant",
      "chatgpt-web/gpt-5.6-sol",
    ]);
    expect(availableChatGptWebModelRoutes({ solAvailable: true, extraHighAvailable: true, proAvailable: true }))
      .toEqual(CHATGPT_WEB_MODEL_ROUTES);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/extra-high", plus))
      .toThrow("Extra High is not available for this account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/pro", plus))
      .toThrow("Pro is not available for this account");
  });

  test("Extra High stays routable without granting Pro or Pro-sized context", () => {
    const config = { ...defaultConfig("full"), extraHighAvailable: true, proAvailable: false };
    expect(availableChatGptWebModelRoutes(config).map(route => route.slug))
      .toEqual(["chatgpt-web/gpt-6-sol-instant", "chatgpt-web/gpt-6-sol", "chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol"]);
    const request = parsed("chatgpt-web/extra-high", "low");
    expect(routeChatGptWebRequest(request, config).adapterEffort).toBe("xhigh");
    expect(request.options.reasoning).toBe("xhigh");
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", config))
      .toEqual(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", config));
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", config))
      .toEqual(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "high", config));
    expect(() => requireChatGptWebModelRoute("chatgpt-web/pro", config)).toThrow("not available");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/extra-high", { ...config, extraHighAvailable: undefined }))
      .toThrow("not available");
  });

  test("exposes Luna and Think when the authenticated account has no Sol selector", () => {
    const free = { solAvailable: false, extraHighAvailable: false, proAvailable: false };
    expect(availableChatGptWebModelRoutes(free)).toEqual(CHATGPT_WEB_LUNA_MODEL_ROUTES);
    expect(requireChatGptWebModelRoute("chatgpt-web/luna", free).backendModel)
      .toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(requireChatGptWebModelRoute("chatgpt-web/think", free))
      .toBe(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/light", free))
      .toThrow("Luna-only account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/luna", {
      solAvailable: true,
      extraHighAvailable: false, proAvailable: false,
    })).toThrow("only available for Luna-only accounts");
  });

  test("Zero Risk adds the Pro route while retaining the base route", () => {
    const manual = {
      solAvailable: false,
      extraHighAvailable: false, proAvailable: false,
      browserInteractionMode: "manual" as const,
    };
    expect(availableChatGptWebModelRoutes(manual)).toEqual([CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE]);
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk", manual))
      .toBe(CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/zero-risk-pro", manual))
      .toThrow("not enabled in Zero Risk model settings");
    const manualPro = { ...manual, zeroRiskProEnabled: true };
    expect(availableChatGptWebModelRoutes(manualPro)).toEqual([CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE]);
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk", manualPro))
      .toBe(CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE);
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk-pro", manualPro))
      .toBe(CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/luna", manual))
      .toThrow("not available while Zero Risk is enabled");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/zero-risk", plus))
      .toThrow("only available while Zero Risk is enabled");
  });

  test("Zero Risk uses explicit history tiers independently of observed account capabilities", () => {
    for (const solAvailable of [false, true]) for (const proAvailable of [false, true]) {
      const manual = { solAvailable, proAvailable, browserInteractionMode: "manual" as const };
      expect(resolveChatGptWebContextLimits(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", manual)).toEqual({
        contextWindow: 400_000, effectiveContextWindowPercent: 90, autoCompactTokenLimit: 360_000,
      });
      expect(resolveChatGptWebContextLimits(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, "low", manual)).toEqual({
        contextWindow: 800_000, effectiveContextWindowPercent: 90, autoCompactTokenLimit: 720_000,
      });
      expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", manual)).toEqual({});
      expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, "low", manual)).toEqual({});
    }
  });

  test("Plus history tiers preserve independent browser character limits", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      contextWindow: 400_000, effectiveContextWindowPercent: 90, autoCompactTokenLimit: 360_000,
    });
    for (const effort of ["medium", "high"] as const) {
      expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, effort, plus)).toEqual({
        contextWindow: 600_000, effectiveContextWindowPercent: 90, autoCompactTokenLimit: 540_000,
      });
    }
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      browserComposerCharLimit: 211_256,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus)).toEqual({
      browserComposerCharLimit: 500_000,
    });
    expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", plus))
      .toThrow("unavailable effort");
  });

  test("Pro history tiers preserve independent browser token and character limits", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, effort, pro)).toEqual({
        contextWindow: 800_000, effectiveContextWindowPercent: 90, autoCompactTokenLimit: 720_000,
      });
    }
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "low", pro)).toEqual({
      browserMessageTokenLimit: 103_000, browserComposerCharLimit: 545_000,
    });
    for (const effort of ["medium", "high", "xhigh"] as const) {
      expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, pro)).toEqual({
        browserMessageTokenLimit: 103_000, browserComposerCharLimit: 500_000,
      });
    }
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "max", pro)).toEqual({
      browserMessageTokenLimit: 104_000, browserComposerCharLimit: 1_635_000,
    });
  });

  test("unavailable backends, efforts, interactions and unknown families cannot obtain history tiers", () => {
    for (const resolve of [resolveChatGptWebContextLimits, resolveChatGptWebMessageTokenBudget,
      resolveChatGptWebTransportLimits]) {
      expect(() => resolve(CHATGPT_WEB_BACKEND_MODEL, "max", plus)).toThrow("unavailable effort");
      expect(() => resolve(CHATGPT_WEB_BACKEND_MODEL, "xhigh", { ...pro, extraHighAvailable: false }))
        .toThrow("unavailable effort");
      expect(() => resolve(CHATGPT_WEB_BACKEND_MODEL, "low", { ...plus, solAvailable: false }))
        .toThrow("Luna-only account");
      expect(() => resolve(CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", plus)).toThrow("Luna-only accounts");
      expect(() => resolve(CHATGPT_WEB_LUNA_BACKEND_MODEL, "high", { ...plus, solAvailable: false }))
        .toThrow("unavailable effort");
      expect(() => resolve(CHATGPT_WEB_BACKEND_MODEL, "medium", { ...plus, browserInteractionMode: "manual" }))
        .toThrow("Zero Risk");
      expect(() => resolve(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "medium", plus)).toThrow("technical low");
      expect(() => resolve(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", { ...plus, browserInteractionMode: "automatic" }))
        .toThrow("manual interaction");
      expect(() => resolve("unknown" as ChatGptWebBackendModel, "low", pro)).toThrow("not defined");
    }
    expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus,
      "future" as ChatGptWebModelFamily)).toThrow("model family");
  });

  test("Luna and Think use the same 300k history tier and 28k input contract", () => {
    for (const proAvailable of [false, true]) for (const extraHighAvailable of [false, true]) {
      const capabilities = { solAvailable: false, proAvailable, extraHighAvailable };
      for (const effort of ["low", "medium"] as const) {
        expect(resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, effort, capabilities)).toEqual({
          contextWindow: 300_000, effectiveContextWindowPercent: 90, autoCompactTokenLimit: 270_000,
        });
        expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, effort, capabilities))
          .toEqual({ browserMessageTokenLimit: 19_808 });
      }
    }
  });

  test("single-message text budgets retain the old inclusive boundaries and image deductions", () => {
    const manual = { ...plus, browserInteractionMode: "manual" as const };
    const rows = [
      [CHATGPT_WEB_BACKEND_MODEL, "low", plus, 32_807],
      [CHATGPT_WEB_BACKEND_MODEL, "medium", plus, 81_807],
      [CHATGPT_WEB_BACKEND_MODEL, "high", plus, 81_807],
      [CHATGPT_WEB_BACKEND_MODEL, "xhigh", { ...plus, extraHighAvailable: true }, 81_807],
      [CHATGPT_WEB_BACKEND_MODEL, "low", pro, 103_000],
      [CHATGPT_WEB_BACKEND_MODEL, "medium", pro, 103_000],
      [CHATGPT_WEB_BACKEND_MODEL, "high", pro, 103_000],
      [CHATGPT_WEB_BACKEND_MODEL, "xhigh", pro, 103_000],
      [CHATGPT_WEB_BACKEND_MODEL, "max", pro, 104_000],
      [CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", { ...plus, solAvailable: false }, 19_808],
      [CHATGPT_WEB_LUNA_BACKEND_MODEL, "medium", { ...plus, solAvailable: false }, 19_808],
      [CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", manual, 114_807],
      [CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, "low", manual, 328_386],
    ] as const;
    for (const [backend, effort, capabilities, expected] of rows) {
      const budget = (images: number) => resolveChatGptWebMessageTokenBudget(backend, effort, capabilities, images);
      expect(budget(0)).toBe(expected);
      expect(budget(4_096)).toBe(expected - 4_096);
      expect(budget(8_192)).toBe(expected - 8_192);
      expect(budget(expected - 1)).toBe(1);
      expect(budget(expected)).toBe(0);
      expect(budget(expected + 1)).toBe(0);
      for (const mode of ["full", "browser-only"] as const)
        for (const browserHost of ["launcher", "managed-chrome"] as const) {
          expect(resolveChatGptWebMessageTokenBudget(backend, effort, { ...capabilities, mode, browserHost }))
            .toBe(expected);
        }
    }
  });

  test("legacy aliases keep the same history and message policies as their named routes", () => {
    for (const capabilities of [plus, pro]) {
      for (const [alias, canonical, effort] of [
        ["light", "gpt-5.6-sol-instant", "low"],
        ["medium", "gpt-5.6-sol", "medium"],
        ["high", "gpt-5.6-sol", "high"],
        ["extra-high", "gpt-5.6-sol", "xhigh"],
        ["pro", "gpt-5.6-pro", "max"],
      ] as const) {
        if (effort === "xhigh" && !capabilities.extraHighAvailable) continue;
        if (effort === "max" && !capabilities.proAvailable) continue;
        const old = requireChatGptWebModelRoute(`chatgpt-web/${alias}`, capabilities);
        const named = requireChatGptWebModelRoute(`chatgpt-web/${canonical}`, capabilities, effort);
        expect(resolveChatGptWebHistoryLimits(old, capabilities)).toEqual(resolveChatGptWebHistoryLimits(named, capabilities));
        expect(resolveChatGptWebMessageTokenBudget(old.backendModel, old.adapterEffort, capabilities))
          .toBe(resolveChatGptWebMessageTokenBudget(named.backendModel, named.adapterEffort, capabilities));
      }
    }
  });

  test("binds the selected model authoritatively and ignores a conflicting request effort", () => {
    const request = parsed("chatgpt-web/high", "low");
    const rawSnapshot = structuredClone(request._rawBody);
    const route = routeChatGptWebRequest(request, defaultConfig("browser-only"));

    expect(route.slug).toBe("chatgpt-web/high");
    expect(request.modelId).toBe(CHATGPT_WEB_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("high");
    expect(request._rawBody).toEqual(rawSnapshot);
  });

  test("binds the Pro model to the browser Pro effort and fails closed for unknown routes", () => {
    const config = defaultConfig("full");
    config.extraHighAvailable = true;
    config.proAvailable = true;
    const request = parsed("chatgpt-web/pro", "low");
    expect(routeChatGptWebRequest(request, config).adapterEffort).toBe("max");
    expect(request.options.reasoning).toBe("max");
    expect(() => routeChatGptWebRequest(parsed("chatgpt-web/not-enabled"), config))
      .toThrow("model is not enabled");
  });

  test("keeps Pro compaction on the same retained Pro conversation", () => {
    const config = defaultConfig("full");
    config.extraHighAvailable = true;
    config.proAvailable = true;
    const normal = parsed("chatgpt-web/pro", "low");
    const compact = parsed("chatgpt-web/pro", "low");
    const metadata = {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_pro_compaction" }),
    };
    normal._rawBody = {
      model: "chatgpt-web/pro",
      reasoning: { effort: "low" },
      client_metadata: metadata,
    };
    compact._rawBody = structuredClone(normal._rawBody);
    compact._compactionRequest = true;

    expect(routeChatGptWebRequest(normal, config).slug).toBe("chatgpt-web/pro");
    expect(normal.options.reasoning).toBe("max");
    expect(routeChatGptWebRequest(compact, config).slug).toBe("chatgpt-web/pro");
    expect(compact.options.reasoning).toBe("max");
    expect(chatGptConversationKey(compact, "provider"))
      .toBe(chatGptConversationKey(normal, "provider"));
  });

  test("binds the Luna route to Luna without a selectable effort", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = false;
    const request = parsed("chatgpt-web/luna", "high");
    const route = routeChatGptWebRequest(request, config);
    expect(route).toBe(CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("low");
  });

  test("binds the Think route to the Luna backend with explicit Think mode", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = false;
    const request = parsed("chatgpt-web/think", "high");
    const route = routeChatGptWebRequest(request, config);
    expect(route).toBe(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("medium");
  });

  test("Zero Risk routing preserves its internal backend identity and only a technical Codex effort", () => {
    const config = defaultConfig("full");
    config.browserInteractionMode = "manual";
    const request = parsed("chatgpt-web/zero-risk", "ultra");
    const route = routeChatGptWebRequest(request, config);

    expect(route).toBe(CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("low");

    config.zeroRiskProEnabled = true;
    const proRequest = parsed("chatgpt-web/zero-risk-pro", "ultra");
    const proRoute = routeChatGptWebRequest(proRequest, config);
    expect(proRoute).toBe(CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE);
    expect(proRequest.modelId).toBe(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL);
    expect(proRequest.options.reasoning).toBe("low");
  });

  test("new families honor effort, gate availability, and separate pinned retained conversations", () => {
    const config = { ...defaultConfig("full"), extraHighAvailable: true, proAvailable: true };
    for (const family of ["5.6", "6"] as const) {
      for (const effort of ["medium", "high", "xhigh"] as const) {
        const request = parsed(`chatgpt-web/gpt-${family}-sol`, effort);
        routeChatGptWebRequest(request, config);
        expect(request.options.reasoning).toBe(effort);
        expect(request._chatgptModelFamily).toBe(family);
      }
      const instant = parsed(`chatgpt-web/gpt-${family}-sol-instant`, "low");
      routeChatGptWebRequest(instant, config);
      expect(instant._chatgptModelFamily).toBe(family);
      expect(instant.options.reasoning).toBe("low");
      for (const effort of ["low", "max", "ultra", "invented"]) {
        expect(() => routeChatGptWebRequest(parsed(`chatgpt-web/gpt-${family}-sol`, effort), config)).toThrow("does not support effort");
      }
      expect(() => routeChatGptWebRequest(parsed(`chatgpt-web/gpt-${family}-sol`, "xhigh"), {
        ...config, extraHighAvailable: false,
      })).toThrow("does not support effort");
    }
    const luna = parsed("chatgpt-web/gpt-5.6-luna", "medium");
    routeChatGptWebRequest(luna, { ...config, solAvailable: false });
    expect(luna.options.reasoning).toBe("medium");
    const keys: string[] = [];
    for (const [model, family] of [["chatgpt-web/gpt-5.6-pro", "5.6"], ["chatgpt-web/gpt-6-pro", "6"], ["chatgpt-web/pro", undefined]] as const) {
      const request: CodexParsedRequest = { ...parsed(model), options: {} };
      request._rawBody = { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "same-thread" }) } };
      routeChatGptWebRequest(request, config);
      expect(request.options.reasoning).toBe("max");
      expect(request._chatgptModelFamily).toBe(family);
      const key = chatGptConversationKey(request, "provider")!;
      keys.push(key);
      expect(chatGptConversationKey({ ...request, _compactionRequest: true }, "provider")).toBe(key);
      expect(() => routeChatGptWebRequest(parsed(model, "max"), { ...config, proAvailable: false })).toThrow("not available");
    }
    expect(new Set(keys).size).toBe(3);
  });
});
