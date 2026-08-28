import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useNavigation } from "../hooks/useNavigation";
import type { NavigationActions } from "../lib/navigation";
import { NavigationProvider } from "./NavigationProvider";

function navigationFixture(openPrs: () => void): NavigationActions {
  return {
    goBack() {},
    openNextChat() {},
    openPrs,
    openFeed() {},
    openSettings() {},
    openTasks() {},
    openAutomation() {},
    async openPrItem() {},
    openPlain() {},
    openSupportTinder() {},
    openReports() {},
    openAnalytics() {},
    openArchived() {},
    openCatchUp() {},
    openSession() {},
    openWorkspace() {},
    openSessionReview() {},
    async openTicket() {},
    async openFeedItem() {},
    openPr() {},
    openNewWorkspace() {},
    openNewSessionInRepo() {},
    openDraft() {},
    async openNewSessionInWorkspace() {},
    startNewChat() {},
    openPrefilledSession() {},
    openReview() {},
    openStaging() {},
    openPreview() {},
    openPortal() {},
    openAssets() {},
    openTerminal() {},
    openCurrentWorkspace() {},
  };
}

function OpenPrsConsumer() {
  useNavigation().openPrs();
  return <span>Opened</span>;
}

function ConsumerWithoutProvider() {
  useNavigation();
  return null;
}

describe("NavigationProvider", () => {
  test("forwards actions to children", () => {
    let calls = 0;
    const actions = navigationFixture(() => {
      calls += 1;
    });

    expect(
      renderToStaticMarkup(
        <NavigationProvider actions={actions}>
          <OpenPrsConsumer />
        </NavigationProvider>,
      ),
    ).toBe("<span>Opened</span>");
    expect(calls).toBe(1);
  });

  test("fails closed outside the provider", () => {
    expect(() => renderToStaticMarkup(<ConsumerWithoutProvider />)).toThrow(
      "useNavigation must be used within NavigationProvider",
    );
  });
});
