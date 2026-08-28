import React, { useLayoutEffect, useRef, useState } from "react";
import { NavigationContext } from "../hooks/useNavigation";
import type { NavigationActions } from "../lib/navigation";

export function NavigationProvider({
  actions,
  children,
}: {
  actions: NavigationActions;
  children: React.ReactNode;
}): React.ReactElement {
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });
  const [stableActions] = useState<NavigationActions>(() => ({
    goBack: () => actionsRef.current.goBack(),
    openNextChat: () => actionsRef.current.openNextChat(),
    openPrs: () => actionsRef.current.openPrs(),
    openFeed: () => actionsRef.current.openFeed(),
    openSettings: (...args) => actionsRef.current.openSettings(...args),
    openTasks: () => actionsRef.current.openTasks(),
    openAutomation: (...args) => actionsRef.current.openAutomation(...args),
    openPrItem: (...args) => actionsRef.current.openPrItem(...args),
    openPlain: () => actionsRef.current.openPlain(),
    openSupportTinder: () => actionsRef.current.openSupportTinder(),
    openReports: (...args) => actionsRef.current.openReports(...args),
    openAnalytics: () => actionsRef.current.openAnalytics(),
    openArchived: () => actionsRef.current.openArchived(),
    openCatchUp: () => actionsRef.current.openCatchUp(),
    openSession: (...args) => actionsRef.current.openSession(...args),
    openWorkspace: (...args) => actionsRef.current.openWorkspace(...args),
    openSessionReview: (...args) =>
      actionsRef.current.openSessionReview(...args),
    openTicket: (...args) => actionsRef.current.openTicket(...args),
    openFeedItem: (...args) => actionsRef.current.openFeedItem(...args),
    openPr: (...args) => actionsRef.current.openPr(...args),
    openNewWorkspace: () => actionsRef.current.openNewWorkspace(),
    openNewSessionInRepo: (...args) =>
      actionsRef.current.openNewSessionInRepo(...args),
    openDraft: () => actionsRef.current.openDraft(),
    openNewSessionInWorkspace: (...args) =>
      actionsRef.current.openNewSessionInWorkspace(...args),
    startNewChat: (...args) => actionsRef.current.startNewChat(...args),
    openPrefilledSession: (...args) =>
      actionsRef.current.openPrefilledSession(...args),
    openReview: () => actionsRef.current.openReview(),
    openStaging: () => actionsRef.current.openStaging(),
    openPreview: () => actionsRef.current.openPreview(),
    openPortal: (...args) => actionsRef.current.openPortal(...args),
    openAssets: () => actionsRef.current.openAssets(),
    openTerminal: () => actionsRef.current.openTerminal(),
    openCurrentWorkspace: () => actionsRef.current.openCurrentWorkspace(),
  }));

  return (
    <NavigationContext value={stableActions}>{children}</NavigationContext>
  );
}
