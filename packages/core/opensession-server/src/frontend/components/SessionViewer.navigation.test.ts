import { expect, test } from "bun:test";

const removedNavigationProps = [
  "onBack",
  "onNextChat",
  "onNewSession",
  "onNewWorkspace",
  "onStartNewChat",
  "onOpenSession",
  "onOpenNewSession",
  "onOpenReview",
  "onOpenStaging",
  "onOpenAssets",
  "onOpenTerminal",
  "onOpenPreviewTab",
  "onOpenPr",
  "onOpenPortal",
  "onOpenWorkspace",
];

const availabilityProps = [
  "canOpenNextChat",
  "canStartNewSession",
  "canOpenNewWorkspace",
  "canOpenSession",
  "canOpenReview",
  "canOpenAssets",
  "canOpenPr",
  "canOpenPortal",
  "canOpenWorkspace",
];

const retainedCallbackProps = [
  "onArchive",
  "onArchived",
  "setTyping",
  "onComposerPrefillConsumed",
  "onRename",
  "onRenameWorkspace",
  "onArchiveWorkspace",
  "onDeleteWorkspace",
  "onSetStatus",
  "onRestoreSession",
  "onRunningChange",
  "onReviewChange",
  "onCloseStaging",
  "onCloseAssets",
  "onCloseTerminal",
  "onClosePreviewTab",
  "onOpenSubagent",
  "onSubagentBack",
  "onSubagentLabel",
];

async function sources() {
  const viewer = await Bun.file(
    new URL("./SessionViewer.tsx", import.meta.url),
  ).text();
  const app = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
  return { viewer, app };
}

test("SessionViewer navigation comes from NavigationContext", async () => {
  const { viewer } = await sources();
  const propsStart = viewer.indexOf("interface Props {");
  const propsEnd = viewer.indexOf("\n}\n\n// Stable identity", propsStart);
  expect(propsStart).toBeGreaterThanOrEqual(0);
  expect(propsEnd).toBeGreaterThan(propsStart);
  const props = viewer.slice(propsStart, propsEnd);

  for (const name of removedNavigationProps) {
    expect(props).not.toContain(`${name}:`);
    expect(props).not.toContain(`${name}?:`);
  }
  for (const name of availabilityProps) {
    expect(props).toContain(`${name}?: boolean;`);
  }
  for (const name of retainedCallbackProps) {
    expect(props).toContain(`${name}`);
  }

  expect(viewer).toContain(
    'import { useNavigation } from "../hooks/useNavigation";',
  );
  expect(viewer).toContain("const navigation = useNavigation();");
  expect(viewer).toContain(
    "const openNextChat = canOpenNextChat ? navigation.openNextChat : undefined;",
  );
  expect(viewer).toContain(
    "const openNewSession = canStartNewSession\n    ? navigation.openNewSessionInWorkspace\n    : undefined;",
  );
  expect(viewer).toContain('void openNewSession("share");');
  expect(viewer).toContain(
    "navigation.startNewChat(\n                      session,",
  );
  expect(viewer).toContain(
    "openReview && (prPresentation.primary || prPresentation.additional.length)",
  );
  expect(viewer).toContain("if (!id || !openSession) return;");
  expect(viewer).toContain(
    "onOpenAsTab={openAssets ? promoteAssetToTab : undefined}",
  );
  expect(viewer).toContain(
    "const openCurrentWorkspace = canOpenWorkspace\n    ? navigation.openCurrentWorkspace\n    : undefined;",
  );
  expect(viewer).toContain("onOpenSession={openCurrentWorkspace}");
});

test("App passes only SessionViewer navigation availability", async () => {
  const { app } = await sources();
  const viewerStart = app.indexOf("<SessionViewer\n");
  const viewerEnd = app.indexOf("\n        />", viewerStart);
  expect(viewerStart).toBeGreaterThanOrEqual(0);
  expect(viewerEnd).toBeGreaterThan(viewerStart);
  const viewerInvocation = app.slice(viewerStart, viewerEnd);

  for (const name of removedNavigationProps) {
    expect(viewerInvocation).not.toContain(`${name}=`);
  }
  for (const name of availabilityProps) {
    expect(viewerInvocation).toContain(name);
  }

  expect(viewerInvocation).toContain(
    "canOpenNextChat={focused && nextChatAvailable}",
  );
  expect(viewerInvocation).toContain(
    "canStartNewSession={!viewerSession.desk && !emptyWorkspaceSession}",
  );
});
